import { chromium } from 'playwright'
import { config } from './config.js'
import { BackendClient } from './backendClient.js'
import { parseCredential } from './credential.js'
import { FindingCollector } from './findings.js'
import { logIn } from './login.js'
import { addBreadcrumb, attachMonitors, breakdownFromProbe } from './monitors.js'
import { checkPageMetrics, checkRepeatedRequests, installPerformanceObservers, pageMetrics, summarize } from './performance.js'
import { collectLinks, tagClickables } from './explorer.js'
import { checkHeapSize, checkLeak, openMemoryProbe } from './memory.js'
import { ProbeClient, findingsFromReport } from './probe.js'
import { triage } from './severity.js'
import { pathOf, pathPattern, viewKey } from './text.js'

// Routes that are API endpoints, not pages a user can open.
const API_ROUTE = /^\/(graphql|api|rails|cable|sidekiq)(\/|$)|\.(json|xml)$/i
const ERROR_TEXT = /something went wrong|internal server error|application error|unexpected error|page not found/i

// Logs in as the run's role, then explores the app breadth-first: each page
// is loaded and measured, its safe controls (tabs, toggles, "View"…) are
// clicked one by one, and same-site links are queued. Everything that breaks
// along the way — JS errors, failed or slow requests, GraphQL errors, error
// pages, poor Web Vitals, repeated calls — becomes a finding with evidence.
export async function executeRun(job) {
  const backend = new BackendClient({ callbackUrl: job.callback_url, agentApiToken: config.agentApiToken })
  const auditLogEntries = []
  const log = (actionTaken, targetElement = null) => {
    auditLogEntries.push({ actionTaken, targetElement: targetElement && String(targetElement).slice(0, 1000) })
    console.log(`[run ${job.run_id}] ${actionTaken}${targetElement ? ` — ${targetElement}` : ''}`)
  }

  const findings = new FindingCollector()
  const context = {
    phase: 'login',
    origin: new URL(job.target_url).origin,
    currentUrl: job.target_url,
    trail: [],
    breadcrumbs: [],
    viewRequests: [],
    networkLog: [],
    inflight: new Map(), // open API request -> { label, documentId, startedAt }
    documentId: 0,
    replays: new Map(),
    memory: null,
    stats: { pages: 0, clicks: 0, memorySamples: [], leakChecks: [], isolated: [], views: new Set(), startedAt: new Date() },
    baseSteps: () => [`Log in to ${job.target_url} as the "${job.role_name}" role`],
  }
  const probe = new ProbeClient()

  let browser
  let status = 'completed'
  try {
    log('Run started', `feature "${job.scope_feature.name}" as role "${job.role_name}"`)
    const credential = parseCredential(await backend.resolveRoleCredential(job.credential_fetch_token))

    browser = await chromium.launch({ headless: config.headless, channel: config.browserChannel })
    const browserContext = await browser.newContext({ viewport: { width: 1366, height: 900 } })
    await browserContext.addInitScript(installPerformanceObservers)
    const page = await browserContext.newPage()
    page.setDefaultTimeout(config.navigationTimeoutMs)
    // Links that open new tabs/windows are explored through the queue instead.
    browserContext.on('page', (opened) => opened !== page && opened.close().catch(() => null))
    attachMonitors(page, findings, context, probe)
    context.memory = await openMemoryProbe(page)
    context.stats.browser = `${browser.browserType().name()} ${browser.version()}`
    log('Browser', context.stats.browser)
    log('Backend probe', probe.enabled ? 'enabled (reports read from instrumented backends)' : 'disabled — set QA_PROBE_TOKEN to read SQL/N+1/exception reports')

    await page.goto(job.target_url, { waitUntil: 'networkidle' }).catch(() => null)
    const login = await logIn(page, job.target_url, credential, log)
    context.phase = 'explore'

    if (login.status === 'failed') {
      findings.add({
        title: `Login failed for role "${job.role_name}"`,
        severity: 'high',
        category: 'error',
        reproSteps: [
          `Open ${login.loginUrl}`,
          `Log in with the "${job.role_name}" credential configured in QA Agent`,
          `Observe: ${login.message || 'the login form is still shown after submitting'}`,
        ],
        details: { type: 'login_failed', pageUrl: login.loginUrl, message: login.message, breadcrumbs: context.breadcrumbs },
      })
      await screenshotPending(page, findings)
      status = 'blocked'
      log('Stopping: cannot test without logging in')
      return
    }

    await explore(page, job, context, findings, log)
  } catch (error) {
    status = 'failed'
    log('Run crashed', error.message)
  } finally {
    await probe.settled()
    await remeasureInIsolation(probe, context, findings, log)
    await collectJobReports(probe, context, findings, log)
    await browser?.close().catch(() => null)
    await report(backend, job, findings, status, auditLogEntries, context, probe)
  }
}

