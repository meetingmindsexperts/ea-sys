# EA-SYS — Dependency Log

Every dependency change that reached `main`, newest first: what moved, why, how
it was verified, how to roll it back, and what was left open. The how-to for
performing an upgrade is [UPGRADE_GUIDE.md](UPGRADE_GUIDE.md); this file is the
record of the ones that happened. Planned production changes that are not
dependency work live in [MAINTENANCE_LOG.md](MAINTENANCE_LOG.md).

Two rules carry the log. **Security-driven bumps record the exposure, not just
the CVE**: whether the vulnerable code path is reachable in EA-SYS decides
whether it was urgent, and that reasoning is what an assessor asks for. **Every
entry names the e2e baseline it was diffed against**, because the e2e suite
carries pre-existing failures and a bare failure count proves nothing.

---

## DEP-005: `archiver` added, for the on-demand zip of the uploads mirror

| | |
|---|---|
| **Date** | 2026-09-11 |
| **Trigger** | Owner request: "download all S3 mirror backups". The chosen shape is an on-demand archive built by the worker, so the operator gets one zip of the whole Singapore uploads mirror rather than 600 presigned links |
| **What moved** | `archiver` 8.0.0 (production) and `@types/archiver` 8.0.0 (dev), both pinned exact. `jszip` was already here but holds every entry in memory; the mirror is 165 MB today and will grow, so the builder streams entries through `archiver` into a temp file and uploads that with a known length. `jszip` is used only by the test that unzips the produced archive to check its entries |
| **Why a dependency at all** | The zip container format is not in Node's standard library, and hand-writing central directories is how you produce archives that open on one platform and not another. `archiver` is the maintained streaming implementation with no native code and no network use |
| **Exposure** | Runs only in the worker container, only when an operator has pressed "Build archive" (a row in `MirrorArchive`), reading the DR bucket the box's role already reads and writing one object under `mirror-archives/`. It never sees request input. `npm audit`: no advisory names `archiver` or its tree |
| **Verification** | 11 CI gate scripts 0 · lint 0 · tsc 0 · vitest (the builder test runs the real archiver on fake S3 streams and unzips the result with jszip, asserting every mirrored path is inside) · `next build` clean. The first real build runs on production after deploy, from the page, and is reported by the worker's `mirror-archive:build-done` line with file count, bytes and duration |
| **Rollback** | Revert the commit and redeploy (the `MirrorArchive` table is additive and can stay), or the pinned image rollback in [ROLLBACK.md](ROLLBACK.md) |

---

## DEP-004: `@aws-sdk/s3-request-presigner` added, for the backups page's download links

| | |
|---|---|
| **Date** | 2026-09-11 |
| **Trigger** | Owner request: a simple UI to see the S3 backups without the AWS console (`/admin/backups`). Downloading a database dump needs a presigned S3 link, so the bytes go straight from S3 to the operator's browser and never pass through the box |
| **What moved** | `@aws-sdk/s3-request-presigner` added at exactly 3.1086.0, the version of the `@aws-sdk/client-s3` already installed, so the two share every transitive and no second SDK core lands. Nothing else changed |
| **Why a dependency at all** | Signing an S3 GET by hand is the SigV4 canonical-request dance, which is ~100 lines that break silently when a header is normalised differently. The presigner is the SDK's own implementation of it, from the same publisher and release train as the client we already use |
| **Exposure** | Server-only, reachable from exactly one route, `POST /api/admin/backups`, behind `denyNonOperator` (SUPER_ADMIN on master) with a 10/hour limit, and only for keys matching the pg_dump shape under `db/`. Every link minted writes an EXPORT audit row. `npm audit`: the presigner appears in no advisory chain. The audit total moved from 41 (DEP-002) to 43, and the difference is NOT this package: a **critical** advisory on `next` 16.2.11 was published in the meantime (unauthenticated RCE on Windows-hosted servers; fixed in 16.3.4). Production runs Linux containers, so that vector does not apply as written, but it moves the Next 16.3 decision below from "when convenient" to "next" |
| **Verification** | 11 CI gate scripts 0 · lint 0 · tsc 0 · vitest (17 new tests: the 72h window, key guard, presign shape, route boundary + audit + rate limit) · `next build` clean · the page opened on the production standalone against the local copy |
| **Rollback** | Revert the commit (package.json + lockfile + the route, page and aws-ops section) and redeploy, or the pinned image rollback in [ROLLBACK.md](ROLLBACK.md) |

---

## DEP-003 — `docx` added, for the Word exports of abstracts and session proposals

