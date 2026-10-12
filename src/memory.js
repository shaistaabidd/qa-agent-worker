import { config } from './config.js'

// Browser memory via the Chrome DevTools Protocol: JS heap after a forced
// garbage collection (so only memory still referenced counts), DOM nodes and
// event listeners — the usual suspects in single-page-app leaks.
export async function openMemoryProbe(page) {
  let session
  try {
    session = await page.context().newCDPSession(page)
    await session.send('Performance.enable')
  } catch {
    return null // not a Chromium browser
  }

  return {
    async measure() {
      try {
        await session.send('HeapProfiler.collectGarbage')
        const { metrics } = await session.send('Performance.getMetrics')
        const metric = (name) => metrics.find((m) => m.name === name)?.value ?? null
        return {
          heapMb: Math.round(((metric('JSHeapUsedSize') ?? 0) / 1024 / 1024) * 10) / 10,
          nodes: metric('Nodes'),
          listeners: metric('JSEventListeners'),
          documents: metric('Documents'),
        }
      } catch {
        return null
      }
    },
  }
}

// Compares memory before and after repeating the same interactions. The
// first pass warms caches, so growth on the *second* pass suggests a leak.
export function checkLeak(before, after, { where, steps, evidence, add }) {
  if (!before || !after) return
  const heapGrowth = Math.round((after.heapMb - before.heapMb) * 10) / 10
  const nodeGrowth = (after.nodes ?? 0) - (before.nodes ?? 0)
  const listenerGrowth = (after.listeners ?? 0) - (before.listeners ?? 0)

  const leaks = []
  if (heapGrowth >= config.leakHeapMb) leaks.push(`JS heap +${heapGrowth} MB`)
  if (nodeGrowth >= config.leakNodes) leaks.push(`DOM nodes +${nodeGrowth}`)
  if (listenerGrowth >= config.leakListeners) leaks.push(`event listeners +${listenerGrowth}`)
  if (leaks.length === 0) return

  add({
    fingerprint: `leak:${where}`,
    title: `Possible memory leak on ${where}: ${leaks.join(', ')} after repeating the same clicks`,
    severity: heapGrowth >= config.leakHeapMb * 4 ? 'high' : 'medium',
    category: 'memory',
    reproSteps: steps(
      `Repeating the same interactions keeps growing memory even after garbage collection (${leaks.join(', ')}) — something keeps references alive (listeners, timers, caches or subscriptions not cleaned up on unmount)`
    ),
    details: evidence({ type: 'browser_memory_leak', memoryBefore: before, memoryAfter: after }),
  })
}

export function checkHeapSize(sample, { where, steps, evidence, add }) {
  if (!sample || sample.heapMb < config.maxHeapMb) return
  add({
    fingerprint: `heap:${where}`,
    title: `High browser memory on ${where}: ${sample.heapMb} MB JS heap`,
    severity: sample.heapMb >= config.maxHeapMb * 2 ? 'high' : 'medium',
    category: 'memory',
    reproSteps: steps(`The page holds ${sample.heapMb} MB of JavaScript memory after garbage collection`),
    details: evidence({ type: 'browser_heap', memory: sample }),
  })
}