async function explore(page, job, context, findings, log) {
  const queue = [page.url()]
  const route = job.scope_feature.route
  if (route && !API_ROUTE.test(route) && !route.includes(':')) {
    queue.unshift(new URL(route, job.target_url).href)
  } else if (route) {
    log('Feature route is an API endpoint, not a page; exploring the whole app instead', route)
  }

  const visited = new Set()
  const clicked = new Set()
  let pages = 0

  while (queue.length > 0 && pages < config.maxPages) {
    const url = queue.shift()
    if (visited.has(url)) continue
    visited.add(url)
    pages += 1

    const loaded = await visitPage(page, url, context, findings, log)
    if (!loaded) continue

    for (const link of await collectLinks(page, context.origin)) {
      if (!visited.has(link) && !queue.includes(link)) queue.push(link)
    }
    await clickThrough(page, url, context, findings, log, clicked, queue)
  }

  context.stats.pages = pages
  log('Exploration finished', `${pages} page(s) loaded, ${clicked.size} control(s) clicked`)
}

// Loads a page fresh and records its load metrics, content and API calls.
async function visitPage(page, url, context, findings, log) {
  context.currentUrl = url
  context.trail = [`Open ${url}`]
  context.viewRequests = []
  addBreadcrumb(context, 'navigation', url)
  log('Opened page', url)

  const response = await page.goto(url, { waitUntil: 'networkidle' }).catch((error) => {
    findings.add({
      fingerprint: `load:${pathOf(url)}`,
      title: `Page did not load: ${pathOf(url)}`,
      severity: 'high',
      category: 'network',
      reproSteps: [...context.baseSteps(), `Open ${url}`, `Observe: the page fails to load (${error.message})`],
      details: { type: 'page_load_failed', pageUrl: url, message: error.message, breadcrumbs: context.breadcrumbs.slice(-15) },
    })
    return null
  })
  if (!response) return false

  await settle(page, context)
  context.currentUrl = page.url()
  context.stats.views.add(viewKey(page.url()))

  const metrics = await pageMetrics(page)
  const memory = await context.memory?.measure()
  if (memory) context.stats.memorySamples.push({ page: pathOf(page.url()), ...memory })
  log(summarize(pathOf(page.url()), metrics, context.viewRequests) + (memory ? ` · JS heap ${memory.heapMb} MB, ${memory.nodes} DOM nodes` : ''))
  checkHeapSize(memory, { where: pathOf(page.url()), steps: stepsFor(context), evidence: evidenceFor(context), add: (f) => findings.add(f) })
  checkPageMetrics(metrics, page.url(), findings, evidenceFor(context), stepsFor(context))
  checkRepeatedRequests(context.viewRequests, `on ${pathOf(page.url())}`, findings, evidenceFor(context), stepsFor(context))
  await checkContent(page, context, findings)
  await screenshotPending(page, findings)
  return true
}

