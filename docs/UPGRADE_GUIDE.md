# EA-SYS — Dependency & Framework Upgrade Guide

How to upgrade npm packages and framework versions (Next.js, React, Prisma, etc.)
without breaking prod. Follow the workflow that matches the **risk tier** of the
upgrade.

**Last updated:** 2026-05-22

---

## 1. Current baseline (snapshot — refresh with `npm outdated`)

| Package | Current | Latest | Notes |
|---|---|---|---|
| `next` | 16.1.4 | 16.2.x | App Router + Turbopack |
| `react` / `react-dom` | 19.2.3 | 19.2.x | React 19 — many libs still declare `react@^18` peers |
| `@prisma/client` / `prisma` | 6.19.3 | **7.8.0** | major available — see §6 |
| `next-auth` | 5.0.0-beta.30 | beta | still beta; pin exact, read release notes per bump |
| `@tiptap/*` | 2.27.2 (pinned) | 3.23.6 | **DO NOT bump to v3** — see §5 |
| `eslint` | 9.39.4 | 10.x | major available |
| `lucide-react` | 0.562.0 | 1.16.0 | major (icon renames possible) |
| `@getbrevo/brevo`, `@sendgrid/mail`, `postmark` | pinned | — | **email cut over to SES** — these can be removed (see §5) |
| `@types/node` | 20.x | 25.x | engine is Node 24 — bump to `@types/node@24` to match |
| Node | 24.x (`engines`) | — | EC2 + Docker build target |

Run `npm outdated` for the live gap and `npm audit` for security-driven bumps
(CI blocks high/critical).

---

## 2. Classify the upgrade — risk tiers

| Tier | Example | PR strategy |
|---|---|---|
| **Patch** `x.y.Z` | `prisma 6.19.3 → 6.19.4` | Batch many into one PR |
| **Minor** `x.Y.z` | `@aws-sdk 3.1051 → 3.1052`, `@tanstack/react-query 5.99 → 5.100` | Batch into one PR, run full gate once |
| **Major** `X.y.z` | `eslint 9 → 10`, `lucide-react 0 → 1`, `prisma 6 → 7` | **One PR per major** so a regression bisects to one package |
| **Framework major** | Next 16 → 17, React 19 → 20 | One PR, codemods, deploy to secondary first |

Pre-1.0 packages (`@anthropic-ai/sdk` 0.x, `lucide-react` was 0.x) treat **minor
bumps as potentially breaking** — semver minor on 0.x can break.

---

## 3. The verification gate (run for EVERY upgrade)

Always on a branch, never on `main` (the blue-green deploy pulls `main`):

```bash
git checkout -b chore/upgrade-<thing>

# make the change (see §4), then:
npm ci                 # clean install from the NEW lockfile — surfaces peer-dep breaks
npx prisma generate    # if prisma/@prisma/client changed (build does this too)
npm run type-check     # tsc --noEmit
npm run lint           # eslint
npm run build          # prisma generate && next build (Turbopack) — catches bundler issues
npm run test           # vitest run (~1200 tests)
npm run test:e2e       # playwright — STOP the dev server first (port 3113, see §5)
```

**Why `npm ci` not `npm install`**: `ci` does a clean install strictly from the
lockfile and **fails loudly on peer-dependency conflicts** — the #1 breakage on
this React-19 stack. `npm install` papers over them.

All green → commit (lockfile included) → deploy (§7). Any red → fix or revert
the bump; don't push a half-working lockfile.

---

## 4. Per-tier workflow

### Patch + minor (batched)

```bash
git checkout -b chore/upgrade-minors
npm update                       # bumps everything within existing semver ranges
# or target specific ones:
npm install @tanstack/react-query@latest @sentry/nextjs@latest @supabase/supabase-js@latest
npm run <full gate from §3>
```

`npm update` respects the `^`/`~` ranges in package.json, so it will NOT jump a
major or touch exact-pinned deps (Tiptap, Brevo). Safe by construction.

### Single major

```bash
git checkout -b chore/upgrade-eslint-10
npm install eslint@10 eslint-config-next@latest --save-dev
# read the package's migration guide / changelog
npm run <full gate>
```

One major per branch/PR. If the gate fails and the fix is non-trivial, that's
its own ticket — don't pile a second major on top.

---

## 5. Project-specific landmines (these WILL bite)

- **Tiptap is pinned to v2 on purpose.** v3 (3.x) ships source-only with no
  compiled `dist/` — `next build` fails with `Cannot find module '@tiptap/react'`.
  Documented as **B1** in `docs/ERRORS_AND_FIXES.md`. All `@tiptap/*` are pinned
  without `^`. Do not bump to v3 until it ships pre-compiled artifacts. `npm
  update` won't touch them (no `^`), but a manual `@latest` will — don't.
- **`pdfkit` is in `serverExternalPackages`** (`next.config.ts`) because Turbopack
  rewrites `__dirname` and breaks its Helvetica.afm font resolution. Any Next
  major or bundler-config change → re-test the PDF paths: badge print, quote PDF,
  invoice PDF, speaker-agreement docx→PDF.
- **React 19 peer deps.** Many libs still declare `react@^18`. `npm ci` throws
  `ERESOLVE`. Some installs need `--legacy-peer-deps` (that's how Tiptap v2 went
  in). If you must use it, note it in the commit message and re-verify the lib
  actually works at runtime, not just that it installed.
- **Prisma needs `prisma generate` after any bump.** The client is code-generated;
  a version mismatch gives confusing type errors. `build` and `postinstall`
  already run it, but run it manually after a local bump before `type-check`.
