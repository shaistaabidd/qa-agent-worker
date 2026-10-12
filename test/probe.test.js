import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.WORKER_API_TOKEN ||= 'x'
process.env.AGENT_API_TOKEN ||= 'x'
const { findingsFromReport } = await import('../src/probe.js')

const collect = (report, options = {}) => {
  const added = []
  findingsFromReport(report, {
    where: 'MyProjects (POST /graphql)',
    steps: (o) => [o],
    evidence: (extra) => extra,
    add: (f) => added.push(f),
    ...options,
  })
  return added
}

const report = (overrides) => ({
  name: 'POST /graphql (MyProjects)',
  kind: 'request',
  duration_ms: 120,
  db: { queries: 5, cached: 0, total_ms: 10 },
  n_plus_one: [],
  slow_queries: [],
  exceptions: [],
  memory: { allocated_objects: 1000, rss_delta_mb: 0 },
  ...overrides,
})

test('turns an N+1 into a finding pointing at the code line', () => {
  const [finding] = collect(report({
    n_plus_one: [{ sql: 'SELECT "memberships".* FROM "memberships" WHERE x = ?', table: 'memberships', count: 25, total_ms: 40,
      caller: 'app/graphql/types/projects/project_type.rb:12', suggestion: 'Preload…' }],
  }))
  assert.equal(finding.title, 'N+1 query: memberships loaded 25× one by one (app/graphql/types/projects/project_type.rb:12)')
  assert.equal(finding.severity, 'high')
  assert.equal(finding.details.location, 'app/graphql/types/projects/project_type.rb:12')
})

test('unhandled backend exceptions are critical, swallowed ones medium (high in jobs)', () => {
  const exceptions = [
    { class: 'NoMethodError', message: 'undefined method', location: 'app/a.rb:1', handled: false, backtrace: [] },
    { class: 'KeyError', message: 'key not found', location: 'app/b.rb:2', handled: true, backtrace: [] },
  ]
  const [unhandled, handled] = collect(report({ exceptions }))
  assert.equal(unhandled.severity, 'critical')
  assert.equal(handled.severity, 'medium')
  assert.equal(collect(report({ exceptions: [exceptions[1]] }), { isJob: true })[0].severity, 'high')
})

test('flags too many queries and memory bloat', () => {
  const titles = collect(report({ db: { queries: 120, total_ms: 300 }, memory: { allocated_objects: 3_000_000, rss_delta_mb: 80, rss_before_mb: 100, rss_after_mb: 180 } }))
    .map((f) => f.category)
  assert.deepEqual(titles, ['performance', 'memory', 'memory'])
})

test('splits exact findings (exceptions, N+1) from measured ones (memory, slow SQL)', () => {
  const bloated = report({
    overlapped: true,
    exceptions: [{ class: 'KeyError', message: 'x', location: 'app/a.rb:1', handled: true, backtrace: [] }],
    slow_queries: [{ sql: 'SELECT 1', ms: 500, caller: 'app/a.rb:2' }],
    memory: { allocated_objects: 3_000_000, rss_delta_mb: 0 },
  })
  assert.deepEqual(collect(bloated, { parts: 'exact' }).map((f) => f.details.type), ['backend_handled_exception'])
  const measured = collect(bloated, { parts: 'measured' })
  assert.deepEqual(measured.map((f) => f.details.type), ['slow_query', 'backend_allocations'])
  assert.match(measured[1].title, /measured while other requests ran/)
})
