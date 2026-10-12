import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FindingCollector } from '../src/findings.js'

const finding = (overrides = {}) => ({
  fingerprint: 'js:TypeError:x',
  title: 'TypeError: x',
  severity: 'high',
  category: 'error',
  reproSteps: [],
  details: { pageUrl: 'http://app/a' },
  ...overrides,
})

test('groups repeats of the same fingerprint into one finding with occurrences and pages', () => {
  const findings = new FindingCollector()
  findings.add(finding())
  findings.add(finding({ details: { pageUrl: 'http://app/b' } }))
  findings.add(finding({ details: { pageUrl: 'http://app/b' } }))

  assert.equal(findings.all().length, 1)
  assert.equal(findings.all()[0].details.occurrences, 3)
  assert.deepEqual(findings.all()[0].details.pages, ['http://app/a', 'http://app/b'])
})

test('collects duration samples for repeated slow calls', () => {
  const findings = new FindingCollector()
  findings.add(finding({ fingerprint: 'slow:Q', details: { durationMs: 1200 } }))
  findings.add(finding({ fingerprint: 'slow:Q', details: { durationMs: 1500 } }))
  assert.deepEqual(findings.all()[0].details.samplesMs, [1200, 1500])
})

test('keeps titles unique when different fingerprints share one', () => {
  const findings = new FindingCollector()
  findings.add(finding({ fingerprint: 'a' }))
  findings.add(finding({ fingerprint: 'b' }))
  assert.deepEqual(findings.all().map((f) => f.title), ['TypeError: x', 'TypeError: x (2)'])
})

test('truncates long titles to fit the backend column', () => {
  const findings = new FindingCollector()
  findings.add(finding({ title: 'x'.repeat(400) }))
  assert.equal(findings.all()[0].title.length, 240)
})

test('tracks which findings still need a screenshot', () => {
  const findings = new FindingCollector()
  findings.add(finding({ fingerprint: 'one', title: 'one' }))
  findings.withoutScreenshot()[0].screenshot = Buffer.from('png')
  findings.add(finding({ fingerprint: 'two', title: 'two' }))
  assert.deepEqual(findings.withoutScreenshot().map((f) => f.title), ['two'])
})

test('replays do not inflate occurrence counts but still record new problems', () => {
  const findings = new FindingCollector()
  findings.add(finding())
  findings.replaying = true
  findings.add(finding())
  findings.add(finding({ fingerprint: 'new-during-replay', title: 'new' }))
  findings.replaying = false
  assert.equal(findings.all()[0].details.occurrences, 1)
  assert.equal(findings.all().length, 2)
})
