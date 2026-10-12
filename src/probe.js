import { config } from './config.js'
import { normalizeMessage, oneLine } from './text.js'

// Reads the backend probe's per-request reports (SQL, N+1, exceptions,
// memory). Any response carrying X-QA-Probe-Id came from an instrumented
// backend; the report lives at <that origin>/__qa_probe/requests/<id>.
export class ProbeClient {
  #pending = []

  constructor() {
    this.enabled = Boolean(config.probeToken)
    this.reports = []
    this.origins = new Set()
  }

  // Fetches in the background so browsing isn't slowed down; `settled()`
  // waits for everything requested so far.
  fetchFor(response, call) {
    const id = response.headers()['x-qa-probe-id']
    if (!this.enabled || !id) return null

    const origin = new URL(response.url()).origin
    this.origins.add(origin)
    const promise = this.#get(`${origin}/__qa_probe/requests/${id}`).then((report) => {
      if (report) {
        call.probe = summarizeReport(report)
        this.reports.push({ report, call })
      }
      return report
    })
    this.#pending.push(promise)
    return promise
  }

  async settled() {
    await Promise.allSettled(this.#pending)
  }

  // Re-sends a read-only request on its own (nothing else in flight) and
  // returns the probe report for it — an isolated memory/timing measurement.
  async replay({ url, method, headers, body }) {
    try {
      const response = await fetch(url, { method, headers, body })
      const id = response.headers.get('x-qa-probe-id')
      await response.arrayBuffer()
      if (!id) return null
      // The report is stored as the response finishes; give it a moment.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const report = await this.#get(`${new URL(url).origin}/__qa_probe/requests/${id}`)
        if (report) return report
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    } catch {
      // unreachable or rejected — keep the original (shared) measurement
    }
    return null
  }

  // Background job reports from every instrumented backend seen in the run.
  async jobsSince(since) {
    const jobs = []
    for (const origin of this.origins) {
      const body = await this.#get(`${origin}/__qa_probe/jobs?since=${encodeURIComponent(since.toISOString())}`)
      jobs.push(...(body?.jobs || []))
    }
    return jobs
  }

  async #get(url) {
    try {
      const response = await fetch(url, { headers: { 'X-QA-Probe-Token': config.probeToken } })
      if (!response.ok) return null
      return await response.json()
    } catch {
      return null
    }
  }
}

// The compact version stored on each API log entry.
export const summarizeReport = (report) => ({
  id: report.id,
  durationMs: report.duration_ms,
  queries: report.db?.queries ?? 0,
  cachedQueries: report.db?.cached ?? 0,
  sqlMs: report.db?.total_ms ?? 0,
  nPlusOne: report.n_plus_one?.length ?? 0,
  slowQueries: report.slow_queries?.length ?? 0,
  exceptions: report.exceptions?.length ?? 0,
  allocatedObjects: report.memory?.allocated_objects ?? null,
  rssDeltaMb: report.memory?.rss_delta_mb ?? null,
  overlapped: Boolean(report.overlapped),
})

