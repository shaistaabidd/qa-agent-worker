// Role credentials are stored as JSON — {"email": "...", "password": "..."} —
// with "username" accepted in place of "email". "email:password" also works.
export const parseCredential = (raw) => {
  try {
    const parsed = JSON.parse(raw)
    const login = parsed.email || parsed.username
    if (login && parsed.password) return { login, password: parsed.password }
  } catch {
    // fall through to the "login:password" form
  }

  const separator = raw.indexOf(':')
  if (separator > 0) return { login: raw.slice(0, separator).trim(), password: raw.slice(separator + 1).trim() }

  throw new Error('Credential must be JSON like {"email": "...", "password": "..."} or "email:password"')
}
