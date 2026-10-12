# qa-agent-worker

Runs QA Agent test runs in a real browser (Playwright + Chromium) and reports
what breaks back to `qa-agent-backend`.

## What a run does

1. The backend `POST`s a run to `/runs` (Bearer `WORKER_API_TOKEN`). The
   worker answers `202` right away and works in the background.
2. It exchanges the run's one-time `credential_fetch_token` for the role's
   login (`resolveRoleCredential`).
3. It opens the target URL, finds the login form (on the page or a common path
   like `/login`), and logs in. If login fails, it reports a **high** finding
   and ends the run as `BLOCKED`.
4. It explores the app breadth-first, up to `MAX_PAGES` pages: the feature's
   page (skipped when the route is an API endpoint such as `/graphql`), the
   page it lands on after login, and every same-site link it finds. On each
   kind of page (`/projects/:id` counts once) it clicks up to
   `MAX_CLICKS_PER_PAGE` safe controls — tabs, toggles, menus, "View",
   "New …" (modals are closed, never submitted). Anything that looks like it
   changes data (save, delete, create, approve, connect, pay, log out…) and
   anything inside a form is never clicked.
5. It reports, with Sentry-style evidence:
   - **Errors**: uncaught exceptions (stack trace cleaned to `src/file.jsx:line`
     and the first frame in your own code), console errors, React warnings,
     GraphQL `errors`, blank screens and "something went wrong" pages
   - **Network**: HTTP 4xx/5xx with the request, (redacted) variables and
     response body; failed requests
   - **Backend** (needs the probe, below): exceptions raised in the app's own
     code — unhandled ones and ones the app rescues and hides — with the
     server backtrace, for requests *and* Sidekiq jobs that ran during the run
   - **Performance** (Scout-style): N+1 queries with the code line (or GraphQL
     field) that triggered them and the fix, slow SQL, too many queries per
     request, API calls slower than `SLOW_REQUEST_MS` with a database-vs-other
     time breakdown, slow TTFB/LCP, layout shift (CLS), long main-thread
     tasks, and the same request fired repeatedly by one view (frontend N+1)
   - **Memory**: server allocations and process growth per request (probe);
     browser JS heap, DOM nodes and event listeners after garbage collection,
     with a leak test that replays a page's clicks twice and flags growth

   Each finding carries repro steps, the breadcrumbs (navigation, clicks,
   requests, console) leading up to it, the pages it was seen on, an
   occurrence count (repeats are grouped, not duplicated), a fingerprint so
   the same issue is tracked across runs, and a full-page screenshot.
   Passwords, tokens and JWTs are redacted from all evidence.

   Severity is triaged at the end: login failures, blank screens, pages that
   don't load, 5xx responses, unhandled backend exceptions and a JS crash on
   3+ pages are **critical**.
6. Findings are sent with `createFinding`, then the run is closed with its
   audit log, full API log (every call with timing, status and the backend's
   SQL/N+1/exception counts) and a summary (`receiveRunResult`: `COMPLETED`,
   `BLOCKED` or `FAILED`).

## Backend probe

Browser-side checks can't see SQL, swallowed exceptions or server memory.
For a Rails backend you control, `qa-agent-backend/lib/qa_probe.rb` records
those per request and per Sidekiq job and tags responses with
`X-QA-Probe-Id`; the worker reads the report with `QA_PROBE_TOKEN`. It's on
in development (set `QA_PROBE_ENABLED=true` elsewhere — staging only, not
production traffic). To use it in another Rails app, copy `lib/qa_probe.rb`,
`lib/qa_probe/` and `config/initializers/qa_probe.rb` (it needs Redis).

## Role credentials

Store each role's login in QA Agent's **Credentials** tab as JSON:

```json
{"email": "admin@example.com", "password": "secret"}
```

`username` works in place of `email`, and `email:password` is accepted too.

## Setup

```bash
npm install
npm run setup          # downloads Chromium (skip with BROWSER_CHANNEL=chrome)
cp .env.example .env   # then fill in both tokens
npm start
```

The tokens must match `qa-agent-backend/config/application.yml`:

| Worker `.env`      | Backend `application.yml` |
|--------------------|---------------------------|
| `WORKER_API_TOKEN` | `AGENT_WORKER_API_TOKEN`  |
| `AGENT_API_TOKEN`  | `AGENT_API_TOKEN`         |

and the backend's `AGENT_WORKER_BASE_URL` must point at this worker
(`http://localhost:4000`). Restart the backend **and Sidekiq** after changing
`application.yml` — runs are dispatched from a Sidekiq job.

Set `HEADLESS=false` to watch the browser while it tests, and
`BROWSER_CHANNEL=chrome` to use the Google Chrome already installed instead of
downloading Playwright's Chromium.

## Limits (v1)

This is a deterministic explorer, not an AI agent: it finds what crashes,
errors, fails or is slow, but it doesn't understand what a feature is supposed
to do, fill in or submit forms, or judge whether results are correct. Stack
traces are readable against a dev server (Vite/webpack); production bundles
would need source maps. Backend detail (SQL, N+1, exceptions, memory) needs
the probe installed in the target backend; without it, only the
`Server-Timing` header (if any) is used.