// Clicks each safe control once per kind of page (/projects/:id is one kind),
// checking what every click triggers. Clicks that navigate are queued as pages.
async function clickThrough(page, url, context, findings, log, clicked, queue) {
  let labels = await tagClickables(page)
  let clicks = 0
  const repeatable = [] // clicks that stayed on this page — replayed for the leak check

  for (let index = 0; index < labels.length && clicks < config.maxClicksPerPage; index += 1) {
    const label = labels[index]
    const key = `${pathPattern(url)}::${label}`
    if (clicked.has(key)) continue
    clicked.add(key)

    const control = page.locator(`[data-qa-click="${index}"]`)
    if ((await control.count()) === 0) continue

    clicks += 1
    context.stats.clicks += 1
    context.trail = [`Open ${url}`, `Click "${label}"`]
    context.viewRequests = []
    addBreadcrumb(context, 'click', label)
    log('Clicked', `"${label}" on ${pathOf(url)}`)

    const clickError = await control.click({ timeout: 5_000 }).then(() => null, (error) => error)
    if (clickError) {
      log('Could not click', `"${label}": ${clickError.message.split('\n')[0]}`)
      continue
    }
    await settle(page, context)
    context.currentUrl = page.url()
    context.stats.views.add(viewKey(url, context.trail))

    log(summarize(`after clicking "${label}"`, null, context.viewRequests))
    checkRepeatedRequests(context.viewRequests, `after clicking "${label}"`, findings, evidenceFor(context), stepsFor(context))
    await checkContent(page, context, findings)
    await screenshotPending(page, findings)

    if (page.url() !== url) {
      // The click navigated: explore that page on its own, come back here.
      const target = new URL(page.url())
      target.hash = ''
      if (target.origin === context.origin && !queue.includes(target.href)) queue.push(target.href)
      await page.goto(url, { waitUntil: 'networkidle' }).catch(() => null)
      await settle(page, context)
      labels = await tagClickables(page)
      index = -1 // re-walk the freshly tagged list; already-clicked labels are skipped
    } else {
      repeatable.push(label)
      await page.keyboard.press('Escape').catch(() => null) // close any modal/menu it opened
    }
  }

  await leakCheck(page, url, repeatable, context, findings, log)
}

// Replays the same clicks twice more and compares memory after garbage
// collection: pass one already warmed caches, so steady growth means a leak.
async function leakCheck(page, url, labels, context, findings, log) {
  if (!context.memory || labels.length < 2) return

  const before = await context.memory.measure()
  findings.replaying = true
  for (let cycle = 0; cycle < 2; cycle += 1) {
    for (const label of labels) {
      const index = (await tagClickables(page)).indexOf(label)
      if (index === -1) continue
      await page.locator(`[data-qa-click="${index}"]`).click({ timeout: 5_000 }).catch(() => null)
      await settle(page, context)
      await page.keyboard.press('Escape').catch(() => null)
    }
  }
  const after = await context.memory.measure()
  // Probe reports for the replayed calls arrive asynchronously; let them land
  // while repeats are still being ignored.
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  findings.replaying = false
  if (page.url() !== url) return // something navigated away; the comparison isn't meaningful

  context.stats.leakChecks.push({ page: pathOf(url), clicks: labels, before, after })
  log('Memory check', `${pathOf(url)} — repeated ${labels.length} click(s) ×2: JS heap ${before?.heapMb} → ${after?.heapMb} MB, DOM nodes ${before?.nodes} → ${after?.nodes}, listeners ${before?.listeners} → ${after?.listeners}`)
  context.trail = [`Open ${url}`, `Click ${labels.map((l) => `"${l}"`).join(', ')} three times over`]
  checkLeak(before, after, { where: pathOf(url), steps: stepsFor(context), evidence: evidenceFor(context), add: (f) => findings.add(f) })
}

// Sidekiq jobs the run's actions kicked off (or that ran meanwhile).
async function collectJobReports(probe, context, findings, log) {
  if (!probe.enabled || probe.origins.size === 0) return
  const jobs = await probe.jobsSince(context.stats.startedAt)
  context.stats.jobs = jobs.map((job) => ({ name: job.name, status: job.status, durationMs: job.duration_ms, queries: job.db?.queries }))
  log('Background jobs', jobs.length ? jobs.map((j) => `${j.name} (${j.status}, ${j.duration_ms} ms)`).join(', ') : 'none ran during this run')

  for (const job of jobs) {
    const where = `background job ${job.name}`
    findingsFromReport(job, {
      where,
      isJob: true,
      steps: (observation) => [...context.baseSteps(), `Wait for ${where} to run`, `Observe: ${observation}`],
      evidence: (extra) => ({ pageUrl: null, breadcrumbs: [], ...extra }),
      add: (f) => findings.add(f),
    })
  }
}

