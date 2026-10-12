import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { config } from './config.js'
import { executeRun } from './runner.js'

const REQUIRED_FIELDS = ['run_id', 'target_url', 'role_name', 'scope_feature', 'callback_url', 'credential_fetch_token']

const queue = []
let active = 0

const drain = () => {
  while (active < config.maxConcurrentRuns && queue.length > 0) {
    const job = queue.shift()
    active += 1
    executeRun(job)
      .catch((error) => console.error(`[run ${job.run_id}] unexpected error: ${error.stack}`))
      .finally(() => {
        active -= 1
        drain()
      })
  }
}

const authorized = (request) => {
  const expected = Buffer.from(`Bearer ${config.workerApiToken}`)
  const given = Buffer.from(request.headers.authorization || '')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const readJson = async (request) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const send = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    return send(response, 200, { ok: true, activeRuns: active, queuedRuns: queue.length })
  }
  if (request.method !== 'POST' || request.url !== '/runs') return send(response, 404, { error: 'Not found' })
  if (!authorized(request)) return send(response, 401, { error: 'Unauthorized' })

  let job
  try {
    job = await readJson(request)
  } catch {
    return send(response, 400, { error: 'Body must be JSON' })
  }
  const missing = REQUIRED_FIELDS.filter((field) => job[field] == null)
  if (missing.length > 0) return send(response, 422, { error: `Missing: ${missing.join(', ')}` })

  // The backend waits at most 10s for this response, so accept now and run
  // in the background; results go back through the callback URL.
  queue.push(job)
  drain()
  console.log(`[run ${job.run_id}] accepted (${active} running, ${queue.length} queued)`)
  return send(response, 202, { accepted: true, runId: job.run_id })
})

server.listen(config.port, () => console.log(`qa-agent-worker listening on http://localhost:${config.port}`))
