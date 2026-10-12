const PASSWORD_FIELD = 'input[type="password"]'
const LOGIN_FIELD = [
  'input[type="email"]',
  'input[autocomplete="username"]',
  'input[name*="email" i]',
  'input[name*="user" i]',
  'input[name*="login" i]',
  'input[id*="email" i]',
  'input[type="text"]',
].join(', ')
const SUBMIT_BUTTON = 'button[type="submit"], input[type="submit"], button:not([type])'
const COMMON_LOGIN_PATHS = ['/login', '/sign_in', '/signin', '/users/sign_in', '/auth/login']
const ERROR_MESSAGE = '[role="alert"], .alert, .error, .invalid-feedback, .flash, .notice'

const visible = async (locator) => (await locator.count()) > 0 && locator.first().isVisible()

// Finds a login form (on the landing page or a common login path), fills it
// and submits. Returns { status: 'logged_in' | 'no_login_form' | 'failed', ... }.
export async function logIn(page, targetUrl, credential, log) {
  if (!(await visible(page.locator(PASSWORD_FIELD)))) {
    for (const path of COMMON_LOGIN_PATHS) {
      await page.goto(new URL(path, targetUrl).href, { waitUntil: 'networkidle' }).catch(() => null)
      if (await visible(page.locator(PASSWORD_FIELD))) break
    }
  }

  const password = page.locator(PASSWORD_FIELD).first()
  if (!(await visible(password))) {
    log('No login form found; continuing without logging in', page.url())
    await page.goto(targetUrl, { waitUntil: 'networkidle' }).catch(() => null)
    return { status: 'no_login_form' }
  }

  const form = page.locator('form', { has: password }).first()
  const scope = (await form.count()) > 0 ? form : page
  const loginUrl = page.url()

  await scope.locator(LOGIN_FIELD).first().fill(credential.login)
  log('Filled login field', LOGIN_FIELD)
  await password.fill(credential.password)
  log('Filled password field', PASSWORD_FIELD)

  const submit = scope.locator(SUBMIT_BUTTON).first()
  if (await visible(submit)) {
    await submit.click()
    log('Clicked submit', SUBMIT_BUTTON)
  } else {
    await password.press('Enter')
    log('Pressed Enter in password field', PASSWORD_FIELD)
  }

  // Logged in once the password field goes away (SPA) or we navigate off the
  // login page (server-rendered). Errors usually leave both in place.
  await Promise.race([
    password.waitFor({ state: 'detached', timeout: 15_000 }),
    page.waitForURL((url) => url.href !== loginUrl, { timeout: 15_000 }),
  ]).catch(() => null)
  await page.waitForLoadState('networkidle').catch(() => null)

  if (await visible(page.locator(PASSWORD_FIELD))) {
    const message = await page
      .locator(ERROR_MESSAGE)
      .first()
      .innerText({ timeout: 1_000 })
      .catch(() => null)
    log('Login failed', message || 'login form still shown after submitting')
    return { status: 'failed', loginUrl, message }
  }

  log('Logged in', page.url())
  return { status: 'logged_in', loginUrl }
}
