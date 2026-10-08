# Event Blueprint — source code

A guided intake that turns any event (a real one or a new idea) into a build-ready brief: 13 sections, reality checks against published benchmarks, a to-scale layout sketch, starter packs, section owners, submission tracking and approvals.

- Live prototype: https://claude.ai/artifact/YYYi9hgRjDz6rENioXcLHG
- Developer handover (architecture, API contract, security, EA-SYS hand-off): `docs/event-blueprint-developer-handover.html` (live version: https://claude.ai/artifact/DL2BqkLdijTfXTXg8gHBtA)

This folder is the version published as **Blueprint version 6** (5 October 2026). `python3 build.py` reproduces the published page byte for byte.

## What's here

```
build.py                 joins src/ into dist/index.html (and dist/test.html for the tests)
src/
  part1.html             markup and all CSS (light and dark themes, phone-first)
  data.js                event types, the 13 sections, examples, avatar options, upload categories
  bench.js               benchmarks with sources, reality checks, planning numbers, layout sketch, starter packs, date/headcount parsing
  platform.js            THE ADAPTER: storage, AI, uploads, identity, downloads, notifications (3 modes)
  app.js                 state, sanitise(), readiness, change tracking, every section's UI, quick fill, submission, tracker, templates, owners
dist/
  index.html             the built page (one self-contained file, ~235 KB, no libraries)
  test.html              same page in a bare shell, used by the tests
tests/
  run_all.py             runs every suite and checks the results (exit 0 = all passed)
  test_*.py              six browser suites (Playwright + Chromium)
  common.py, mock.js     shared helpers; mock.js stands in for the Claude hosting runtime
  fixtures/              a sample PDF programme and a floor-plan image for the quick-fill tests
docs/                    the developer handover (HTML and Markdown)
```

No framework, no npm, no external JavaScript. The only network calls are the adapter's and, when a user drops a PDF into quick fill, pdf.js loaded from cdnjs.

## Build and open it

```
python3 build.py
python3 -m http.server 8000 -d dist     # then open http://localhost:8000
```

Opened like this the page runs in **local mode**: everything is saved in the browser only, AI and uploads are switched off, and the page says so in plain words. That is enough to click through every section.

## The three adapter modes (`src/platform.js`)

| Mode | When | Storage, sign-in, AI, files |
| --- | --- | --- |
| `artifact` | Hosted as a Claude artifact (today) | Claude runtime: `db`, `user`, `sample`, `assets`, `downloads` |
| `api` | `window.EVENT_BLUEPRINT_BACKEND` is set | Your server, via `fetch` with cookies (see below) |
| `local` | Neither | Browser only (`localStorage`) |

To run on MM Group's server, add this before the page's script and implement the endpoints listed in section 4 of the handover (`GET /me`, `GET/PUT /blueprints`, `GET/PUT /templates`, `POST /ai/json`, `POST /files`, `POST /events`):

```html
<script>window.EVENT_BLUEPRINT_BACKEND = { api: 'https://your-domain/api/blueprint', ai: true, files: true };</script>
```

The server holds the Claude API key, checks the owner on every blueprint write, and on `POST /events` with `type: 'submitted'` creates or updates the event in EA-SYS. Nothing else in the page changes.

**State** is one plain object per blueprint (`v: 2`), saved whole on every change. Every load, template and AI answer passes through `sanitise()` in `app.js`, which rebuilds it field by field with fixed types and lengths — keep that on the server path too.

## Tests

```
pip install -r requirements-test.txt
python3 -m playwright install chromium
python3 build.py
python3 tests/run_all.py                 # all suites, about 1–2 minutes
python3 tests/run_all.py owners round3   # just some suites
```

| Suite | Covers |
| --- | --- |
| `test_flow` | Quick fill from typed text, a PDF and an image; submission with reference; change tracking; build-team approval; templates; device-only mode |
| `test_checks_sketch` | Starter packs, reality checks per section, accept/reopen, layout sketch (drag, rotate, keyboard, PNG), the brief |
| `test_security` | Planted markup in templates and blueprints cannot run; other people's templates are not listed |
| `test_checks_edge` | Accepted checks reopen when worse, duplicate space names, date reading |
| `test_owners` | Section owners: validation, steps badges, table, brief, change list, sanitising |
| `test_round3` | Typing stays smooth with 40 spaces and 300 partners at 4x slower CPU, owner form keys and focus, tap targets, long names |

Notes:

- The tests serve `dist/` on local ports 8766 and 8791, and use `tests/mock.js` in place of the Claude runtime (sign-in, shared storage, AI answers and uploads are faked; AI answers are canned).
- The PDF test loads pdf.js from cdnjs. Offline, point `PDFJS_DIR` at a local `pdfjs-dist/build` folder (`npm i pdfjs-dist@6.2.108`).
- Some reality checks depend on today's date (for example "2 months to go"); the runner only checks date-independent results.
