const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|credential|api[-_]?key|cookie|session/i
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g

export const truncate = (text, max) => {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export const oneLine = (text, max = 120) => truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), max)

// Error messages often embed object dumps with memory addresses, e.g.
// "for #<Queries::Coverage:0x0000712a… @object=nil, @context=#<…>>", which
// differ on every request. Collapsing them to "#<Queries::Coverage>" keeps the
// same error grouped as one issue (and makes titles readable).
export const normalizeMessage = (text) => {
  let message = String(text ?? '')
  const start = /#<([A-Z][\w:]*):0x[0-9a-f]+/i
  for (let match = message.match(start); match; match = message.match(start)) {
    let depth = 0
    let end = match.index
    for (; end < message.length; end += 1) {
      if (message[end] === '<') depth += 1
      if (message[end] === '>' && --depth === 0) break
    }
    message = `${message.slice(0, match.index)}#<${match[1]}>${message.slice(end + 1)}`
  }
  return message.replace(/0x[0-9a-f]{8,}/gi, '0x…')
}

// Strips passwords, tokens and JWTs from anything about to leave the browser
// as evidence (request variables, response bodies, console text).
export const redact = (value, depth = 0) => {
  if (depth > 6) return '[…]'
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[redacted]' : redact(item, depth + 1)])
    )
  }
  if (typeof value === 'string') return truncate(value.replace(JWT, '[jwt]'), 500)
  return value
}

export const redactText = (text, max) => truncate(String(text ?? '').replace(JWT, '[jwt]'), max)

// "http://localhost:3000/src/pages/Foo.jsx?t=123" -> "src/pages/Foo.jsx"
export const shortUrl = (url, origin) => {
  try {
    const parsed = new URL(url)
    return parsed.origin === origin ? parsed.pathname.replace(/^\//, '') : `${parsed.host}${parsed.pathname}`
  } catch {
    return url
  }
}

export const pathOf = (url) => {
  try {
    const parsed = new URL(url)
    return parsed.pathname + parsed.search
  } catch {
    return url
  }
}

// "/projects/10/runs/3" -> "/projects/:id/runs/:id", so the same view on
// different records is treated as one page when deciding what to click.
export const pathPattern = (url) => pathOf(url).split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id')

// The "view" a finding belongs to — a kind of page plus the control clicked
// on it ("/projects/:id › Issues"). Runs report which views they reached, so
// the backend only resolves an issue when a run actually got back to it.
export const viewKey = (url, trail = []) => {
  const click = [...trail].reverse().find((step) => /^Click "/.test(step))
  const label = click?.match(/^Click "(.*)"$/)?.[1]
  return label ? `${pathPattern(url)} › ${label}` : pathPattern(url)
}

// Rewrites stack frames to short "src/file.jsx:line:col" form and drops
// dependency noise, keeping the frames that point at the app's own code.
export const cleanStack = (stack, origin) => {
  if (!stack) return null
  const lines = String(stack)
    .split('\n')
    .map((line) =>
      line.replace(/(https?:\/\/[^\s)?]+)(?:\?[^\s:)]*)?:(\d+):(\d+)/g, (_, url, line, col) => {
        return `${shortUrl(url, origin)}:${line}:${col}`
      })
    )
  return truncate(lines.join('\n'), 4000)
}

// The first stack frame in the app's own code (not node_modules / Vite deps).
export const appFrame = (stack, origin) => {
  const cleaned = cleanStack(stack, origin)
  if (!cleaned) return null
  const frame = cleaned
    .split('\n')
    .map((line) => line.match(/([\w./@-]+\.(?:jsx?|tsx?|mjs|vue|svelte)):(\d+):\d+/))
    .find((match) => match && !/node_modules|\.vite\/deps|^@vite|^@react-refresh/.test(match[1]))
  return frame ? `${frame[1]}:${frame[2]}` : null
}
