# AGENTS.md — EA-SYS

Orientation for AI coding agents (Codex, Cursor, Copilot, Zed, Claude Code).

**This file holds invariants only** — the rules and shapes that stay true when a feature ships.
It deliberately contains **no feature list and no changelog**. Feature history lives in `CLAUDE.md`;
that separation is on purpose, because the previous version of this file rotted into a stale
feature inventory that nobody read.

---

## Read this first

| If you need… | Read |
|---|---|
| **To understand a domain before touching it** | **`docs/DOMAIN_MAP.html`** — start here, always. Every domain's entry points, core files, models, gotchas, and open findings. |
| Feature history, decisions, deep context | `CLAUDE.md` (large — search it, don't read it top to bottom) |
| What's deferred / known-broken | `docs/ROADMAP.md` |
| Why a domain looks the way it does | `docs/CODE_REVIEW_*.html` (per-domain production reviews) |
| How the services layer works | `src/services/README.md` — **read before extracting a new service** |
| Prod ops, incidents, rollback | `docs/AWS_OPERATIONS.md`, `docs/INCIDENTS.md`, `docs/ROLLBACK.md` |

---

## What this is

EA-SYS (Event Administration System) — a full-stack event-management platform for conferences,
webinars and hybrid events: registrations, speakers, abstracts + peer review, agenda, accommodation,
payments/invoicing, certificates, check-in, communications, and a CRM-ish contact store.

**Production is LIVE for real events.** Real registrants, real money, real door scanning.
Prefer non-breaking, reversible changes. See "Hard rules" below.

| | |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript, strict |
| Database | PostgreSQL (Supabase, PG17) + Prisma — **no raw ORM escape hatches without reason** |
| Auth | NextAuth v5, JWT strategy; Edge-safe config for middleware |
| UI | TailwindCSS 4 + shadcn/ui; TanStack Query for server state |
| Email | **AWS SES** (SESv2, ap-south-1). Brevo/SendGrid code is retained but inactive. |
| Hosting | AWS EC2 Mumbai (t3.large), Docker blue-green + a separate worker container |
| Scale today | ~65 Prisma models · ~100 migrations · ~2,700 tests |

Dev server runs on **port 3113** (not 3000).

---

## The five entry points

Every domain is reachable through some subset of these. **When you change domain logic, ask which
of the five call it** — that question is the source of most bugs in this codebase.

| Entry point | Where | Auth |
|---|---|---|
| **Dashboard UI** | `src/app/(dashboard)/**` | NextAuth session |
| **REST API** | `src/app/api/**` | Session **or** org API key (`getOrgContext`) |
| **Public API** | `src/app/api/public/**` | None — rate-limited, token-gated |
| **MCP / AI agent** | `src/lib/agent/tools/*.ts` | Org API key or OAuth 2.1 (admin-equivalent) |
| **Worker cron** | `worker/jobs/*.ts` | Singleton via an expiring `JobLease` row — **never** a connection-bound lock (see below) |

**The privileged lane.** A few surfaces are cross-tenant by design and would
see zero rows once the platform enables RLS: the worker candidate scans, the
operator-global readers. They use `dbOperator` (`src/lib/db.ts`), which
connects as the table-owner role. It is a separate export precisely so a CI
allowlist can pin it (`check-tenant-als.sh`). Adding a file to that list is a
security decision, not a build fix. In almost every case the right answer is
not this client but `runWithTenant(theRowsOrg, …)`: **borrow the tenant's lane,
do not stay privileged.** On master `dbOperator` IS `db`.

The **MCP path is the one people forget.** It is a full write surface (n8n, claude.ai, Claude
Desktop all drive it), it is admin-equivalent, and historically it has drifted from REST — silently.
If you fix a bug in a REST route, check whether an MCP tool implements the same operation.

---

## Hard rules

These are not style preferences. Each one exists because breaking it caused a production bug.

### 1. No cross-caller duplication
A domain operation called from more than one entry point **must live in exactly one service**
(`src/services/`). A comment saying *"must mirror the REST route"* is the smell, not the solution —
mirrors drift, and the drift is always silent.

Today: `abstract` · `accommodation` · `billing-account` · `payment` · `promo-code` · `registration`
· `session` · `speaker`. A service never imports `next/server` — if it knew about HTTP, the worker
and MCP couldn't use it. Errors are returned as values (`{ ok: false, code }`), never thrown across
the boundary. Auth, Zod, rate limits and HTTP mapping stay in the caller.

### 2. Every failure path logs
No silent `400/403/404/409/429/500`. Every `safeParse` → 400 logs its field errors. Every
`.catch(() => {})` is a bug. Errors log at `error`, business rejections at `warn`, successes at `info`.
**Do not downgrade `error` → `warn` to reduce alert noise** — over-alerting is the owner's explicit
preference. Surface it and ask instead.

### 3. Guard clauses, not nested ifs
Flatten `if (cond) { …body… }` into `if (!cond) return; …body…` so the happy path reads un-indented.
Keep to ~one level of nesting; extract a growing branch into its own function. JSX ternaries are exempt.

### 4. Migrations are additive and idempotent
Prod shares one DB across a blue-green swap, so **both the old and new container run against the same
schema simultaneously.** `ADD COLUMN IF NOT EXISTS`, nullable, no destructive `ALTER`. A non-additive
migration is a decision to escalate, not to make quietly.

Locally, `npm run db:push` snapshots first and **fails closed** if it cannot, so schema work is
undoable via `npm run db:restore`. That seatbelt exists because a list of forbidden commands only
covers the footguns someone already met.

### 5. Verify before you push
```bash
npx tsc --noEmit && npm run lint && npm run test && npm run build
```
All four, green, every time. `npm run test:e2e` when the change touches a user flow (stop the dev
server first — Playwright's port collides with 3113).

### 6. Enrichment syncs are enrich-only
`syncToContact` **never clears a populated field** — so a payload of only `{email, firstName, lastName}`
against an existing contact is a **silent no-op that reports success.** If you are syncing an entity to
the contact store, send the full field set. This exact hole shipped twice.

### 7. Correctness must never depend on *which* connection ran a statement
Prisma hands out whichever pooled connection is free, so anything requiring the same connection twice
is broken by construction. Background jobs are guarded by an **expiring `JobLease` row** claimed in one
atomic statement — **never** `pg_advisory_lock`, which must be released by the connection that took it.
That lock leaked and silently skipped ~70% of every job's ticks for months while every dashboard stayed
green, because nothing failed. Same rule for any new "only one of these at a time" mechanism.

The corollary for tests: **a mocked Prisma has one fake connection, so this class of bug is not
expressible in the unit suite.** Anything whose correctness is about concurrency or connection identity
needs the real-Postgres harness (`tests/crm-db/`). See `docs/BACKGROUND_JOBS.md`.

### 8. Every file operation goes through `storage.ts`
Four primitives — `uploadFile` / `readStoredFile` / `deleteStoredFile` / `listStoredFiles` — and **no
route may call `writeFile`, `readFile` or `unlink` on `public/uploads/` directly.** A stored path is
always `/uploads/{segment}/...` and is what the database holds; it is a logical id, not a filesystem
path, so the backing store can change without touching a single stored value.

`readStoredFile(storedPath, requirePrefix)` takes the prefix as a **required** argument on purpose: it
is the traversal guard, and an optional guard is one somebody eventually omits. Until Aug 2026 nine
document routes hand-rolled `mkdir` + `writeFile` and a dozen read sites carried their own copy of that
guard — and they were exactly the sensitive ones (passports, CVs, bank details, employer letters).

**The public/private split is an allow-list** (`upload-prefixes.ts`, `PUBLIC_UPLOAD_SEGMENTS`), not a
deny-list. A segment absent from it is refused by the `/uploads` catch-all. The deny-list it replaced
failed OPEN: a private prefix added later was world-readable until someone remembered one file, with no
test failing. Note "public" there means only "served to anyone who knows the URL" — certificates are on
that list because that is how they are delivered — which is a different axis from where bytes are stored.

### 9. Correctness lives in the relationships, not in the file
Three questions. None can be answered by reading the file you are editing.

**Before writing it — does anything call this?** `storedFileExists` shipped, was imported by
nothing, and was deleted days later.

**Before shipping it — who actually reaches this?** `AbstractReviewersCard` returns `null` for a
submitter, but **React hooks run above the early return**, so every submitter page view fired two
staff-only requests. Chasing that 403 found a MEMBER reading reviewer identities for every abstract
in the org. Same question, tenancy form: `GET .../speakers` keyed its lane on
`orgCtx?.organizationId ?? session.user.organizationId`, which is null for the org-null roles it
exists to serve. **The tenant is a property of the resource, not of whoever asked for it.**

**Before relying on it — what am I assuming that could stop being true?** `getStripe` fell back to
the env key for any org without one, and the platform was safe only because `STRIPE_SECRET_KEY`
happened to be unset there. **An implicit guarantee resting on an absent variable is not a
guarantee** — make the safe behaviour structural (an allow-list of one), not circumstantial.

All three were found on Aug 24, 2026 after weeks to months live, and **all three would pass a
careful review of their own file** — each was internally consistent and wrong only in relation to
something outside it. So the defence is not more review. It is instrumentation that names the
relationship (a refusal log carrying its `route`), a CI gate once the shape recurs across files
(`scripts/check-*.sh`), and **running it as each role**, because a server test proves the API
refuses while only the browser proves the client stopped asking.

### 10. Climb the ladder before you write
Adopted from [Ponytail](https://github.com/DietrichGebert/ponytail) (`.agents/rules/ponytail.md`),
amended below. Kept in this file rather than as its own, because the rule's own advice is "fewest
files possible."

Before writing code, stop at the first rung that holds:

1. Does this need to be built at all?
2. Does it already exist in this codebase? Reuse the helper or pattern that is already here.
3. Does the standard library do this?
4. Does a native platform feature cover it?
5. Does an already-installed dependency solve it?
6. Can this be one line?
7. Only then: write the minimum that works.

**The ladder runs after you understand the problem, not instead of it.** The smallest change in the
wrong place is a second bug, not laziness. And a bug fix means the root cause: grep every caller and
fix the shared function once (which is rule 1 restated).

**Why this is here, in this repo's own evidence:** a **449-line** certificate resend route with zero
callers, deleted in the July review. `storedFileExists`, shipped and imported by nothing. Two
notification switches that saved correctly and were **read by nothing for months** while an event
with both set to `false` kept sending. And on Aug 25, a seven-entry guard list in
`src/lib/session-expiry.ts` where six entries defended paths that cannot produce the error at all.

**Not lazy about** (their list): understanding the problem, input validation at trust boundaries,
error handling that prevents data loss, security, accessibility, anything explicitly requested, and
leaving one runnable check behind for non-trivial logic.

**Not lazy about** (added here, because their list omits both and this repo runs on them):

- **Every failure path still logs.** Rule 2 is absolute and outranks a shorter diff. A silent
  refusal is how a bug stays invisible for months.
- **The comment recording why a guard exists.** Their `ponytail:` marker names a known ceiling and
  its upgrade path; keep that. But also keep the comment naming the incident that produced a guard.
  A 40-line file that is half explanation is not over-built, it is the reason one person can still
  maintain this. Volume rules target code, never the reasoning.

---

## Roles and visibility

Eight roles: `SUPER_ADMIN` `ADMIN` `ORGANIZER` `MEMBER` `ONSITE` — org-bound;
`REVIEWER` `SUBMITTER` `REGISTRANT` — org-independent (`organizationId: null`), scoped by
event assignment or linked entity. **Internal-domain emails get the org attached even as REGISTRANT**
(see `src/lib/internal-domains.ts`), so "org-bound" alone is never a sufficient authorization check.

**There is no single "can this role see it?" predicate. There are several, and they deliberately disagree.**
The last row is not a role predicate at all — it is included because it answers the same question for a
different subject:

| Boundary | File | Notable |
|---|---|---|
| Write guard | `auth-guards.ts` — `denyReviewer()` | Blocks REVIEWER/SUBMITTER/REGISTRANT/**MEMBER**/ONSITE. Desk routes opt back in via `REGISTRATION_DESK_ALLOW`. |
| Event scoping | `event-access.ts` — `buildEventAccessWhere()` | ONSITE is **assignment-gated**, not just org-gated. Every ONSITE-reachable route must build its lookup from this. WEBINARS has **two surfaces**: `desk` is org-wide (MEMBER parity), the default `manage` is webinar-only and **must stay that way** — ~55 routes behind `WEBINAR_STAFF_ALLOW` depend on it. |
| Money | `finance-visibility.ts` | **Includes MEMBER and ONSITE** (desk staff record payments). |
| Door credentials | `barcode-visibility.ts` | **Excludes MEMBER, includes ONSITE** — the exact inverse of the finance set. |
| Contact store | `contact-visibility.ts` | **Includes MEMBER, excludes ONSITE.** |
| Zoom host creds | `zoom-visibility.ts` | Staff only — narrower than finance. |
| Cross-tenant reads | `platform-operator.ts` / `denyNonOperator()` | SUPER_ADMIN only, and **refuses org API keys**, which every other surface treats as admin-equivalent. Pair it with `dbOperator` (below); the DB lane and the RBAC check are two walls. |
| Uploaded files | `upload-prefixes.ts` — `PUBLIC_UPLOAD_SEGMENTS` | Not a role predicate at all: an **allow-list of prefixes** the public catch-all may serve. Everything else streams only through an authed route. Fails closed. |

If you find yourself reaching for an existing predicate because it's "close enough", that is the
signal to write a new one. Four of these exist precisely because "close enough" leaked something.

---

## Conventions

**API route shape**
```ts
export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const [session, { eventId }] = await Promise.all([auth(), params]);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const denied = denyReviewer(session);          // every POST/PUT/DELETE
  if (denied) return denied;

  const event = await db.event.findFirst({
    where: { id: eventId, ...buildEventAccessWhere(session.user) },
    select: { id: true },                        // select, never include, for existence checks
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // …delegate to a service if more than one entry point calls this operation
}
```

- Parallelize with `Promise.all` (`params` + `auth()`, then independent queries).
- Prisma `select` over `include` — an allow-list can't leak a column added later.
- Bind **every** lookup to its parent (`{ id, eventId }`, `{ id, organizationId }`). Trusting a nested
  id straight from the URL is this codebase's most-repeated IDOR.
- On a route that accepts **both** an org API key and a session, never branch on `orgCtx` to pick the
  scope. `getOrgContext()` matches a signed-in person too, so `orgCtx ? orgScoped : roleScoped` silently
  skips the role rules for everyone org-bound. Use `accessUserFrom(orgCtx, session?.user)` and call
  `buildEventAccessWhere` **once**. This shipped as a live bypass in two routes (Aug 10, 2026) and
  survived review because both branches are correct in isolation — the defect was the condition.
- Concurrency: claim first, then act. `updateMany` with the expected prior state as a predicate; a
  zero-row result means someone else won. Check-then-act on a counter is always a bug here.
- Audit writes are fire-and-forget **with a logged catch** — an audit blip must not 500 a committed write.
- Client pages use React Query hooks from `src/hooks/use-api.ts`, never raw `useEffect` + `fetch`.
- Anything imported by a `"use client"` component **must not import Node builtins** (`crypto`, `fs`,
  `path`). Next bundles them as `undefined`; the symptom is "the button does nothing, no logs".

---

## Commands

```bash
npm run dev            # dev server on :3113
npm run build          # prisma generate + next build
npm run lint           # eslint
npm run type-check     # tsc --noEmit
npm run test           # vitest
npm run test:e2e       # playwright (stop the dev server first)
npm run worker:dev     # the background worker tier

npx prisma studio      # DB browser
npm run db:migrate     # apply migrations to local (= migrate deploy, non-destructive)
npm run db:snapshot    # bank local DB state; db:restore rolls back
npm run db:refresh     # rebuild local from the latest prod DR dump
```

**Never `prisma migrate dev` or `prisma migrate reset`** — a `migrate dev` reset prompt wiped
production on 2026-07-30 (INC-002). Author migration SQL by hand (or `migrate dev --create-only`,
which writes the file and never touches a database), then apply it with `npm run db:migrate`.
**Never pass a real database to `--shadow-database-url`** — Prisma resets it; that emptied the local
prod copy on 2026-08-25. See rule 4 and `docs/LOCAL_DEV_DATABASE.md`.

**Deploys** go through `scripts/deploy.sh` on the box (blue-green, health-checked, ~25s).
Never run raw `docker compose` in `/home/ubuntu/ea-sys` — it kills prod. Rollback is
`IMAGE_TAG=<full-git-sha> bash scripts/deploy.sh`; see `docs/ROLLBACK.md`.

Docs-only commits **do not deploy** (`paths-ignore` in CI) — so `git log` is not necessarily what
production is running. Check `docker ps`.

---

## When you add an MCP tool

1. Put it in the right `src/lib/agent/tools/*.ts` domain file — never the `event-tools.ts` entry point.
2. Mirror it in `src/lib/agent/mcp-server-builder.ts`.
3. **Bump `package.json` version** — it feeds `serverInfo.version`, the only cache-invalidation hint
   MCP clients get.
4. Tell the user connected clients must **disconnect and reconnect** to see the change. Client-side
   tool-list caching is spec-allowed and cannot be force-invalidated from the server.
