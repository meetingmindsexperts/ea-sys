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
| **Worker cron** | `worker/jobs/*.ts` | Postgres advisory lock, singleton |

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

---

## Roles and visibility

Eight roles: `SUPER_ADMIN` `ADMIN` `ORGANIZER` `MEMBER` `ONSITE` — org-bound;
`REVIEWER` `SUBMITTER` `REGISTRANT` — org-independent (`organizationId: null`), scoped by
event assignment or linked entity. **Internal-domain emails get the org attached even as REGISTRANT**
(see `src/lib/internal-domains.ts`), so "org-bound" alone is never a sufficient authorization check.

**There is no single "can this role see it?" predicate — there are six, and they deliberately disagree:**

| Boundary | File | Notable |
|---|---|---|
| Write guard | `auth-guards.ts` — `denyReviewer()` | Blocks REVIEWER/SUBMITTER/REGISTRANT/**MEMBER**/ONSITE. Desk routes opt back in via `REGISTRATION_DESK_ALLOW`. |
| Event scoping | `event-access.ts` — `buildEventAccessWhere()` | ONSITE is **assignment-gated**, not just org-gated. Every ONSITE-reachable route must build its lookup from this. |
| Money | `finance-visibility.ts` | **Includes MEMBER and ONSITE** (desk staff record payments). |
| Door credentials | `barcode-visibility.ts` | **Excludes MEMBER, includes ONSITE** — the exact inverse of the finance set. |
| Contact store | `contact-visibility.ts` | **Includes MEMBER, excludes ONSITE.** |
| Zoom host creds | `zoom-visibility.ts` | Staff only — narrower than finance. |

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
npx prisma migrate dev # new migration — additive only, see rule 4
```

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
