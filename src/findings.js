const MAX_PAGES_PER_FINDING = 20

// Groups findings by fingerprint, like Sentry issues: the same error on many
// pages (or many times on one) becomes one finding with an occurrence count
// and the list of pages it happened on.
export class FindingCollector {
  #byFingerprint = new Map()
  #titles = new Set()
  // While true (leak-test replays), repeats of known findings aren't counted
  // as new occurrences; genuinely new problems are still recorded.
  replaying = false

  add({ fingerprint, title, severity, category, reproSteps, details = {} }) {
    const key = fingerprint || title
    const existing = this.#byFingerprint.get(key)
    if (existing) {
      if (this.replaying) return existing
      existing.details.occurrences += 1
      const pages = existing.details.pages
      if (details.pageUrl && !pages.includes(details.pageUrl) && pages.length < MAX_PAGES_PER_FINDING) {
        pages.push(details.pageUrl)
      }
      if (details.durationMs != null) existing.details.samplesMs?.push(details.durationMs)
      return existing
    }

    const finding = {
      fingerprint: key,
      title: this.#uniqueTitle(title),
      severity,
      category,
      reproSteps,
      screenshot: undefined,
      details: {
        ...details,
        occurrences: 1,
        pages: details.pageUrl ? [details.pageUrl] : [],
        ...(details.durationMs != null && { samplesMs: [details.durationMs] }),
      },
    }
    this.#byFingerprint.set(key, finding)
    return finding
  }

  // Findings that haven't had a screenshot taken yet — i.e. the ones that
  // happened on the view currently open.
  withoutScreenshot() {
    return this.all().filter((finding) => finding.screenshot === undefined)
  }

  all() {
    return [...this.#byFingerprint.values()]
  }

  // Titles are unique per run on the backend (and truncated to fit).
  #uniqueTitle(title) {
    const base = title.length > 240 ? `${title.slice(0, 239)}…` : title
    let candidate = base
    for (let n = 2; this.#titles.has(candidate); n += 1) candidate = `${base} (${n})`
    this.#titles.add(candidate)
    return candidate
  }
}