- **Email providers can be removed.** As of 2026-05-21 email is on **AWS SES**
  (`src/lib/email.ts`, provider hardcoded to `ses`). `@getbrevo/brevo`,
  `@sendgrid/mail`, `postmark` are dead code kept commented for one release cycle.
  Once confident, `npm uninstall @getbrevo/brevo @sendgrid/mail postmark` and
  delete the commented blocks — fewer deps to ever upgrade. See
  `memory/reference_ses_email.md`.
- **`MISSING` linux-x64 optional deps are normal on macOS.** `npm outdated` shows
  `@tailwindcss/oxide-linux-x64-gnu` and `lightningcss-linux-x64-gnu` as MISSING
  on a Mac — they're linux-only optional deps installed on the EC2 build host.
  Not a problem; don't try to "fix" them locally.
- **Playwright port drift.** `playwright.config.ts` defaults to port 3000 but
  `npm run dev` binds 3113. Stop the dev server before `npm run test:e2e` or it
  hits `EADDRINUSE`. See `memory/playwright_port_drift.md`.
- **`@types/node` should track the Node engine.** Engine is Node 24; `@types/node`
  is on 20. Bump to `@types/node@24` (not 25 — match the runtime major).

---

## 6. Framework-major playbooks

### Next.js major (e.g. 16 → 17)

```bash
git checkout -b chore/upgrade-next-17
npx @next/codemod@latest upgrade latest   # bumps next/react/eslint-config-next
                                          # + runs automated migrations
npm run <full gate>
```

The codemod handles renamed APIs and App-Router migrations (async
`params`/`searchParams`, etc.). Then **read the upgrade guide manually** for
Turbopack-specific breaking changes — this app is all-in on App Router +
Turbopack, so those notes apply directly. Re-test: PDF generation (pdfkit +
Turbopack `__dirname`), MCP routes, Zoom embed, image/middleware behavior.

### React major (e.g. 19 → 20)

Tied to the Next upgrade — bump them together via the Next codemod. Watch for:
peer-dep fallout across every UI lib, `useEffect`/Suspense semantics changes,
the set-state-in-effect lint rules already in use. Run the full Playwright suite.

### Prisma major (6 → 7)

```bash
git checkout -b chore/upgrade-prisma-7
npm install prisma@7 @prisma/client@7
npx prisma generate
npm run <full gate>
```

Read the Prisma 7 upgrade guide — query-engine and client-API changes are
possible. Run every DB-touching test. **Do NOT run `prisma migrate` / `db push`
against prod** as part of the upgrade — schema changes are a separate, deliberate
step. Verify the generated client compiles and the existing migrations still
apply cleanly on a scratch/test DB first.

---

## 7. Deploy (after the gate is green on the branch)

1. **Merge the branch to `main`** (PR + review for framework majors).
2. **Secondary-first for high-risk upgrades.** Deploy the branch/commit to the
   Singapore instance (`i-075c400567ed002e6`, ap-southeast-1, terraform-managed)
   and smoke-test before it touches Mumbai prod. See
   `memory/reference_ec2_instances.md`.
3. **Deploy to Mumbai prod** (`i-0b51ab1213d084640`): SSH via SSM →
   `sudo -iu ubuntu` → `cd ~/ea-sys` → `bash scripts/deploy.sh`. Blue-green: the
   old container keeps serving until the new one passes health checks, so a bad
   build fails **before** cutover. Never run raw `docker compose` in that dir —
   it kills prod. See `memory/ec2_blue_green_deploy.md` +
   `memory/feedback_deploy_delegation.md`.
4. **Smoke-test prod** the surfaces the upgrade could affect.

### Rollback

Blue-green keeps the previous image. To roll back: re-point the compose to the
last-good image tag and restart via `scripts/deploy.sh` (ECR keeps the last few
tags). For a bad merge, revert the commit on `main` and redeploy. No DB rollback
is needed unless the upgrade included a migration (it shouldn't — keep schema
changes separate).

---

## 8. Recommended next batch (as of 2026-05-22)

Low-risk, do these together in one `chore/upgrade-minors` PR:

- `npm update` to sweep all in-range minors/patches (react-query, sentry,
  supabase, hookform/resolvers, playwright, date-fns, docxtemplater, bwip-js,
  zoom-meetingsdk, tailwindcss/postcss, @types/react, @auth/prisma-adapter,
  @types/pdfkit).

Separate single-major PRs, in rough priority order (each its own branch + gate):

1. `@types/node@24` (match Node 24 engine) — trivial, types-only.
2. `eslint@10` + `eslint-config-next@latest` — dev-only, may need config tweaks.
3. `lucide-react@1` — check for renamed/removed icon exports against usage.
4. `@anthropic-ai/sdk@latest` (0.82 → 0.98) — used by the AI agent; verify
   tool-use + streaming still work (pre-1.0, treat as breaking).
5. `prisma@7` — biggest; its own PR, read the guide, test DB paths hard.

**Do NOT** bump: `@tiptap/*` (v2 pin), and consider *removing* Brevo/SendGrid/
Postmark rather than upgrading them.

---

## TL;DR

1. Branch (never `main`).
2. Bump → `npm ci` → `prisma generate` → `type-check` → `lint` → `build` →
   `test` → `test:e2e`.
3. One major per PR; batch patches/minors.
4. High-risk → deploy to Singapore secondary first.
5. Prod via `bash scripts/deploy.sh` (blue-green, auto-rollback on bad build).
6. Never touch the Tiptap v2 pin or run `prisma migrate` as part of an upgrade.