async function checkContent(page, context, findings) {
  const text = (await page.locator('body').innerText().catch(() => '')).trim()
  const where = pathOf(page.url())
  const evidence = evidenceFor(context)

  if (text.length === 0) {
    findings.add({
      fingerprint: `blank:${where}:${context.trail.at(-1)}`,
      title: `Blank screen: ${where}${context.trail.length > 1 ? ` after ${context.trail.at(-1).toLowerCase()}` : ''}`,
      severity: 'high',
      category: 'error',
      reproSteps: stepsFor(context)('The screen renders with no visible content'),
      details: evidence({ type: 'blank_page' }),
    })
    return
  }

  const errorText = await visibleErrorText(page, text)
  const match = errorText?.match(ERROR_TEXT)
  if (match) {
    const start = Math.max(0, match.index - 80)
    const excerpt = errorText.slice(start, match.index + 160).replace(/\s+/g, ' ')
    findings.add({
      fingerprint: `errtext:${where}:${match[0].toLowerCase()}`,
      title: `Error shown on ${where}: "${match[0]}"`,
      severity: 'high',
      category: 'error',
      reproSteps: stepsFor(context)(`The page shows an error: "${excerpt}"`),
      details: evidence({ type: 'error_text', excerpt }),
    })
  }
}

// Only text where apps actually *show* errors counts — alerts, toasts,
// headings, the tab title — or the whole page when it's little more than an
// error message. Words like "error" inside data (tables, logs, a list of
// issues) are content, not a broken page.
const ERROR_SURFACES = '[role="alert"], [role="alertdialog"], .alert, .toast, .swal2-popup, .notification, .flash, .error, h1, h2, h3'
const ERROR_PAGE_MAX_CHARS = 400

async function visibleErrorText(page, bodyText) {
  if (bodyText.length <= ERROR_PAGE_MAX_CHARS) return bodyText
  const surfaces = await page
    .$$eval(ERROR_SURFACES, (elements) =>
      elements
        .filter((el) => el.offsetParent !== null && !el.closest('table'))
        .map((el) => el.innerText)
        .join('\n')
    )
    .catch(() => '')
  return `${await page.title().catch(() => '')}\n${surfaces}`
}

// API calls of the current page still waiting for a response. Calls from a
// previous page load, or stuck for over 30s (long-polling), don't count.
const pendingCalls = (context) =>
  [...context.inflight.values()].filter(
    (call) => call.documentId === context.documentId && Date.now() - call.startedAt < 30_000
  )

// Settled = the page's own load is done, no API call has been in flight for
// half a second, and the app had a moment to render (and fail). Clicks in a
// single-page app start requests that page "load states" don't track.
async function settle(page, context) {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => null)
  const deadline = Date.now() + 20_000
  let quietSince = null
  while (Date.now() < deadline) {
    if (pendingCalls(context).length > 0) quietSince = null
    else if (quietSince === null) quietSince = Date.now()
    else if (Date.now() - quietSince >= 500) break
    await page.waitForTimeout(100)
  }
  const stuck = pendingCalls(context)
  if (stuck.length > 0) console.log(`[settle] gave up waiting on: ${stuck.map((call) => call.label).join(', ')}`)
  await page.waitForTimeout(300)
}

// Requests that overlapped others had their memory/timings mixed with the
// other requests' work (Ruby counts allocations per process). Re-send each
// read-only one alone, now that the browser is idle, and judge it on that.
async function remeasureInIsolation(probe, context, findings, log) {
  if (!probe.enabled || context.replays.size === 0) return

  for (const { label, options, request, slow } of context.replays.values()) {
    const report = await probe.replay(request)
    if (!report) continue
    context.stats.isolated.push({
      label,
      durationMs: report.duration_ms,
      sqlMs: report.db?.total_ms,
      queries: report.db?.queries,
      allocatedObjects: report.memory?.allocated_objects,
      rssDeltaMb: report.memory?.rss_delta_mb,
      overlapped: Boolean(report.overlapped),
    })
    findingsFromReport(report, { ...options, parts: 'measured' })

    const serverMs = Math.round(report.duration_ms)
    if (slow && serverMs >= config.slowRequestMs) {
      const server = breakdownFromProbe(report)
      findings.add({
        fingerprint: `slow:${label.replace(/ \((GET|POST|PUT|PATCH|DELETE) .*\)$/, '')}`,
        title: `Slow ${slow.isPage ? 'page response' : 'API call'}: ${label} took ${serverMs} ms (measured alone)`,
        severity: serverMs >= config.slowRequestMs * 3 ? 'high' : 'medium',
        category: 'performance',
        reproSteps: options.steps(
          `${label} takes ${serverMs} ms on the server even with nothing else running (${slow.browserMs} ms in the browser during the run)${
            server?.diagnosis ? `. ${server.diagnosis}` : ''
          }`
        ),
        details: options.evidence({ type: 'slow_request', request: slow.call, durationMs: serverMs, server, isolated: true }),
      })
    }
  }
  log('Re-measured in isolation', [...context.replays.values()].map((r) => r.label).join(', '))
}

