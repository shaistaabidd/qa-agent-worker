// What the worker may click on its own: anything that only *shows* things
// (tabs, menus, accordions, "View", pagination, opening a modal). Labels that
// suggest changing data, spending money, leaving the session or the site are
// never clicked, and nothing inside a <form> is — forms are left unsubmitted.
export const UNSAFE_LABEL =
  /log ?out|sign ?(out|in|up)|delete|destroy|remove|save|submit|create|dispatch|connect|approve|reject|scan|send|pay|purchase|checkout|order|confirm|install|link|change|update|edit|reset|archive|revoke|disable|enable|upload|import|export|publish|invite|accept|register|add|switch|github|clickup|post\b|run\b|start|stop|cancel|refund|transfer|book/i

const CANDIDATES = '[role="tab"], [role="menuitem"], [aria-expanded], summary, .nav-link, button, [role="button"]'

// Tags each safe, visible control with data-qa-click="<n>" and returns their
// labels in the same order, so they can be clicked one by one.
export const tagClickables = (page) =>
  page
    .evaluate(
      ({ selector, unsafe }) => {
        const unsafeLabel = new RegExp(unsafe, 'i')
        const seen = new Set()
        const labels = []
        document.querySelectorAll('[data-qa-click]').forEach((el) => el.removeAttribute('data-qa-click'))
        for (const el of document.querySelectorAll(selector)) {
          const rect = el.getBoundingClientRect()
          const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden'
          if (!visible || el.disabled || el.getAttribute('aria-disabled') === 'true') continue
          if (el.closest('form') || el.type === 'submit' || el.tagName === 'A') continue
          if (el.getAttribute('aria-selected') === 'true') continue
          const label = (el.innerText || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim()
          if (!label || label.length > 60 || unsafeLabel.test(label) || seen.has(label)) continue
          seen.add(label)
          el.setAttribute('data-qa-click', String(labels.length))
          labels.push(label)
        }
        return labels
      },
      { selector: CANDIDATES, unsafe: UNSAFE_LABEL.source }
    )
    .catch(() => [])

export const collectLinks = (page, origin) =>
  page
    .$$eval('a[href]', (anchors) => anchors.map((a) => ({ href: a.href, text: a.innerText || '' })))
    .then((links) =>
      links
        .map((link) => {
          try {
            const url = new URL(link.href)
            url.hash = ''
            return { url: url.href, text: link.text, sameOrigin: url.origin === origin }
          } catch {
            return null
          }
        })
        .filter((link) => link && link.sameOrigin && !UNSAFE_LABEL.test(link.text) && !UNSAFE_LABEL.test(new URL(link.url).pathname))
        .map((link) => link.url)
    )
    .catch(() => [])
