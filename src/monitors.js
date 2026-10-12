import { config } from './config.js'
import { findingsFromReport } from './probe.js'
import { appFrame, cleanStack, normalizeMessage, oneLine, pathOf, redact, redactText, shortUrl, viewKey } from './text.js'

const API_RESOURCE_TYPES = new Set(['xhr', 'fetch'])
const MAX_BREADCRUMBS = 25

export const addBreadcrumb = (context, type, message) => {
  context.breadcrumbs.push({ at: new Date().toISOString(), type, message: oneLine(message, 200) })
  if (context.breadcrumbs.length > MAX_BREADCRUMBS) context.breadcrumbs.shift()
}

// Method, path and — for GraphQL — the operation name and (redacted) variables.
export const describeRequest = (request) => {
  let body = null
  try {
    body = request.postDataJSON()
  } catch {
    body = null
  }
  const operations = Array.isArray(body) ? body : body ? [body] : []
  const operationName = operations.map((op) => op?.operationName).filter(Boolean).join(', ') || null
  const path = pathOf(request.url())

  return {
    method: request.method(),
    url: path,
    resourceType: request.resourceType(),
    operationName,
    variables: operations[0]?.variables ? redact(operations[0].variables) : undefined,
    label: operationName ? `${operationName} (${request.method()} ${path})` : `${request.method()} ${path}`,
  }
}

// Parses a Server-Timing header (Rails sends one in development) into a
// Scout-style breakdown: total server time, database time, and the rest.
export const serverBreakdown = (header) => {
  if (!header) return null
  const metrics = Object.fromEntries(
    header.split(',').map((part) => {
      const [name, ...params] = part.trim().split(';')
      const dur = params.map((p) => p.trim()).find((p) => p.startsWith('dur='))
      return [name.trim(), dur ? Number(dur.slice(4)) : null]
    })
  )
  const totalMs = metrics['process_action.action_controller'] ?? metrics.total ?? metrics.app ?? null
  const dbMs = metrics['sql.active_record'] ?? metrics.db ?? metrics.sql ?? null
  if (totalMs == null) return { metrics }

  const otherMs = dbMs != null ? Math.max(0, totalMs - dbMs) : null
  let diagnosis = null
  if (dbMs != null && dbMs / totalMs >= 0.5) {
    diagnosis = `Most server time (${Math.round(dbMs)} of ${Math.round(totalMs)} ms) is in the database — look for slow or N+1 queries.`
  } else if (otherMs != null && otherMs / totalMs >= 0.8) {
    diagnosis = `Only ${Math.round(dbMs)} ms of ${Math.round(totalMs)} ms is database time — the rest is spent in app code or waiting on external services (third-party APIs, network calls).`
  }
  return { totalMs: Math.round(totalMs), dbMs: dbMs != null ? Math.round(dbMs) : null, otherMs: otherMs != null ? Math.round(otherMs) : null, diagnosis, metrics }
}

// The same breakdown from a probe report, which also knows the query count.
export const breakdownFromProbe = (report) => {
  const totalMs = report.duration_ms
  const dbMs = report.db?.total_ms ?? 0
  const breakdown = serverBreakdown(`sql.active_record;dur=${dbMs}, process_action.action_controller;dur=${totalMs}`)
  return { ...breakdown, queries: report.db?.queries ?? 0, metrics: undefined }
}