| | |
|---|---|
| **Date** | 2026-09-10 |
| **Trigger** | Organiser request: export all abstracts into one Word document and all session proposals into another. The two CSV exports that shipped the day before answer a spreadsheet need; a review committee reads prose |
| **What moved** | `docx` 9.7.1 added as a production dependency. Nothing else changed; `npm ls` shows its five transitives (`jszip` 3.10, `xml`, `xml-js`, `nanoid` 5, `hash.js`) with no duplicate majors against anything already installed |
| **Why a dependency at all** | The alternative was hand-writing WordprocessingML through `pizzip`, which is already here for the speaker-agreement merge. About 150 lines, and every one of them is a chance to emit XML that Word opens with a repair prompt. `docx` is the standard pure-JS builder for exactly this, has no native code and makes no network calls |
| **Exposure** | Server-only, and reachable from exactly two routes, both behind `denyReviewer` with no allow-list (SUPER_ADMIN / ADMIN / ORGANIZER). It reads no input beyond the rows those routes already load and writes to no disk. `npm audit` on the added tree: no new findings |
| **Verification** | 11 CI gate scripts 0 · lint 0 · tsc 0 · vitest (46 new tests: builder, mappers, both routes) · `next build` clean. The builder tests unzip the produced package with `pizzip` and read `word/document.xml`, so what is asserted is what Word opens, not our own data structure. Both documents were then exported from the local prod copy and opened in Microsoft Word on the development Mac |
| **Rollback** | Revert the commit (package.json + lockfile + the two routes) and redeploy, or the pinned image rollback in [ROLLBACK.md](ROLLBACK.md) |

---

## DEP-002 — Auth.js criticals, patch-level sweep, dead Postmark package

