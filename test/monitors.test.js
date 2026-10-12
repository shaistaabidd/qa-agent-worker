import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.WORKER_API_TOKEN ||= 'x'
process.env.AGENT_API_TOKEN ||= 'x'
const { replayable } = await import('../src/monitors.js')

const request = (method, body, url = 'http://api/graphql') => ({ method: () => method, url: () => url, postData: () => body })

test('only read-only requests are ever replayed', () => {
  assert.equal(replayable(request('GET', null, 'http://api/items')), true)
  assert.equal(replayable(request('POST', JSON.stringify({ query: 'query Coverage { coverage { id } }' }))), true)
  assert.equal(replayable(request('POST', JSON.stringify({ query: '{ me { id } }' }))), true)
  assert.equal(replayable(request('POST', JSON.stringify({ query: 'mutation Approve { approve { id } }' }))), false)
  assert.equal(replayable(request('POST', JSON.stringify([{ query: 'query A { a }' }, { query: 'mutation B { b }' }]))), false)
  assert.equal(replayable(request('POST', '{"items":[1]}', 'http://api/items')), false)
})
