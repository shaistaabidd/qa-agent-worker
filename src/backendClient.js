// Talks to qa-agent-backend's GraphQL API as the trusted worker (X-Agent-Token).
export class BackendClient {
  constructor({ callbackUrl, agentApiToken }) {
    this.callbackUrl = callbackUrl
    this.agentApiToken = agentApiToken
  }

  // Exchanges the single-use token from the dispatch payload for the raw
  // credential, only at the moment the worker needs to log in.
  async resolveRoleCredential(token) {
    const data = await this.#graphql(
      'query ResolveRoleCredential($token: String!) { resolveRoleCredential(token: $token) }',
      { token }
    )
    return data.resolveRoleCredential
  }

  async createFinding({ runId, title, reproSteps, severity, category, details, fingerprint, screenshot }) {
    const query = `mutation CreateFinding($input: CreateFindingInput!) {
      createFinding(input: $input) { finding { id } }
    }`
    const input = { runId, title, reproSteps, severity: severity.toUpperCase(), category, details, fingerprint, screenshot: null }
    if (!screenshot) return this.#graphql(query, { input })

    // GraphQL multipart request spec (apollo_upload_server on the backend).
    const form = new FormData()
    form.append('operations', JSON.stringify({ query, variables: { input } }))
    form.append('map', JSON.stringify({ 0: ['variables.input.screenshot'] }))
    form.append('0', new Blob([screenshot], { type: 'image/png' }), 'screenshot.png')
    return this.#send(form)
  }

  async receiveRunResult({ runId, status, auditLogEntries, networkLog, summary }) {
    return this.#graphql(
      `mutation ReceiveRunResult($input: ReceiveResultInput!) {
        receiveRunResult(input: $input) { run { id status } }
      }`,
      { input: { runId, status: status.toUpperCase(), auditLogEntries, networkLog, summary } }
    )
  }

  #graphql(query, variables) {
    return this.#send(JSON.stringify({ query, variables }), { 'Content-Type': 'application/json' })
  }

  async #send(body, headers = {}) {
    const response = await fetch(this.callbackUrl, {
      method: 'POST',
      headers: { 'X-Agent-Token': this.agentApiToken, ...headers },
      body,
    })
    const json = await response.json().catch(() => null)
    if (!response.ok || !json || json.errors?.length) {
      const message = json?.errors?.map((e) => e.message).join('; ') || `HTTP ${response.status}`
      throw new Error(`Backend rejected request: ${message}`)
    }
    return json.data
  }
}
