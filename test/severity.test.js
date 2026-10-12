import { test } from 'node:test'
import assert from 'node:assert/strict'
import { triage } from '../src/severity.js'

const finding = (severity, details) => ({ title: 't', severity, details })

test('blocking problems are always critical', () => {
  for (const type of ['login_failed', 'blank_page', 'page_load_failed', 'backend_unhandled_exception']) {
    assert.equal(triage(finding('medium', { type })).severity, 'critical', type)
  }
})

test('5xx responses are critical, 4xx keep their severity', () => {
  assert.equal(triage(finding('high', { type: 'http_error', request: { status: 502 } })).severity, 'critical')
  assert.equal(triage(finding('medium', { type: 'http_error', request: { status: 404 } })).severity, 'medium')
})

test('a JS crash on 3+ pages is critical', () => {
  assert.equal(triage(finding('high', { type: 'uncaught_exception', pages: ['a', 'b'] })).severity, 'high')
  assert.equal(triage(finding('high', { type: 'uncaught_exception', pages: ['a', 'b', 'c'] })).severity, 'critical')
})

test('a swallowed backend exception that keeps happening is escalated', () => {
  assert.equal(triage(finding('medium', { type: 'backend_handled_exception', occurrences: 5 })).severity, 'high')
})