// Turns browser-level problems into findings with Sentry-style evidence.
// `context` tracks the current page, the user-visible steps taken on it
// (`trail`), recent breadcrumbs, and the API calls made by the current view.
// GraphQL queries and GETs are safe to re-send; mutations never are.
export const replayable = (request) => {
  if (request.method() === 'GET') return true
  const body = request.postData()
  if (!body || !/graphql/i.test(request.url())) return false
  try {
    const operations = [JSON.parse(body)].flat()
    return operations.every((op) => /^\s*(#[^\n]*\n\s*)*(query\b|\{)/.test(op?.query || ''))
  } catch {
    return false
  }
}

export function attachMonitors(page, findings, context, probe) {
  // In-flight API calls, so "settled" can mean "nothing still loading".
  // A full page load (not a client-side route change) starts a new
  // "document"; calls still pending from the previous one are abandoned and
  // the browser never reports them finished, so they're tracked per document.
  // The switch happens when the new page commits, so calls the old page fires
  // in its last moments still belong to the old page.
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) context.documentId += 1
  })
  const track = (request, open) => {
    if (!API_RESOURCE_TYPES.has(request.resourceType())) return
    if (open) {
      context.inflight.set(request, { label: describeRequest(request).label, documentId: context.documentId, startedAt: Date.now() })
    } else {
      context.inflight.delete(request)
    }
  }
  page.on('request', (request) => track(request, true))
  page.on('requestfailed', (request) => track(request, false))

  // Evidence/steps are captured *when* something happens: async handlers
  // (probe reports, response bodies) finish after the user has moved on.
  const snapshot = () => {
    const pageUrl = context.currentUrl
    const trail = [...context.trail]
    const breadcrumbs = context.breadcrumbs.slice(-15)
    const view = viewKey(pageUrl, trail)
    return {
      evidence: (extra) => ({ pageUrl, view, breadcrumbs, ...extra }),
      steps: (observation) => [...context.baseSteps(), ...trail, `Observe: ${observation}`],
    }
  }
  const replayCandidate = (request, info, options) => {
    const key = `${info.label}|${JSON.stringify(info.variables ?? null)}`
    if (!context.replays.has(key)) {
      context.replays.set(key, {
        label: info.label,
        options: { ...options, add: (f) => findings.add(f) },
        request: { url: request.url(), method: request.method(), headers: request.headers(), body: request.postData() },
      })
    }
    return context.replays.get(key)
  }
  const evidence = (extra) => snapshot().evidence(extra)
  const steps = (observation) => snapshot().steps(observation)

  page.on('pageerror', (error) => {
    const location = appFrame(error.stack, context.origin)
    const message = normalizeMessage(error.message)
    addBreadcrumb(context, 'error', `${error.name}: ${error.message}`)
    findings.add({
      fingerprint: `js:${error.name}:${oneLine(message, 200)}:${location}`,
      title: `${error.name || 'Error'}: ${oneLine(message, 110)}${location ? ` (${location})` : ''}`,
      severity: 'high',
      category: 'error',
      reproSteps: steps(`An uncaught ${error.name || 'error'} is thrown: ${oneLine(error.message, 300)}`),
      details: evidence({
        type: 'uncaught_exception',
        errorName: error.name,
        message: redactText(error.message, 1000),
        location,
        stack: cleanStack(error.stack, context.origin),
      }),
    })
  })

  page.on('console', (message) => {
    const type = message.type()
    if (type === 'warning') addBreadcrumb(context, 'console.warn', message.text())
    if (type !== 'error') return

    const text = message.text()
    // Chrome logs every failed HTTP request to the console too; the request
    // itself is already reported (with status, body and backtrace).
    if (/^Failed to load resource: the server responded with a status of \d+/.test(text)) return
    const firstLine = normalizeMessage(text.split('\n')[0])
    const where = message.location()
    const location = where?.url ? `${shortUrl(where.url, context.origin)}:${(where.lineNumber ?? 0) + 1}` : null
    const isReactWarning = /^Warning: /.test(firstLine)
    addBreadcrumb(context, 'console.error', firstLine)

    findings.add({
      fingerprint: `console:${oneLine(firstLine, 200)}`,
      title: `${isReactWarning ? 'React warning' : 'Console error'}: ${oneLine(firstLine.replace(/^Warning: /, ''), 120)}`,
      severity: isReactWarning ? 'low' : 'medium',
      category: 'error',
      reproSteps: steps(`The browser console logs: ${oneLine(firstLine, 300)}`),
      details: evidence({
        type: isReactWarning ? 'react_warning' : 'console_error',
        message: redactText(text, 3000),
        location,
      }),
    })
  })

  page.on('requestfinished', async (request) => {
    const isApi = API_RESOURCE_TYPES.has(request.resourceType())
    const isPage = request.resourceType() === 'document'
    if (!isApi && !isPage) return

    track(request, false)
    const response = await request.response().catch(() => null)
    if (!response) return

    const at = snapshot()
    const info = describeRequest(request)
    const status = response.status()
    const timing = request.timing()
    const durationMs = timing.responseEnd > 0 ? Math.round(timing.responseEnd) : null
    const sizeBytes = Number(response.headers()['content-length']) || null
    const serverTiming = response.headers()['server-timing'] || null
    const call = { ...info, status, durationMs, sizeBytes, serverTiming }

    addBreadcrumb(context, 'request', `${info.label} → ${status}${durationMs != null ? ` in ${durationMs} ms` : ''}`)
    if (isApi) context.viewRequests.push(call)
    // The same object is logged and handed to the probe, which adds the
    // backend summary (`call.probe`) once its report arrives.
    Object.assign(call, { at: new Date().toISOString(), page: context.currentUrl, step: context.trail.at(-1) || null })
    if (context.networkLog.length < config.maxNetworkLog) context.networkLog.push(call)

    // Backend evidence (SQL, N+1, exceptions, memory) from the probe, if the
    // server is instrumented. Not during login: those calls carry the password.
    const probeReport = context.phase === 'login' ? null : probe?.fetchFor(response, call)
    probeReport?.then((report) => {
      if (!report) return
      const options = { where: info.label, steps: at.steps, evidence: at.evidence, add: (f) => findings.add(f) }
      if (report.overlapped && replayable(request)) {
        // Memory/timing here include other requests' work: report the exact
        // parts now and re-measure this one on its own at the end of the run.
        findingsFromReport(report, { ...options, parts: 'exact' })
        replayCandidate(request, info, options)
        return
      }
      findingsFromReport(report, options)
    })

    // While logging in, 4xx and GraphQL errors are expected (unauthenticated
    // calls, a rejected password) — the login result itself is reported instead.
    if (context.phase === 'login' && status < 500) return

    const responseSnippet = async () => redactText(await response.text().catch(() => ''), 2000)

    if (status >= 500 || (status >= 400 && status !== 401)) {
      const serverError = status >= 500
      findings.add({
        fingerprint: `http:${status}:${info.method}:${info.operationName || pathOf(request.url()).split('?')[0]}`,
        title: `${serverError ? 'Server error' : isPage ? 'Page failed' : 'Request failed'} ${status}: ${info.label}`,
        severity: serverError || isPage ? 'high' : 'medium',
        // 5xx = the server crashed (backend); 4xx = the request was rejected.
        category: serverError ? 'backend' : 'network',
        reproSteps: at.steps(`${info.label} responds with HTTP ${status}`),
        details: at.evidence({ type: 'http_error', request: call, responseBody: await responseSnippet() }),
      })
      return
    }

    // GraphQL reports errors with HTTP 200 and an `errors` array.
    if (isApi && /graphql/i.test(request.url())) {
      const body = await response.json().catch(() => null)
      for (const error of body?.errors || []) {
        const message = normalizeMessage(error.message)
        findings.add({
          fingerprint: `gql:${info.operationName}:${oneLine(message, 200)}`,
          title: `GraphQL error in ${info.operationName || 'request'}: ${oneLine(message, 110)}`,
          severity: 'medium',
          category: 'error',
          reproSteps: at.steps(`${info.label} returns a GraphQL error: ${oneLine(message, 300)}`),
          details: at.evidence({
            type: 'graphql_error',
            message: redactText(error.message, 1000),
            graphqlPath: error.path,
            extensions: redact(error.extensions),
            request: call,
          }),
        })
      }
    }

    if (durationMs != null && durationMs >= config.slowRequestMs) {
      // Prefer the probe's own numbers; fall back to the Server-Timing header.
      const report = await probeReport
      if (report?.overlapped && replayable(request)) {
        // Slow maybe only because another request was hogging the server —
        // judge it on the isolated re-measurement instead.
        replayCandidate(request, info, { where: info.label, steps: at.steps, evidence: at.evidence }).slow = {
          browserMs: durationMs,
          isPage,
          call,
        }
        return
      }
      const server = report
        ? breakdownFromProbe(report)
        : serverBreakdown(serverTiming)
      findings.add({
        fingerprint: `slow:${info.operationName || `${info.method} ${pathOf(request.url()).split('?')[0]}`}`,
        title: `Slow ${isPage ? 'page response' : 'API call'}: ${info.label} took ${durationMs} ms`,
        severity: durationMs >= config.slowRequestMs * 3 ? 'high' : 'medium',
        category: 'performance',
        reproSteps: at.steps(
          `${info.label} takes ${durationMs} ms (threshold ${config.slowRequestMs} ms)${server?.diagnosis ? `. ${server.diagnosis}` : ''}`
        ),
        details: at.evidence({ type: 'slow_request', request: call, durationMs, timing, server }),
      })
    }
  })

  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText || 'unknown error'
    // Aborted requests are normal when navigating away mid-load.
    if (failure.includes('ERR_ABORTED') || !API_RESOURCE_TYPES.has(request.resourceType())) return

    const info = describeRequest(request)
    addBreadcrumb(context, 'request', `${info.label} failed: ${failure}`)
    findings.add({
      fingerprint: `netfail:${info.method}:${info.operationName || pathOf(request.url()).split('?')[0]}:${failure}`,
      title: `Network request failed: ${info.label} (${failure})`,
      severity: 'medium',
      category: 'network',
      reproSteps: steps(`${info.label} fails: ${failure}`),
      details: evidence({ type: 'request_failed', request: info, failure }),
    })
  })
}
