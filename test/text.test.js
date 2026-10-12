import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appFrame, cleanStack, pathPattern, redact } from '../src/text.js'

const origin = 'http://localhost:3000'
const stack = `TypeError: Cannot read properties of undefined (reading 'map')
    at Runs (http://localhost:3000/src/pages/Projects/ProjectDetail/Runs.jsx?t=1700:42:31)
    at renderWithHooks (http://localhost:3000/node_modules/.vite/deps/react-dom_client.js?v=abc:5650:22)`

test('rewrites stack frames to short source paths', () => {
  assert.match(cleanStack(stack, origin), /at Runs \(src\/pages\/Projects\/ProjectDetail\/Runs\.jsx:42:31\)/)
})

test("finds the first frame in the app's own code", () => {
  const depsFirst = stack.split('\n').reverse().join('\n')
  assert.equal(appFrame(depsFirst, origin), 'src/pages/Projects/ProjectDetail/Runs.jsx:42')
})

test('redacts secrets and JWTs from evidence', () => {
  assert.deepEqual(
    redact({ email: 'a@b.co', password: 'pw', input: { apiToken: 't', note: 'Bearer eyJa.eyJb.sig' } }),
    { email: 'a@b.co', password: '[redacted]', input: { apiToken: '[redacted]', note: 'Bearer [jwt]' } }
  )
})

test('treats record ids as one kind of page', () => {
  assert.equal(pathPattern('http://x/projects/10/runs/3?tab=a'), '/projects/:id/runs/:id')
})

test('breaks Rails Server-Timing into database vs other time', async () => {
  process.env.WORKER_API_TOKEN ||= 'x'
  process.env.AGENT_API_TOKEN ||= 'x'
  const { serverBreakdown } = await import('../src/monitors.js')
  const breakdown = serverBreakdown('sql.active_record;dur=6.31, process_action.action_controller;dur=1721.52')
  assert.equal(breakdown.totalMs, 1722)
  assert.equal(breakdown.dbMs, 6)
  assert.match(breakdown.diagnosis, /external services/)
})

test('normalizes object dumps so the same error groups together', async () => {
  const { normalizeMessage } = await import('../src/text.js')
  const a = "undefined local variable or method `etete' for #<Queries::Dashboard::Coverage:0x000072e18bf9ed38 @object=nil, @context=#<GraphQL::Query::Context ...>, @field=#<X>>"
  const b = "undefined local variable or method `etete' for #<Queries::Dashboard::Coverage:0x000072e1c0938c70 @object=nil, @context=#<GraphQL::Query::Context ...>, @field=#<X>>"
  assert.equal(normalizeMessage(a), "undefined local variable or method `etete' for #<Queries::Dashboard::Coverage>")
  assert.equal(normalizeMessage(a), normalizeMessage(b))
})

test('names the view a finding happened in: page kind plus the tab clicked', async () => {
  const { viewKey } = await import('../src/text.js')
  assert.equal(viewKey('http://x/projects/10', ['Open http://x/projects/10', 'Click "Issues"']), '/projects/:id › Issues')
  assert.equal(viewKey('http://x/projects/10', ['Open http://x/projects/10']), '/projects/:id')
})
