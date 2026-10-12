// Sentry-like triage on top of each detector's own severity. Critical means
// "users are blocked or the app is broken", not just "something is off".
const ALWAYS_CRITICAL = new Set(['login_failed', 'blank_page', 'page_load_failed', 'backend_unhandled_exception'])

export function triage(finding) {
  const { type, request, occurrences = 1, pages = [] } = finding.details || {}
  let severity = finding.severity

  if (ALWAYS_CRITICAL.has(type)) severity = 'critical'
  // Any 5xx is the server failing outright.
  if (type === 'http_error' && request?.status >= 500) severity = 'critical'
  // A crash that follows the user from page to page breaks the app, not a page.
  if (type === 'uncaught_exception' && pages.length >= 3) severity = 'critical'
  // A swallowed exception that keeps happening is a real bug hiding behind a nice message.
  if (type === 'backend_handled_exception' && occurrences >= 5 && severity === 'medium') severity = 'high'

  return { ...finding, severity }
}
