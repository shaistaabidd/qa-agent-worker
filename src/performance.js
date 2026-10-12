import { config } from './config.js'
import { pathOf } from './text.js'

// Installed before any page script runs: records Core Web Vitals the
// Performance API only exposes through observers.
export function installPerformanceObservers() {
  window.__qaPerf = { lcp: null, cls: 0, longTasks: [] }
  const observe = (type, onEntry) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(onEntry)).observe({ type, buffered: true })
    } catch {
      // entry type not supported by this browser
    }
  }
  observe('largest-contentful-paint', (entry) => {
    window.__qaPerf.lcp = Math.round(entry.renderTime || entry.startTime)
  })
  observe('layout-shift', (entry) => {
    if (!entry.hadRecentInput) window.__qaPerf.cls += entry.value
  })
  observe('longtask', (entry) => window.__qaPerf.longTasks.push(Math.round(entry.duration)))
}

export const pageMetrics = (page) =>
  page
    .evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0]
      const perf = window.__qaPerf || { longTasks: [] }
      return {
        ttfbMs: nav ? Math.round(nav.responseStart) : null,
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        loadMs: nav ? Math.round(nav.loadEventEnd) : null,
        lcpMs: perf.lcp,
        cls: Math.round(perf.cls * 1000) / 1000,
        longTasks: perf.longTasks.length,
        longTaskMs: perf.longTasks.reduce((sum, ms) => sum + ms, 0),
      }
    })
    .catch(() => null)

const fmt = (ms) => (ms == null ? '—' : `${ms} ms`)

// One-line, Scout-style summary of a page load or view change.
export const summarize = (label, metrics, requests) => {
  const parts = []
  if (metrics) {
    parts.push(`TTFB ${fmt(metrics.ttfbMs)}`, `DOM ready ${fmt(metrics.domContentLoadedMs)}`, `LCP ${fmt(metrics.lcpMs)}`)
    parts.push(`CLS ${metrics.cls}`)
    if (metrics.longTasks) parts.push(`${metrics.longTasks} long task(s), ${metrics.longTaskMs} ms blocked`)
  }
  const timed = requests.filter((r) => r.durationMs != null)
  const slowest = timed.sort((a, b) => b.durationMs - a.durationMs)[0]
  parts.push(`${requests.length} API call(s)${slowest ? `, slowest ${slowest.label} ${slowest.durationMs} ms` : ''}`)
  return `Performance ${label}: ${parts.join(' · ')}`
}

// Page-load thresholds roughly follow Google's Core Web Vitals guidance.
export function checkPageMetrics(metrics, url, findings, evidence, steps) {
  if (!metrics) return
  const path = pathOf(url)
  const add = (key, title, severity, observation, extra) =>
    findings.add({
      fingerprint: `perf:${key}:${path}`,
      title,
      severity,
      category: 'performance',
      reproSteps: steps(observation),
      details: evidence({ type: 'page_performance', metrics, ...extra }),
    })

  if (metrics.lcpMs != null && metrics.lcpMs > 2500) {
    add('lcp', `Slow page render on ${path}: LCP ${metrics.lcpMs} ms`, metrics.lcpMs > 4000 ? 'high' : 'medium',
      `The main content takes ${metrics.lcpMs} ms to appear (good: under 2500 ms)`)
  }
  if (metrics.ttfbMs != null && metrics.ttfbMs > 800) {
    add('ttfb', `Slow server response on ${path}: TTFB ${metrics.ttfbMs} ms`, metrics.ttfbMs > 1800 ? 'high' : 'medium',
      `The first byte arrives after ${metrics.ttfbMs} ms (good: under 800 ms)`)
  }
  if (metrics.cls > 0.1) {
    add('cls', `Layout shifts on ${path}: CLS ${metrics.cls}`, metrics.cls > 0.25 ? 'medium' : 'low',
      `Content jumps around while loading (CLS ${metrics.cls}; good: under 0.1)`)
  }
  if (metrics.longTaskMs > 500) {
    add('longtask', `Main thread blocked on ${path}: ${metrics.longTaskMs} ms of long tasks`, 'medium',
      `JavaScript blocks the page for ${metrics.longTaskMs} ms across ${metrics.longTasks} long task(s)`)
  }
}

// The same call fired several times by one view usually means a render loop
// or a component fetching per item — the frontend's version of an N+1.
export function checkRepeatedRequests(requests, viewLabel, findings, evidence, steps) {
  const groups = new Map()
  for (const request of requests) {
    const key = `${request.label}|${JSON.stringify(request.variables ?? null)}`
    groups.set(key, [...(groups.get(key) || []), request])
  }
  for (const [, calls] of groups) {
    if (calls.length < config.repeatedRequestThreshold) continue
    const { label } = calls[0]
    findings.add({
      fingerprint: `repeat:${label}:${viewLabel}`,
      title: `Repeated request: ${label} fired ${calls.length}× ${viewLabel}`,
      severity: calls.length >= config.repeatedRequestThreshold * 2 ? 'medium' : 'low',
      category: 'performance',
      reproSteps: steps(`${label} is sent ${calls.length} times with identical variables`),
      details: evidence({ type: 'repeated_request', request: calls[0], count: calls.length, durationsMs: calls.map((c) => c.durationMs) }),
    })
  }
}