| | |
|---|---|
| **Date** | 2026-09-07 |
| **Trigger** | `npm audit` read 77 findings (3 critical, 21 high, 50 moderate, 3 low), 75 of them on the production path. All three criticals were one thing: `@auth/core` ≤ 0.41.2, reached through `next-auth` 5.0.0-beta.30 and `@auth/prisma-adapter` 2.11.1. Owner: "do it, but test thoroughly and maintain a log" |
| **What moved** | `next-auth` beta.30 → beta.32 · `@auth/core` 0.41.1 → 0.41.3 (a second nested 0.41.0 copy removed) · `@auth/prisma-adapter` 2.11.1 → 2.11.3 · `@sentry/nextjs` 10.48.0 → 10.73.0 with its family · `mailparser` 3.9.14 → 3.9.23 (`html-to-text` 10.0.0 → 10.0.1, which brings `deepmerge-ts` 8.0.2 in beside the 7.1.5 that Prisma still pins) · `uuid` 13.0.0 → 13.0.2 · `@tiptap/*` 2.27.2 → 2.27.3 · `@types/node` ^20 → ^24 (24.13.3, matching the Node 24 engine) · `postmark` removed (its code path has been commented out since 2026-05-21) · `@zoom/meetingsdk` pinned exact at 6.0.0 (installed version unchanged; the July report decided this and never shipped it). Transitives: `axios` 1.15 → 1.20, `undici`, `ws` 8.20 → 8.21.3, `dompurify` 3.4.0 → 3.4.15, `@xmldom/xmldom` 0.9.9 → 0.9.12, `@smithy/core` 3.29 → 3.33 (no duplicate versions; all inside the ranges the AWS clients declare). Totals: 148 packages changed, 70 removed, 18 added. **Deliberately not moved**: `@modelcontextprotocol/sdk` 1.29.0, `openai` 7.4.0, `@supabase/supabase-js` 2.103.0, `isomorphic-dompurify` 3.8.0, since their vulnerable transitives were fixed in place |
| **Exposure of the criticals** | None reachable. "Config errors make `auth()` fail open" needs a broken Auth.js config plus a bare `if (req.auth)` check: `NEXTAUTH_SECRET` is in the required-at-boot list and every one of our 369 session checks reads `.user`, which the advisory itself lists as the safe pattern. The email-normaliser homoglyph bypass lives in the Email provider; we run Credentials only and resolve the user ourselves. The OAuth check-cookie binding needs OAuth providers; we have none (our MCP OAuth server is separate code). The bundled `getToken()` high: we never call it. Patched because the fix is two patch-level bumps and the audit line would otherwise be explained four times per assessor |
| **Result** | `npm audit` 77 → 41 (0 critical, 6 high, 35 moderate, 0 low); production path 75 → 41. Every remaining item is in the decisions table below (Next 16.3 for `postcss`/`sharp`, Prisma's unfixable `deepmerge-ts` 7, Tiptap 3, the Anthropic SDK major) |
| **Compatibility** | Peer ranges read from the registry for the exact resolved versions: `next-auth` wants `next ^16` and `react ^19`, the adapter wants `@prisma/client >=6`, Sentry wants `next ^16`, the MCP SDK and `openai` want `zod ^3.25 || ^4` (we have 4.3.6), `supabase-js` wants Node ≥ 22, `@types/node` 24 against TypeScript 5.9.3. `npm ls` clean apart from the two expected Linux-only optional binaries; `npm ci --dry-run` accepts the lockfile. The Zoom SDK's nested `react@18.2.0` is unchanged |
| **Known-issue research** | `next-auth` beta.32 shipped 2026-07-20; no regression threads in seven weeks, and its one behaviour change (a non-OK session response now yields `null` instead of an error object) is what our code already assumed. **Sentry**: getsentry/sentry-javascript#19367 (Next 16 + Turbopack duplicating `@opentelemetry/api` across chunks, sporadic `Maximum call stack size exceeded`) was reported on 10.38, closed as not reproducible; we ran 10.48 in production without it. 10.64 switched Node to Sentry's minimal OpenTelemetry tracer provider by default (opt-out: `openTelemetryBasicTracerProvider: true`); we trace at `tracesSampleRate: 0.1`, so **watch the error rate and event-loop lines for 48 h after deploy**. 10.66 deprecated `@sentry/node-core` (not imported by us). The build now prints one deprecation: import `withSentryConfig` from `@sentry/nextjs/config` (stops working in v11), a one-line follow-up. **mailparser** 3.9.16 bounded linkify scanning of untrusted text bodies (hardening we want on the CRM inbox), 3.9.19 added CP932 charset areas, 3.9.21/23 moved its internal nodemailer to 10; the inbox renders parsed HTML inside a `sandbox=""` iframe, so parser output is never executed. **dompurify** 3.4.15 (2026-09-06) closes the IN_PLACE and hook-pollution advisories; we use `ALLOWED_TAGS` / `ALLOWED_ATTR` / `ADD_ATTR` only, no hooks, no IN_PLACE. `html-to-text` 10.0.1 is a dependency bump only |
| **Verification** | 11 CI gate scripts 0 · lint 0 · tsc 0 · vitest 474 files / 6,811 tests · `next build` clean. **E2E baseline-diffed**: the current tree was built and run as the production standalone on a spare port against the local `ea_sys_test` database (your dev server untouched), then the upgraded tree the same way. Baseline 57 pass / 21 fail / 22 did not run; after 58 / 20 / 22. Keyed on spec location plus title: **0 regressions, 20 failures byte-identical, 1 flaky recovered** (admin-smoke event-link visibility). The pre-existing failures are: certificate routes answering 403 to the seeded admin (12), tenancy-shots needing the `:3114` sandbox (2), screenshot chapters timing out without the docs seed (4), copy drift on the submitter heading (1), the bulk-email dialog (1); the 22 that did not run are serial siblings behind those. **Direct sign-in smoke** on the upgraded build with curl: wrong password → `CredentialsSignin` redirect and a `null` session (fail-closed); right password → session cookie, `ADMIN` session, `200` on `/api/events`; no cookie → `401`. **mailparser smoke** on a multipart reply (quoted-printable body, encoded subject, PDF attachment): every field parsed. **Not run locally**: `test:crm-db` (its harness database on 55434 was not up) and `test:tenancy`; CI runs both |
| **Rollback** | Revert the commit (package.json + lockfile) and redeploy, or the pinned image rollback in [ROLLBACK.md](ROLLBACK.md) (~22 s) |

### What the run found

- The local e2e fixture database (`ea_sys_test`, the machine's own Postgres on 5432, not the prod copy on 54322) still carried the pre-August RSVP schema, so the suite's own `prisma db push` refused the `RsvpInvite` unique index. Synced once with `--accept-data-loss` behind an assertion that the target was exactly that database. That is the only database anything here wrote to.
- `npm audit fix` fixes transitives in place where it can: four direct packages with vulnerable dependencies stayed at their current versions while the nested copies moved. The audit output names the direct package, which reads as a bigger change than it is.
- `postmark` was still listed under `.env.example`'s historical block and in `next.config.ts` nothing references it; `@getbrevo/brevo` is different, it sits in `transpilePackages`, which is why its removal is a decision below rather than part of this sweep.

**Outstanding:** the Sentry import-path deprecation (one line in `next.config.ts`, needs a rebuild to verify); Dependabot alerts plus a weekly `npm audit` job (owner, Tuesday 2026-09-08); the 48-hour production watch on Sentry; and the decisions table below.

---

## DEP-001 — Next.js 16.1.4 → 16.2.11

| | |
|---|---|
| **Date** | 2026-07-23 (commit `5cb6b088`) |
| **Trigger** | Security. ~30 open Next advisories: middleware/proxy bypass, SSRF in Server Actions and rewrites, request smuggling, cache poisoning, a DoS family |
| **What moved** | `next` 16.1.4 → 16.2.11 and `eslint-config-next` in lockstep. Peer set verified conflict-free: `next-auth` 5.0.0-beta.30, `@sentry/nextjs` 10.48, React 19.2.3 |
| **Verification** | tsc 0, lint 0, 3,668 unit tests, build clean. **E2E baseline-diffed against 16.1.4: 15 failures byte-identical on both versions** (pre-existing suite drift, tracked in ROADMAP), zero regressions attributable to the upgrade |
| **Rollback** | Pin `next` and `eslint-config-next` back to 16.1.4 and redeploy; or the image rollback in [ROLLBACK.md](ROLLBACK.md) |
| **Full record** | [DEPENDENCY_UPGRADES.html](DEPENDENCY_UPGRADES.html) §8 (the Round 1 report; its §3 minors batch stayed PROPOSED and was never applied) |

### What the upgrade found

16.2 changed Turbopack's file tracer: it mirrors the ENTIRE repository into
`.next/standalone` when a module has an env-overridable filesystem root (the
log-archive module does). That is about 65 MB of junk in the image, and a
non-Docker local build even embedded a real `.env`. Both documented
suppressions (`turbopackIgnore`, `outputFileTracingExcludes`) are no-ops under
Turbopack (nextjs#95125). The fix is in the [Dockerfile](../Dockerfile): the
runner stage copies the standalone output by **allow-list** (`server.js`,
`package.json`, `.next`, `node_modules`, then `.next/static` and `public`),
verified by building and booting a local runner image (HTTP 200, zero repo
files, no `.env`). A cosmetic "NFT list" warning remains in build logs and is
noted in `next.config.ts`.

**Outstanding at the time:** none for the upgrade itself. The 15 e2e failures
were pre-existing and stayed in ROADMAP.

---

## Decisions waiting on the owner (state as of 2026-09-11)

**2026-09-11:** `npm audit` now reports a CRITICAL on `next` 16.2.11 (unauthenticated remote code execution on Windows-hosted servers, fixed in 16.3.4; production is Linux, so the published vector does not apply, but a critical on the framework is not something to sit on). The Next 16.3 upgrade below is therefore the first item, and it also clears the `postcss` and `sharp` highs. Same method as DEP-001: standalone on a spare port, e2e diff against the baseline.


| Item | Why it is a decision, not a command |
|---|---|
| `next` 16.2.11 → 16.3.4 | Pinned exact. Clears the remaining `postcss` and `sharp`/libvips highs (sharp decodes uploaded photos through `next/image`, so that one is a real runtime surface). 16.3 deprecates the edge runtime and `experimental.useCache`; `eslint-config-next` moves with it. Needs the full gate plus a browser pass over image-heavy pages, in a maintenance window |
| `prisma` / `@prisma/client` high (`deepmerge-ts` 7) | `@prisma/config` pins `deepmerge-ts@7.1.5` exactly, and so does Prisma 7.10, so no version fixes it. The CLI runs only at deploy (`migrate deploy`) on our own config file. Recommend: accept and record in the posture doc |
| `@tiptap/*` moderate (`mergeAttributes` `__proto__`) | Fix is v3, a migration. The v2 pin's reason in UPGRADE_GUIDE §5 (v3 ships no compiled `dist/`) is no longer true: 3.31.3 ships `dist/index.cjs` + `dist/index.js`. Exposure is an organiser poisoning their own editor content, then sanitised by DOMPurify before it renders elsewhere. Plan as a project |
| `@anthropic-ai/sdk` 0.82 → 0.124 | The flaw is in a local-filesystem memory tool we never call. The bump is a major with churn in the streaming and tool-use calls both agents use. Not security-driven for us |
| `@getbrevo/brevo`, `@sendgrid/mail` | Both code paths have been commented out since 2026-05-21 ("one release cycle"). `@getbrevo/brevo` 3.0.1 is pinned exact and drags `eslint` 8, `axios`, `form-data`, `js-yaml` into production deps. Removing them also removes `transpilePackages: ["@getbrevo/brevo"]` from `next.config.ts` and the `BREVO_API_KEY` line from the box `.env` (currently read by nothing) |
