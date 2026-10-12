const required = (key) => {
  const value = process.env[key]
  if (!value) throw new Error(`${key} is not set — copy .env.example to .env and fill it in`)
  return value
}

export const config = {
  port: Number(process.env.PORT || 4000),
  workerApiToken: required('WORKER_API_TOKEN'),
  agentApiToken: required('AGENT_API_TOKEN'),
  headless: process.env.HEADLESS !== 'false',
  // "chrome" uses the Google Chrome already installed on this machine instead
  // of Playwright's own Chromium download.
  browserChannel: process.env.BROWSER_CHANNEL || undefined,
  maxPages: Number(process.env.MAX_PAGES || 15),
  maxClicksPerPage: Number(process.env.MAX_CLICKS_PER_PAGE || 12),
  maxConcurrentRuns: Number(process.env.MAX_CONCURRENT_RUNS || 2),
  slowRequestMs: Number(process.env.SLOW_REQUEST_MS || 1000),
  repeatedRequestThreshold: Number(process.env.REPEATED_REQUEST_THRESHOLD || 3),
  // Backend probe (qa-agent-backend lib/qa_probe.rb); must match its QA_PROBE_TOKEN.
  probeToken: process.env.QA_PROBE_TOKEN || null,
  maxQueriesPerRequest: Number(process.env.MAX_QUERIES_PER_REQUEST || 30),
  maxAllocatedObjects: Number(process.env.MAX_ALLOCATED_OBJECTS || 500_000),
  maxRssGrowthMb: Number(process.env.MAX_RSS_GROWTH_MB || 50),
  // Browser memory: leak = growth on a repeated pass, after garbage collection.
  leakHeapMb: Number(process.env.LEAK_HEAP_MB || 5),
  leakNodes: Number(process.env.LEAK_NODES || 1_000),
  leakListeners: Number(process.env.LEAK_LISTENERS || 100),
  maxHeapMb: Number(process.env.MAX_HEAP_MB || 150),
  maxNetworkLog: 1_500,
  navigationTimeoutMs: 20_000,
}