const evidenceFor = (context) => (extra) => ({
  pageUrl: context.currentUrl,
  view: viewKey(context.currentUrl, context.trail),
  breadcrumbs: context.breadcrumbs.slice(-15),
  ...extra,
})

const stepsFor = (context) => (observation) => [...context.baseSteps(), ...context.trail, `Observe: ${observation}`]

async function screenshotPending(page, findings) {
  const pending = findings.withoutScreenshot()
  if (pending.length === 0) return

  const screenshot = await page.screenshot({ fullPage: true }).catch(() => null)
  for (const finding of pending) finding.screenshot = screenshot
}

async function report(backend, job, findings, status, auditLogEntries, context, probe) {
  const all = findings.all().map(triage)
  for (const finding of all) {
    await backend
      .createFinding({ runId: job.run_id, ...finding, screenshot: finding.screenshot || null })
      .catch((error) => console.error(`[run ${job.run_id}] could not report finding "${finding.title}": ${error.message}`))
  }

  const bySeverity = ['critical', 'high', 'medium', 'low']
    .map((severity) => [severity, all.filter((f) => f.severity === severity).length])
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`)
  const summary = `${all.length} finding(s)${bySeverity.length ? ` (${bySeverity.join(', ')})` : ''}; run ${status}`
  auditLogEntries.push({ actionTaken: 'Run finished', targetElement: summary })
  console.log(`[run ${job.run_id}] Run finished — ${summary}`)

  await backend
    .receiveRunResult({
      runId: job.run_id,
      status,
      auditLogEntries,
      networkLog: context.networkLog,
      summary: buildSummary(context, probe, all, status),
    })
    .catch((error) => console.error(`[run ${job.run_id}] could not report result: ${error.message}`))
}

// Run-level overview: coverage, API timings, backend totals and memory.
function buildSummary(context, probe, findings, status) {
  const calls = context.networkLog.filter((entry) => entry.resourceType !== 'document')
  const timed = calls.filter((entry) => entry.durationMs != null)
  const byOperation = new Map()
  for (const call of timed) {
    const stats = byOperation.get(call.label) || { label: call.label, count: 0, totalMs: 0, maxMs: 0, queries: 0 }
    stats.count += 1
    stats.totalMs += call.durationMs
    stats.maxMs = Math.max(stats.maxMs, call.durationMs)
    stats.queries += call.probe?.queries ?? 0
    byOperation.set(call.label, stats)
  }
  const endpoints = [...byOperation.values()]
    .map((e) => ({ ...e, avgMs: Math.round(e.totalMs / e.count) }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 25)
  const probed = calls.filter((entry) => entry.probe)
  const sum = (key) => probed.reduce((total, entry) => total + (entry.probe[key] ?? 0), 0)
  const countBy = (key) =>
    findings.reduce((counts, finding) => ({ ...counts, [finding[key]]: (counts[finding[key]] || 0) + 1 }), {})

  return {
    status,
    browser: context.stats.browser,
    startedAt: context.stats.startedAt.toISOString(),
    durationMs: Date.now() - context.stats.startedAt.getTime(),
    pages: context.stats.pages,
    clicks: context.stats.clicks,
    // Every page/tab this run reached — issues elsewhere weren't re-checked.
    views: [...context.stats.views],
    apiCalls: calls.length,
    failedCalls: calls.filter((c) => c.status >= 400).length,
    findingsBySeverity: countBy('severity'),
    findingsByCategory: countBy('category'),
    endpoints,
    backend: probe.enabled
      ? {
          probedCalls: probed.length,
          sqlQueries: sum('queries'),
          sqlMs: Math.round(sum('sqlMs')),
          nPlusOne: sum('nPlusOne'),
          exceptions: sum('exceptions'),
          jobs: context.stats.jobs || [],
        }
      : null,
    memory: context.stats.memorySamples,
    leakChecks: context.stats.leakChecks,
    // Server memory per request, measured with nothing else running.
    isolated: context.stats.isolated,
  }
}