// Turns one probe report into findings. `where` describes the request or job
// ("UpdateProject (POST /graphql)" / "background job RepoScanJob").
//
// `parts` picks what to report: 'exact' = exceptions, N+1 and query counts
// (recorded per thread, always attributable to this request); 'measured' =
// slow queries, allocations and process memory, which are only this request's
// own when it didn't overlap others (report.overlapped).
export function findingsFromReport(report, { where, steps, evidence, add, isJob = false, parts = 'all' }) {
  const exact = parts !== 'measured'
  const measured = parts !== 'exact'
  const shared = report.overlapped ? ' (measured while other requests ran)' : ''
  const backendEvidence = (extra) =>
    evidence({
      backend: {
        name: report.name,
        kind: report.kind,
        status: report.status,
        durationMs: report.duration_ms,
        db: report.db,
        memory: report.memory,
        overlapped: Boolean(report.overlapped),
        topQueries: report.top_queries?.slice(0, 5),
      },
      ...extra,
    })

  for (const exception of exact ? report.exceptions || [] : []) {
    const unhandled = exception.handled === false
    const message = normalizeMessage(exception.message)
    add({
      fingerprint: `backend-exception:${exception.class}:${exception.location || ''}:${oneLine(message, 120)}`,
      title: `${unhandled ? 'Unhandled' : 'Handled'} backend exception ${exception.class}: ${oneLine(message, 90)}${
        exception.location ? ` (${exception.location})` : ''
      }`,
      severity: unhandled ? 'critical' : isJob ? 'high' : 'medium',
      category: 'backend',
      reproSteps: steps(
        `${where} raises ${exception.class}: ${oneLine(message, 200)}${
          unhandled ? '' : ' — the app rescues it, so the real cause is hidden from the user'
        }`
      ),
      details: backendEvidence({
        type: unhandled ? 'backend_unhandled_exception' : 'backend_handled_exception',
        errorName: exception.class,
        message: exception.message,
        location: exception.location,
        backtrace: exception.backtrace,
        handled: !unhandled,
      }),
    })
  }

  for (const query of exact ? report.n_plus_one || [] : []) {
    add({
      fingerprint: `n+1:${query.caller || ''}:${query.sql}`,
      title: `N+1 query: ${query.table || 'records'} loaded ${query.count}× one by one${query.caller ? ` (${query.caller})` : ''}`,
      severity: query.count >= 20 ? 'high' : 'medium',
      category: 'performance',
      reproSteps: steps(`${where} runs the same query ${query.count} times (${query.total_ms} ms total). ${query.suggestion}`),
      details: backendEvidence({ type: 'n_plus_one', location: query.caller, query }),
    })
  }

  for (const query of measured ? report.slow_queries || [] : []) {
    add({
      fingerprint: `slow-sql:${query.caller || ''}:${query.sql}`,
      title: `Slow SQL query: ${query.ms} ms${query.caller ? ` (${query.caller})` : ''}${shared}`,
      severity: query.ms >= 1000 ? 'high' : 'medium',
      category: 'performance',
      reproSteps: steps(`${where} runs a query taking ${query.ms} ms: ${oneLine(query.sql, 200)}`),
      details: backendEvidence({ type: 'slow_query', location: query.caller, query, durationMs: query.ms }),
    })
  }

  const queryCount = report.db?.queries ?? 0
  if (exact && queryCount >= config.maxQueriesPerRequest) {
    add({
      fingerprint: `query-count:${report.name}`,
      title: `Too many queries: ${queryCount} SQL queries in ${report.name}`,
      severity: queryCount >= config.maxQueriesPerRequest * 3 ? 'high' : 'medium',
      category: 'performance',
      reproSteps: steps(`${where} runs ${queryCount} SQL queries (${report.db.total_ms} ms in the database)`),
      details: backendEvidence({ type: 'query_count' }),
    })
  }

  const allocated = report.memory?.allocated_objects ?? 0
  if (measured && allocated >= config.maxAllocatedObjects) {
    add({
      fingerprint: `allocations:${report.name}`,
      title: `Memory bloat: ${report.name} allocated ${(allocated / 1e6).toFixed(1)}M objects${shared}`,
      severity: allocated >= config.maxAllocatedObjects * 4 ? 'high' : 'medium',
      category: 'memory',
      reproSteps: steps(`${where} allocates ${allocated.toLocaleString('en-US')} Ruby objects in one go`),
      details: backendEvidence({ type: 'backend_allocations', overlapped: Boolean(report.overlapped) }),
    })
  }

  const rssDelta = report.memory?.rss_delta_mb ?? 0
  if (measured && rssDelta >= config.maxRssGrowthMb) {
    add({
      fingerprint: `rss:${report.name}`,
      title: `Server memory grew ${rssDelta} MB during ${report.name}${shared}`,
      severity: rssDelta >= config.maxRssGrowthMb * 3 ? 'high' : 'medium',
      category: 'memory',
      reproSteps: steps(`The server process grows from ${report.memory.rss_before_mb} MB to ${report.memory.rss_after_mb} MB during ${where}`),
      details: backendEvidence({ type: 'backend_memory_growth', overlapped: Boolean(report.overlapped) }),
    })
  }
}
