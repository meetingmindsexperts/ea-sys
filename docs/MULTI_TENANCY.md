# Multi-Tenancy for EA-SYS — A Complete Reference

> **Purpose.** EA-SYS started as a single-organization event platform for Meeting
> Minds Group. There is now external demand to **white-label it** so other
> companies run *their* events on it, under *their* domain and branding, with
> *their* own integrations and money. This document is the deep reference for
> turning EA-SYS into a multi-tenant SaaS: the models, the system + database
> design, payments, per-tenant logging/observability, operations, maintenance,
> security, **and a realistic cost model**. It is opinionated and grounded in
> EA-SYS's actual stack (Next.js 16 App Router, Prisma + PostgreSQL on Supabase
> behind a pgbouncer transaction pooler, Docker blue-green on AWS EC2, Stripe,
> Zoom, AWS SES), and in its real history (the May 18 2026 audit found
> cross-tenant IDOR bugs even in single-org code — that finding shapes the
> isolation recommendation).

---

## 0. Decision record — topology DECIDED: the two-silo plan (July 22, 2026)

> **Owner decision (Krishna, July 22, 2026).** After steelmanning both options
> (pooled-on-current-prod vs a second deployment), EA-SYS multi-tenancy will run as
> **one codebase, two deployments**:
>
> - **Master** — the current Mumbai instance + Supabase DB. Stays **MM Group only**.
>   Live events keep zero blast radius; nothing risky lands here.
> - **Platform** — a second deployment (own box + **fresh DB**) running the **same
>   Docker image**, multi-tenant from birth (**Pool+ / shared DB + RLS**, §2). **All
>   external tenants live here — including customer #1** (this supersedes the earlier
>   "customer #1 on its own Silo++ instance" lean in §2/§13).
>
> **Why:** asymmetry of worst cases. The pooled plan's failure modes are *safety*
> failures on live revenue-bearing events (silent RLS bugs — wrong policies return
> empty rows, not errors; `organizationId` backfills ×25 on a live DB; the first
> external tenant sharing MMG's failure domain). The two-silo plan's failure modes are
> *cost/discipline* failures (2× ops surface, soft-fork drift) — certain but bounded,
> visible, and reversible. The platform DB being **greenfield** converts the scariest
> single step of the pooled plan (enabling RLS table-by-table on a live prod DB) into
> a non-event.
>
> **Guardrails (without these the plan degrades into a fork):**
> 1. **One repo, one image, one migrations folder — flags/data, never code forks.**
>    A forked repo or long-lived divergent branch is explicitly rejected. Master runs
>    the identical build with a real `TenantDomain` row from day one; RLS is enabled
>    on master too once proven on platform, so master converges to "a tenant that
>    happens to have its own box" and the merge option stays a data migration, not a
>    re-platforming. Migrations stay additive + idempotent (house rule) and apply to
>    both DBs on each deploy.
> 2. **Platform is first-class prod from birth** — DR cron, monitoring, fail2ban,
>    CloudWatch, runbooks stamped from `FROM_SCRATCH_REBUILD.md` / `infra/dr`
>    **before** tenant #1 onboards, not after.
> 3. **Dogfood before selling** — run one real (or shadow) MM Group event on platform
>    to give its RLS/routing/pooler code paths real traffic before an external tenant
>    depends on them.
> 4. **Re-evaluation trigger, defined now:** after ~6 months of stable platform
>    operation, or the first ops incident caused by the two-environment split
>    (whichever comes first), explicitly decide **merge-MMG-into-platform vs
>    silo-forever**. Both are acceptable end states; drifting without deciding is not.
> 5. **Cap silos at two.** No tenant ever gets its own box; tenants #2..N go on
>    platform. Silo-per-tenant is rejected (§15). DB-per-tenant *within* platform
>    remains available later as a premium tier (§2).
>
> **Build order:** the **Phase 0 spine** first — `TenantDomain` + host→tenant
> resolver (§3.1), `AsyncLocalStorage` context + pooler-safe `SET LOCAL` (§3.2, §5.2),
> the 2-tenant **isolation test harness** (§5.4), and the org-scoped slug-routing cut
> landing *atomically with* the resolver — built and proven against the platform
> target. Then **domain-by-domain sweeps** (add/backfill `organizationId` → org-bind
> the domain's queries → enable RLS on its tables → domain isolation tests green),
> piloting on a small already-org-keyed domain (**Contacts**) to debug the recipe
> cheaply, then blast-radius order (`MULTI_TENANCY_IMPACT.md §5`).
>
> **Still open (unchanged by this decision):** the user-identity model (§14 "Users",
> `MULTI_TENANCY_IMPACT.md §8.1`) and Stripe Connect rollout details (§6) — both are
> platform-instance concerns and don't block the spine.
>
> **PHASE 0 BUILD STATUS (July 22, 2026): the spine is BUILT.** Shipped as 11 gated
> commits (`2473d8ab`…`548e9b54`), each tsc/lint/vitest/build green, all
> behavior-preserving on master: the `TenantDomain` table + `scripts/add-tenant-domain.ts`;
> the host→org resolver (`src/lib/tenant/resolver.ts`, bounded negative-caching
> micro-cache, three-stage unknown-host ramp); `publicEventWhere`
> (`src/lib/public-event.ts`) + the full **slug cut** — all ~26 public event-by-slug
> lookup sites org-scoped by construction, token routes carrying an
> `eventMatchesRequestTenant` defense-in-depth assert (independent review: SAFE TO
> SHIP, 0 blocker/high); the ALS tenant context + flag-gated `SET LOCAL` Prisma
> extension + `tenantTransaction` (`src/lib/tenant-context.ts`, `src/lib/db.ts` — OFF
> on master); the **tenant-isolation harness** (`tests/tenancy/**`, real Postgres +
> pgbouncer-transaction-mode via `docker compose --profile tenancy`, two-role split,
> pilot Event RLS as harness-only SQL, 13 assertions incl. the 50-way pooler
> interleave — 13/13 green locally); the non-gating CI `tenancy` job (service
> containers); and the gating `scripts/check-tenant-scoping.sh` CI guard.
> **Remaining Phase-0 steps:** ~~promote the CI job to gating~~ ✅ DONE July 23,
> 2026 (`needs: [checks, tests, build, tenancy, migration-replay]` in deploy.yml,
> promoted at 8/8 green per the ≥5-consecutive rule — verified again July 27);
> the master ops step (seed the prod `TenantDomain` row + `DEFAULT_ORG_ID` — until
> then the resolver warn-logs `tenant:host-unresolved-unscoped` ~once/min/container,
> accepted per the over-alerting preference). Operator commands:
> `docker exec ea-sys-worker npx tsx scripts/add-tenant-domain.ts events.meetingmindsgroup.com <org-slug> --primary --verified`
> (use `--list` first to confirm), then add `DEFAULT_ORG_ID=<org-id>` to the box
> `.env` + `bash scripts/deploy.sh` (a `docker compose restart` does NOT re-read
> env_file).
>
> **Runtime flags** (`.env.example` is untracked, so recorded here):
> `DEFAULT_ORG_ID` — org an unknown Host falls back to (unset ⇒ legacy org-unscoped
> public lookups; master's mode today). `TENANCY_ENFORCE_HOST=1` — unknown Host = 404
> (platform instance only). `RLS_SET_LOCAL=1` — the Prisma extension issues
> `SET LOCAL app.current_org` per query; **never enable before the Phase-2
> `tenantTransaction` migration** (§13). Harness: `TENANCY_DIRECT_URL` (owner, raw
> :55432) + `TENANCY_DATABASE_URL` (app_user via pgbouncer :56432).

---

## Table of contents

0. [Decision record — the two-silo plan (July 22, 2026)](#0-decision-record--topology-decided-the-two-silo-plan-july-22-2026)
1. [Where EA-SYS is today (the starting line)](#1-where-ea-sys-is-today-the-starting-line)
2. [Tenancy models — the isolation spectrum](#2-tenancy-models--the-isolation-spectrum)
3. [System design / architecture](#3-system-design--architecture)
4. [Database design](#4-database-design)
5. [Row-Level Security (RLS) on Prisma + Supabase — the deep dive](#5-row-level-security-rls-on-prisma--supabase--the-deep-dive)
6. [Payments — Stripe Connect](#6-payments--stripe-connect)
7. [Per-tenant integrations (email, Zoom, domains)](#7-per-tenant-integrations-email-zoom-domains)
8. [Per-tenant logging & observability](#8-per-tenant-logging--observability)
9. [Operational complexities](#9-operational-complexities)
10. [Maintenance](#10-maintenance)
11. [Operation costs (a real model)](#11-operation-costs-a-real-model)
12. [Security & compliance](#12-security--compliance)
13. [Phased roadmap](#13-phased-roadmap)
14. [Decision summary & recommendations for EA-SYS](#14-decision-summary--recommendations-for-ea-sys)
15. [Anti-patterns & pitfalls](#15-anti-patterns--pitfalls)
16. [Glossary](#16-glossary)

---

## 1. Where EA-SYS is today (the starting line)

**Good news — the data model is already multi-org-capable:**
- Every `User`, `Event`, `Contact`, `Invoice`, `MediaFile`, `ApiKey`, etc. carries an `organizationId`. The `Organization` row already holds rich branding (`logo`, `primaryColor` + a live dynamic theme via `org-theme.tsx`), company/tax/invoice fields, and per-org **encrypted** integration credentials (Zoom, EventsAir) in `settings` JSON.
- Auth resolves the org per user (`session.user.organizationId`); `src/lib/org-context.ts` (`getOrgContext`) is the choke point for org scope (session or API key).
- Per-event branding exists too: banner, `emailFromAddress`/`emailFromName`, email header/footer.

**What's missing for true multi-tenancy:**
- **No host → tenant routing.** `src/proxy.ts` reads `Host` only for CSRF; nothing maps a domain to an organization.
- **"Single-org mode" assumptions** — self-serve org creation is off; some admin paths use the non-null assertion `organizationId!`.
- **Org-scoping is not provably airtight.** The May 18 2026 multi-agent audit found cross-tenant IDOR (e.g. event email templates resolvable across orgs). In single-org mode that's latent; in multi-tenant it's a live data-leak class. **This is the single most important fact in this document** — it means multi-tenancy for EA-SYS is a *security project*, not a feature flag.
- **One Stripe account.** Payments today flow to MM Group's Stripe; tenants taking their own money needs Stripe Connect.
- **No per-tenant TLS/domain, onboarding, sender-domain auth, or per-tenant observability.**

**Mental model:** EA-SYS is ~70% of a multi-tenant SaaS at the schema level and ~10% at the platform level. The expensive 30% is *isolation you can prove*, not the plumbing.

---

## 2. Tenancy models — the isolation spectrum

The industry frames this as **Pool → Bridge → Silo** (AWS SaaS terminology). It is one tradeoff: **isolation strength** vs **operational cost/complexity**, and the right point scales with **# of tenants** and **data sensitivity**.

| Model | How | Isolation | Ops cost | Cross-tenant analytics | EA-SYS fit |
|---|---|---|---|---|---|
| **Pool — shared DB, app-scoping only** | One DB, every query `where organizationId` | **Weak** (one missed filter = leak) | Lowest | Trivial | ❌ Not with EA-SYS's IDOR history + medical data |
| **Pool+ — shared DB + RLS** ⭐ | One DB; Postgres enforces tenant filter on every query | **Strong** (DB blocks leaks regardless of code) | Low–moderate | Easy | ✅ **Default** for the many |
| **Silo — DB per tenant** | Each tenant a separate DB / Supabase project | **Strongest** (physical separation) | Highest (N migrations, N backups, N pools) | Hard (federate) | ✅ **Premium tier** + the fast path for early customers |
| **Silo++ — instance per tenant** | Separate app deployment + DB + domain | Strongest + compute isolation | Highest | Hardest | ✅ **MM Group's master instance** (zero risk to live events) — capped at this one silo, see §0 |

**Why RLS is the centre of gravity for EA-SYS.** Today isolation depends on every developer remembering `where organizationId`. The audit proved that's not guaranteeable. RLS moves enforcement into Postgres: you set the current tenant per request, and the database filters *every* query — a forgotten app-level filter can no longer leak. It is **native to Supabase** (RLS is what Supabase is built around) and is the standard SaaS B2B answer. It directly addresses EA-SYS's actual risk.

**The combination — DECIDED July 22, 2026 (full record in §0):**
- **Platform instance: Pool+ (shared DB + RLS)** — a second deployment + **fresh DB** where **all external tenants (including customer #1)** live. RLS from day one on a greenfield DB — the scariest step of a pooled migration (enabling RLS on live prod) never happens.
- **Master instance: Silo++ for MM Group only** — the current Mumbai box + DB, behaviorally unchanged. Runs the *same image* with a real `TenantDomain` row (tenancy code identical-but-single-tenant, never forked).
- **Premium: Silo (DB per tenant)** — remains available *later, within platform*, for a regulated/high-value tenant that demands physical separation or data residency; a flag on the tenant picks the connection. Not the default, and it never means a separate app instance — silos are capped at two (§0 guardrail 5).

> Superseded: the earlier lean of putting **customer #1 on its own Silo++ instance**. That would mint a third environment and start the silo-per-tenant slide; customer #1 goes on platform, where the isolation suite protects them like everyone else.

---

## 3. System design / architecture

### 3.1 Tenant resolution (host → tenant)

Every request must resolve **which tenant** it belongs to, as early as possible.

- **Custom domains** (`events.theircompany.com`) and/or **subdomains** (`theircompany.events.<your-platform>.com`). Support both: subdomains are zero-config (wildcard cert), custom domains are the premium white-label.
- New table `TenantDomain { id, organizationId, domain @unique, isPrimary, verifiedAt, tlsStatus }`. A domain maps to exactly one org.
- ~~**Resolution in middleware**~~ **AS BUILT (Phase 0, July 22, 2026): resolution lives in a LIBRARY, not middleware** — `src/lib/tenant/resolver.ts`, called internally by the public-event where-builder (`src/lib/public-event.ts`), so the resolver and the org-scoped slug lookups execute atomically and `src/proxy.ts` stays byte-identical (no Prisma coupling in the routing layer; the matcher doesn't cover `/e/*` anyway, and `generateMetadata` has no Request so it needs the host-string API regardless). The host→org map is micro-cached in-process (bounded 500 entries, negative results cached, 60s TTL — the Host header is attacker-controlled, unlike the lobby-status cache this mirrors). Middleware-based resolution is re-evaluated at the platform phase (apex-domain routing, marketing-site carve-out).
- **Edge case:** the marketing site / signup / platform-admin live on the *apex* platform domain, not a tenant domain. Route those before tenant resolution.
- **Token-link caveat for later phases:** token routes (rsvp, agreements, reimbursement, survey, complete-registration) assert the loaded event belongs to the request's tenant (defense-in-depth — tokens are globally unique + slug-asserted, so identity was already correct). Consequence once domains are enforced: a link emailed for tenant A will 404 on tenant B's domain **including old links if a tenant later moves domains** — re-send links after a domain migration.

### 3.2 Tenant context propagation

The resolved tenant must reach the data layer on **every** code path (API route, server component, server action — though EA-SYS uses none today, cron, webhook). Options:
- **Explicit threading** — pass `orgId` into every service/query. Verbose but obvious; EA-SYS already does much of this via `getOrgContext`.
- **`AsyncLocalStorage`** — a per-request store holding the tenant, read by a Prisma client extension that injects the RLS session var (see §5). This is the cleanest for RLS because the DB filter doesn't depend on the developer remembering to pass `orgId`.

**Recommendation:** keep explicit scoping at the app layer (defence #1) **and** add RLS via `AsyncLocalStorage` + a Prisma extension (defence #2). Belt and braces — exactly because the audit showed defence #1 alone is fallible.

**AS BUILT (Phase 0):** `src/lib/tenant-context.ts` (ALS) + the flag-gated `SET LOCAL` extension in `src/lib/db.ts` (`RLS_SET_LOCAL=1`, OFF on master; the official Prisma batch-`set_config` pattern — pooler-safe because the GUC and query share one transaction = one pgbouncer backend). Two lessons the isolation harness taught, now pinned by tests: **(1) PrismaPromises are lazy** — `runWithTenant(org, () => db.x.find())` would exit the ALS scope before the query executed, so `runWithTenant` forces execution inside the scope (without this, fail-closed RLS returns empty results that look like data loss); **(2) interactive transactions must go through `tenantTransaction()`** (db.ts) — wrapping inner ops again would SET LOCAL on a different pooled backend. Migrating the existing `db.$transaction` sites to `tenantTransaction` per-domain is the **hard precondition** before the flag ever turns on for real (§13 Phase 2).

### 3.3 Custom domains + TLS automation

Customers CNAME their domain to your ingress. You must terminate TLS for *their* domain.
- **Subdomains** of your platform domain: one **wildcard certificate** (`*.events.<platform>.com`) covers all — trivial.
- **Custom apex/vanity domains:** you need a cert **per domain**, issued on demand. Two clean approaches:
  - **Caddy** in front of the app — built-in **On-Demand TLS**: it issues/renews Let's Encrypt certs automatically when a new validated domain first connects (with an `ask` endpoint that confirms the host is a known tenant domain). This is the lowest-ops option and replaces hand-managed nginx certs.
  - **ACME (Let's Encrypt) automation** behind nginx, or a managed layer (Cloudflare for SaaS / AWS ACM + CloudFront with SNI). Note EA-SYS deliberately removed Cloudflare; re-introducing it *as the custom-domain TLS layer* is a legitimate, scoped re-evaluation (the nginx `real_ip` playbook in `AWS_OPERATIONS.md §4.3` already documents how).
- **Domain verification** before issuing a cert: ask the tenant to add a DNS TXT/CNAME record; verify it; only then route + issue TLS. Prevents domain-takeover and cert abuse.

### 3.4 Request lifecycle (multi-tenant)

```
Browser (theircompany.com)
   │  TLS terminated for their domain (Caddy on-demand cert)
   ▼
Ingress (Caddy/nginx)  ── X-Real-IP, host preserved
   ▼
Next.js middleware (proxy.ts)
   │  Host → TenantDomain → organizationId  (cached)
   │  reject if domain unknown/unverified
   ▼
Route handler / server component
   │  AsyncLocalStorage.run({ orgId }, …)
   ▼
Prisma client extension  ──  SET LOCAL app.current_org = orgId  (per tx)
   ▼
PostgreSQL  ── RLS policy filters every row by current_org
```

### 3.5 Where MM Group fits

**DECIDED (§0):** MM Group is **tenant zero and stays on the master instance** — its own box + DB, physically siloed from every external tenant. Master runs the same image as platform with a real `TenantDomain` row (`events.meetingmindsgroup.com` → MMG's org), so the tenancy code paths are exercised identically and never fork. Whether MM Group ever merges into the platform Pool+ DB is deliberately deferred to the §0 re-evaluation trigger (~6 months of stable platform operation, or the first two-environment ops incident); if it happens it is its own risk-managed data migration, last, long after the isolation suite is proven. **Silo-forever is an acceptable end state** — keeping your own biggest customer on dedicated infrastructure is a defensible pattern.

---

## 4. Database design

### 4.1 Tenant key & indexes

- `organizationId` is the tenant key (already present everywhere). Keep it **non-null** on tenant-owned tables.
- **Composite indexes must lead with `organizationId`** for the common "this tenant's rows, filtered/sorted" queries (many already do: `Registration(eventId, status)` etc. — at platform scale, validate that the hottest queries have an org-leading index so one tenant's big dataset doesn't slow another's queries).
- Globally-unique columns become **per-tenant unique**: e.g. event `slug` is currently globally unique; in multi-tenant it should be `@@unique([organizationId, slug])` (two tenants can both have an event called `summit-2026`). Audit every `@unique` for whether it should be tenant-scoped. (User email is the tricky one — see §12.)

### 4.2 Migrations in multi-tenant

EA-SYS's migration rules (additive + idempotent + blue-green-safe, hand-written SQL, no `prisma migrate dev` against prod) **still apply** — multi-tenancy adds a fan-out dimension:
- **Pool+ (shared DB):** a migration runs **once**. Simple. RLS policies are part of the migration (add the policy when you add a table — a table without an RLS policy in a multi-tenant DB is a leak waiting to happen; enforce "every tenant table has RLS" in CI).
- **Silo (DB per tenant):** a migration runs **N times** (once per tenant DB). Needs an orchestrated migration runner that iterates tenants, with per-tenant success/failure tracking, and is **resumable** (don't re-run a tenant that already applied). Blue-green still per-tenant.
- Hybrid: run the shared-pool migration once + fan out to the silo tenants.

### 4.3 Connection management

- **Pool+:** one connection pool, shared. The pgbouncer transaction-mode pooler with a tuned `connection_limit` (EA-SYS uses 10 — revisit for platform load) multiplexes. RLS via `SET LOCAL` inside a transaction is **required** here precisely because transaction-mode pooling reassigns backends per statement (a plain `SET` would not stick — the same gotcha behind the worker advisory-lock caveat).
- **Silo:** a pool **per tenant DB**. At many silo tenants this is a lot of pools; use a pooler (pgbouncer/Supavisor) per DB or a dynamic connection manager. This is the real ops cost of silo.

### 4.4 Backups, PITR, residency

- **Pool+:** one backup/PITR covers all tenants — but a per-tenant *restore* means surgically extracting one tenant's rows (harder). Per-tenant export = a scoped dump (`WHERE organizationId = …` across tables).
- **Silo:** per-tenant backup/restore/delete is trivial (it's a whole DB). Right-to-erasure (PDPL/GDPR) = drop the DB. Data **residency** per tenant is possible (put a tenant's DB in their required region) — a genuine silo advantage for regulated customers.
- EA-SYS already has a DR posture (Singapore S3 mirror + pg_dump, `infra/dr/`). Multi-tenant DR must cover all tenants (shared) or fan out (silo).

### 4.5 Noisy neighbour

In Pool+, one tenant running a 5,000-attendee webinar (heartbeats, lobby-status polls, registrations) shares the DB/pool/box with everyone. Mitigations: per-tenant rate limits & quotas (§9.4), the micro-cache patterns already used in the webinar code, read replicas for heavy reads, and the option to **promote a heavy tenant to a silo**. Capacity planning must assume concurrent big events across tenants.

---

## 5. Row-Level Security (RLS) on Prisma + Supabase — the deep dive

This is the highest-leverage and most stack-specific piece, so it gets its own section.

### 5.1 What RLS does

A Postgres **policy** on a table says, in effect: *"a row is visible/modifiable only if `organizationId = current_setting('app.current_org')`."* Once enabled, **every** query (SELECT/INSERT/UPDATE/DELETE) is filtered by Postgres itself. A developer who forgets `where organizationId` in app code **cannot** leak data — the database returns only the current tenant's rows.

```sql
ALTER TABLE "Event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Event" FORCE ROW LEVEL SECURITY;   -- applies even to the table owner

CREATE POLICY tenant_isolation ON "Event"
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
```
- `USING` filters reads (and the rows an UPDATE/DELETE can touch); `WITH CHECK` blocks writing a row for another tenant. You want **both**.
- `FORCE ROW LEVEL SECURITY` matters if the app connects as the table owner (owners bypass RLS by default).
- `current_setting('app.current_org', true)` — the `true` makes it return NULL instead of erroring when unset; pair with a policy that denies access when the var is NULL (fail closed).

### 5.2 The Prisma wiring (the wrinkle)

Prisma doesn't natively set a Postgres session variable per request. And EA-SYS is behind **pgbouncer transaction mode**, where a plain `SET app.current_org` would not persist across statements. The robust pattern:

1. **Per-request tenant in `AsyncLocalStorage`** (set in middleware after host→org resolution).
2. **A Prisma client extension** that wraps every query in a transaction and issues `SET LOCAL app.current_org = $orgId` first. `SET LOCAL` is transaction-scoped, so it works correctly under transaction-mode pooling (it's released at commit, doesn't leak to the next borrower of that backend).

```ts
// Conceptual — a Prisma $extension that scopes each operation to the tenant.
prisma.$extends({
  query: {
    async $allOperations({ args, query }) {
      const orgId = tenantStore.getStore()?.orgId;
      if (!orgId) throw new Error("No tenant in context"); // fail closed
      return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.current_org = '${orgId}'`);
        return query(args);
      });
    },
  },
});
```
> Caveats: wrapping every op in a transaction has overhead; batch where possible. There are community libraries (e.g. `@prisma/extension` patterns, Supabase's RLS guides) — evaluate vs hand-rolling. Platform-admin / cross-tenant jobs need a **separate, RLS-bypassing connection** (a privileged role) used deliberately and audited, *never* the default path.

### 5.3 Migration discipline with RLS

- **Every tenant-owned table gets an RLS policy in the same migration that creates it.** Add a CI check: "any table with an `organizationId` column must have RLS enabled + a policy" — a missing policy is a silent leak.
- Reference/global tables (e.g. `countries`) are exempt; mark them explicitly.

### 5.4 Testing isolation (non-negotiable)

Build a **tenant-isolation test suite**: seed two tenants, then for every model/route assert that tenant A *cannot* read/write tenant B's rows (via API and via raw Prisma with the wrong context). This is the regression net that turns "we think it's isolated" into "we prove it on every PR." Given the IDOR history, this suite is the deliverable that makes multi-tenancy safe to ship.

---

## 6. Payments — Stripe Connect

Today EA-SYS has **one** Stripe account. For tenants to take their own registration revenue, use **Stripe Connect**.

- **Model:** the platform (you) is the Stripe *platform*; each tenant is a **connected account**. Attendee payments are created **on behalf of** the tenant's connected account, with an **application fee** (your platform cut) taken automatically.
- **Onboarding type:**
  - **Express** (recommended) — Stripe-hosted onboarding + dashboard; Stripe handles KYC/compliance; you get a connected account id. Lowest liability.
  - **Standard** — tenant uses their full Stripe dashboard.
  - **Custom** — you build the whole UX; you own more compliance. Usually overkill.
- **Charge flow:** `PaymentIntent` with `application_fee_amount` + `transfer_data.destination = acct_xxx` (destination charge), or `on_behalf_of`. The tenant's bank gets the funds; Stripe takes its fee; you take the application fee; you are **not** a money-services business (Stripe is the processor). This is the key compliance win vs "we collect and remit" (which makes *you* the MSB — avoid).
- **Webhooks:** Connect sends events with the connected account id (`account` field). Your existing `/api/webhooks/stripe` must branch on the connected account → resolve tenant. Use **Connect webhooks** (account-scoped) in addition to platform webhooks.
- **Refunds, disputes, payouts** all flow per connected account. Your invoice/quote PDF + the `Payment` model gain a `stripeAccountId` (which connected account).
- **Per-tenant config:** store the tenant's `stripeAccountId` + onboarding status on the Organization (encrypted/safe). Gate "accept payments" on `charges_enabled`.

**Scope estimate:** Connect is a meaningful change (onboarding flow, charge-creation change, webhook routing, refund/dispute handling, the PDF/Payment additions) but well-trodden — Stripe's docs are excellent.

---

## 7. Per-tenant integrations (email, Zoom, domains)

Multi-tenant means each tenant brings (or you provision) their own external identity:

- **Email sender domain auth** — each tenant sends from *their* domain (`noreply@theircompany.com`). That requires **per-domain DKIM/SPF/DMARC verification** in your ESP (AWS SES verified identities or Brevo senders). Onboarding must walk the tenant through adding DNS records and verify them before enabling sends. Without this, their email lands in spam or is rejected. EA-SYS already supports per-event `emailFromAddress`; multi-tenant makes domain verification a first-class onboarding step. (SES also has a per-account sending quota + reputation — a tenant with bad list hygiene can hurt the shared SES reputation; consider per-tenant SES configuration sets + the option of a dedicated IP for big senders.)
- **Zoom** — already per-org (encrypted creds in `Organization.settings`). Each tenant connects their own Zoom Server-to-Server + Meeting SDK app. The webinar embed's per-org SDK mode (dev/prod) already supports this.
- **EventsAir** — already per-org encrypted creds.
- **Custom domain** — §3.3. The TLS + verification flow is the new piece.
- **Secrets** — all these per-tenant creds are encrypted at rest (EA-SYS uses AES-256-GCM keyed off `NEXTAUTH_SECRET`). At platform scale, consider a real secrets manager (AWS Secrets Manager / KMS) with per-tenant keys + rotation, rather than one app-wide key.

---

## 8. Per-tenant logging & observability

You must be able to answer *"what happened for tenant X?"* in seconds, and *"is one tenant degrading the platform?"* continuously.

### 8.1 Tag everything with the tenant

EA-SYS already uses **Pino** structured JSON logging (→ stdout + `logs/*.log` + the `SystemLog` Postgres table + CloudWatch). The change: **every log line carries `organizationId` (+ a human `tenantSlug`)**. Best done by binding the tenant onto a request-scoped child logger (from the `AsyncLocalStorage` context) so you never have to pass it manually. Then:
- The `/logs` dashboard gains a **tenant filter** (it already filters by level/source/search; add `organizationId`).
- CloudWatch Logs Insights queries filter by `organizationId`. Optionally per-tenant **log groups** or a metric filter per tenant for the biggest customers.

### 8.2 Metrics per tenant

Track, per tenant: request rate, error rate, p95 latency, DB time/queries, email volume + bounce/complaint rate, payment volume + dispute rate, webinar concurrency, storage used. This powers (a) noisy-neighbour detection, (b) usage-based billing, (c) SLA reporting, (d) capacity planning. Emit these as structured log fields and/or a metrics backend (CloudWatch custom metrics dimensioned by tenant, or Prometheus labels — beware cardinality at thousands of tenants; sample/aggregate cold tenants).

### 8.3 Errors & tracing

- **Sentry** (already wired) — set the **tenant as a scope/tag** on every event, so you can filter errors by tenant and see if an incident is one-tenant or platform-wide.
- **Audit log** — `AuditLog` is already per-org; ensure tenant + actor + `source` (rest/mcp/api) on every mutation. This is also your compliance trail.
- **Tracing** (optional, later) — request → DB spans tagged by tenant for the hot paths (the webinar 5k flow is the obvious candidate).

### 8.4 The isolation principle for logs

Per the project rule "every failure path must log": in multi-tenant, **a log line is for engineers and must include the tenant; a response body is for the user and must never leak another tenant's data**. And platform-admin log access must itself be audited (who looked at which tenant's logs).

---

## 9. Operational complexities

### 9.1 Onboarding a tenant (provisioning pipeline)
A repeatable, ideally self-serve flow: create `Organization` → set branding (logo/color/company) → add + **verify** custom domain → issue TLS → **Stripe Connect** onboarding → **verify email sender domain** (DKIM/SPF) → connect Zoom → seed defaults (terms, templates) → invite their admin. Each step has a verified/failed state; the tenant isn't "live" until the required ones pass. Automate it — manual onboarding doesn't scale past a handful.

### 9.2 Offboarding / suspension / deletion
- **Suspend** (non-payment / abuse) — flip a tenant status; middleware serves a "suspended" page; data retained.
- **Export** — per-tenant data export (PDPL/GDPR portability): scoped dump of their rows + uploaded media.
- **Delete / right-to-erasure** — Silo: drop the DB (clean). Pool+: a scoped cascading delete across all tenant tables (test it — orphan rows are a compliance failure). Plus their uploads in S3, their Stripe connected account unlink, their domain/cert cleanup.

### 9.3 Deploys & migrations
- Blue-green still applies. Pool+ migration once; Silo fan-out (resumable runner, §4.2).
- **Don't deploy during a tenant's live 5k webinar** (the in-memory rate-limit store resets on deploy — a known caveat; the durable fix is the deferred Redis limiter). At many tenants, "someone always has a live event" → you need **zero-downtime deploys** + the Redis-backed shared limiter, not the in-memory one.

### 9.4 Fairness / quotas / noisy neighbour
Per-tenant rate limits and quotas (events, registrations, emails/day, webinar concurrency, storage, API calls). The current `checkRateLimit` is **in-memory + per-container** (resets on deploy, not shared) — at platform scale move to **Redis** (Vercel KV / Upstash / ElastiCache) keyed by tenant. Quotas also drive plan tiers + usage billing.

### 9.5 Support & impersonation
Support needs to "see what the tenant sees." Build a **secure impersonation** ("log in as tenant admin") that is: permission-gated to platform staff, **fully audited** (who impersonated which tenant, when, why), time-boxed, and visibly flagged in the UI. Never share tenant passwords; never a backdoor.

### 9.6 Tenant lifecycle states
`trialing → active → past_due → suspended → churned`. Drives access, billing dunning, and data-retention timers. Model it explicitly on the Organization.

### 9.7 Incident & blast radius
- Pool+: an incident (bad migration, DB overload, a leak) potentially affects **all** tenants — higher blast radius, the price of shared infra. Mitigate with strong RLS, canary deploys, per-tenant feature flags, and circuit breakers.
- Silo: blast radius is one tenant — but you have N things to monitor.
- Runbooks must be tenant-aware ("tenant X reports Y" → how to scope the investigation).

---

## 10. Maintenance

- **Schema evolution** — additive/idempotent/blue-green forever; RLS policy with every new tenant table; the isolation test suite gates every PR.
- **Dependency & security patching** — one codebase patches all tenants (a Pool+ advantage); silo instances must all be patched (automate, or you get version drift).
- **Backups & DR** — extend the existing Singapore-DR posture to cover all tenants (shared) or fan out (silo); test restores per tenant.
- **Cost & usage monitoring** — per-tenant cost attribution (§11) so you know unit economics and can price.
- **Certificate lifecycle** — auto-renew custom-domain certs (Caddy/ACME handles it); alert on renewal failures (a lapsed cert = a tenant's whole site down).
- **Reputation management** — SES/Brevo bounce + complaint monitoring per tenant; suspend a tenant whose list hygiene threatens shared sender reputation.
- **On-call** — tenant-aware alerting (which tenant, severity, is it isolated or platform-wide).
- **Tech-debt watch** — the deferred items that become *mandatory* at multi-tenant scale: Redis rate limiter (shared), zero-downtime deploys, the worker advisory-lock session-mode fix (before a 2nd worker), and closing the IDOR-class findings.

---

## 11. Operation costs (a real model)

Costs split into **platform fixed cost** (amortised across all tenants) and **per-tenant marginal cost** (mostly usage-driven). Figures are rough 2026 AWS/Supabase/Stripe order-of-magnitude — validate against current pricing; the *ratios and which line dominates* are the durable lessons.

### 11.1 The cost lines

| Line | Driver | Rough cost | Notes |
|---|---|---|---|
| **Compute (EC2)** | Platform fixed | ~$60–250/mo | One bigger shared box (e.g. `c7a`/`t3.xlarge`) for Pool+; **silo/instance-per-tenant multiplies this**. The worker tier is a second container. |
| **Database (Supabase/RDS)** | Pool+: fixed; Silo: per-tenant | Pool+ ~$25–599/mo (one project, scales with tier); Silo **~$25+/mo per tenant minimum** | The single biggest *model* cost difference. Silo's per-tenant DB floor is what makes Pool+ win at scale. |
| **CDN egress (CloudFront)** | Per-event, usage | **The big variable.** A 5,000-viewer, 1-hour HLS webinar at ~1 Mbps ≈ 2,250 GB ≈ **~$190 in egress** (at ~$0.085/GB); at 2 Mbps ≈ ~$380 | Streamed webinars dominate variable cost. Zoom-embed mode shifts this cost to the tenant's Zoom plan instead. Bill it through or cap bitrate. |
| **Email (SES)** | Per email | ~$0.10 / 1,000 | Negligible unless huge volume. Dedicated IP (~$25/mo) only for very large senders. |
| **Object storage (S3)** | Stored GB + requests | ~$0.023/GB-mo | Uploads/media; cheap. DR mirror adds a copy. |
| **Stripe** | Per transaction | 2.9% + 30¢ (+ Connect mechanics) | Borne by the payment; your **application fee** is *revenue*, not cost. |
| **Zoom** | Per tenant (BYO) | Tenant pays | Each tenant brings their own Zoom plan — not your cost. |
| **Monitoring (Sentry/CloudWatch)** | Fixed + volume | ~$26–100/mo | Per-tenant log volume is small; CloudWatch ~<$1/mo/tenant at modest log rates. |
| **TLS certs** | Per domain | **$0** | Let's Encrypt via Caddy/ACME. |
| **DR (S3 + pg_dump)** | Fixed-ish | ~$1–10/mo | Already in place; scales gently. |

### 11.2 Per-tenant marginal cost (steady state)

- **Pool+ (shared + RLS):** a quiet tenant costs **near-zero** marginal (a slice of the shared DB/box + their email/storage). A tenant running streamed webinars costs **CDN egress per event** (the dominant line). So Pool+ unit economics are excellent for many small tenants.
- **Silo (DB per tenant):** add a **~$25+/mo DB floor per tenant** regardless of activity, plus more ops time. Justifiable only when the tenant pays for isolation/residency.
- **Instance per tenant (Silo++):** add a **DB floor + a compute floor (~$30–60/mo) + per-tenant deploy/upgrade ops time** per tenant. Fine for a handful of premium/early customers; doesn't scale to dozens.

### 11.3 Worked example (illustrative)

*Platform with 20 small tenants on Pool+, 2 premium tenants on silo, modest webinar usage:*
- Compute (one `c7a.large` shared + worker): ~$120/mo
- Supabase Pool+ DB (one Pro+ project): ~$100/mo
- 2 silo DBs: ~$50/mo
- Monitoring + DR + storage: ~$60/mo
- → **Platform fixed ≈ $330/mo ≈ ~$15/tenant/mo amortised**, *plus* CDN egress per streamed webinar (~$190 each at 5k/1hr/1Mbps) billed-through or capped, *plus* Stripe fees on the payment (offset by your application-fee revenue).

**The two lessons:** (1) **CDN egress for streamed webinars is the cost that can surprise you** — meter it, cap bitrate, prefer Zoom-embed mode (tenant's cost) for huge audiences, or bill it through. (2) **The DB-per-tenant floor is why Pool+ wins at scale** — silo only for tenants who pay for it.

---

## 12. Security & compliance

- **The isolation test suite is the headline deliverable** (§5.4) — given the IDOR history, prove isolation per PR.
- **RLS as defence-in-depth** under app-level scoping (§5).
- **User identity across tenants** — the genuinely hard modelling question: is a `User` global (one login across tenants) or tenant-scoped (the same email can be a user in two tenants independently)? EA-SYS's `User.email` is globally unique today. For a white-label SaaS, tenant-scoped users are usually right (an attendee at company A's event shouldn't collide with company B's), which means email uniqueness becomes **per-tenant** (`@@unique([organizationId, email])`) and the auth/session must carry the tenant. This is a significant identity refactor — scope it deliberately. (EA-SYS already has org-independent roles like REGISTRANT with `organizationId: null` — reconcile that with the tenant model.)
- **Secrets** — per-tenant integration creds; move toward Secrets Manager/KMS with rotation at scale (§7).
- **Compliance posture** — PDPL/GDPR data processing agreements per tenant, per-tenant data residency (silo enables in-region), right-to-erasure (§9.2), breach isolation. Medical/CME data raises the bar — silo or RLS-with-audited-bypass, never app-scoping-only.
- **Platform-admin power** — the RLS-bypassing privileged role + impersonation are the crown jewels; gate, audit, and time-box them.
- **Penetration testing** focused on cross-tenant access before onboarding sensitive tenants.

---

## 13. Phased roadmap *(recast July 22, 2026 for the two-silo decision — §0)*

**Phase 0 — the spine, built against the new platform instance.** Stand up the **platform** deployment (second box + fresh DB, same image; first-class prod from birth — DR/monitoring/runbooks per §0 guardrail 2; CI gains a second deploy target pulling the same ECR tag). Build the spine there: `TenantDomain` + host→tenant middleware (§3.1); `AsyncLocalStorage` tenant context + pooler-safe `SET LOCAL` (§3.2, §5.2); the 2-tenant **isolation test harness** (§5.4); the org-scoped **slug-routing cut landing atomically with the resolver**. Master receives the identical code inert (one `TenantDomain` row, one tenant).

**Phase 1 — Design & decide (short; partially done).** ~~Topology~~ (✅ §0: two-silo). Still to lock: tenant-scoped user identity; Stripe Connect (Express); custom-domain TLS via Caddy on-demand. Output: remaining decisions ratified + a schema/identity migration plan.

**Phase 2 — Domain-by-domain isolation sweeps (the security project).** Per domain, one recipe: add/backfill `organizationId` (additive + idempotent) → org-bind every query (the services layer makes this one edit, not N route copies) → enable **RLS** on the domain's tables → the domain's isolation tests green. Pilot on **Contacts** (small, already org-keyed) to debug the recipe cheaply, then blast-radius order (`MULTI_TENANCY_IMPACT.md §5`). Close IDOR-class findings + add per-tenant logging (tenant on every Pino line + Sentry scope + `/logs` filter) as domains are swept. **This is the gate — no external tenant onboards until the domains they touch are proven isolated.** On the greenfield platform DB the backfill step is trivial; master only needs it if/when MMG merges in.

**Phase 2 recipe AS EXECUTED — the Contacts pilot (July 23, 2026, commits C1–C5).** The pilot ratified the per-domain recipe as five behavior-preserving steps, each a gated commit:

1. **Compound-where org-bound mutations.** Every by-id mutation gains `where: { id, organizationId }` so the org binding is atomic with the write, not just the preceding `findFirst` (which keeps owning the friendly 404 path). Defence layer #1, independent of RLS.
2. **`tenantTransaction` migration.** The domain's `db.$transaction` sites move to `tenantTransaction` (db.ts) — flag-off it IS `db.$transaction`; array-form transactions convert to a sequential callback loop (pass `{ timeout, maxWait }` for long loops).
3. **ALS wiring.** Every route handler + agent executor that resolves org context wraps its body in `runWithTenant(ctx.organizationId, …)` right after auth/role guards — explicitly per-handler, no HOF/middleware, so the invariant stays greppable ("resolves org context ⇒ wraps in runWithTenant"). Watch TS narrowing: a `session.user.organizationId` guard does NOT survive into the closure — capture a const first. **CI-pinned (July 24, 2026): [scripts/check-tenant-als.sh](../scripts/check-tenant-als.sh)** (gating) requires every swept route dir's handlers to keep their `runWithTenant(` wrap — a require-list that grows one entry per sweep, never shrinks. Necessary because a dropped wrap is silent on master (flag off, tests pass) and only bites on the platform (fail-closed / leak once RLS is on).
4. **`prisma/rls/<domain>.sql`** — the shared per-domain policy file (flat shape, ratified: `USING/WITH CHECK ("organizationId" = current_setting('app.current_org', true))`), applied by BOTH the tenancy harness (global-setup reads `tests/tenancy/policies/*` then `prisma/rls/*`) AND the future platform bootstrap. **Never a prisma migration**: `FORCE` in the chain = instant master outage (owner role + flag off → NULL GUC → fail-closed); even ENABLE-only is excluded by policy so master's DB stays RLS-object-free (auditable via `pg_policies`) and policies stay single-sourced. **No FORCE in shared files** — enforcement comes from the non-owner app role (the harness's two-role split IS the platform's reference architecture); a deployment that must connect as owner adds FORCE in its own bootstrap.
5. **Harness fixtures + tests.** Seed the domain's rows for both orgs (share a per-org-unique key — e.g. the same contact email in both orgs — to prove coexistence + isolation); ~9 assertions: scoped list, deliberately-unscoped miss, cross-tenant id miss, fail-closed no-store, per-org shared-key, WITH CHECK cross-org write block, **defence #1 in isolation** (owner client bypasses the non-FORCE policy → compound-where alone must P2025), both-layers, and a tx rollback shape. Skip re-proving transport (the Event 50-lane interleave covers it).

Also from the pilot: org-blind cross-tenant features (e.g. `contacts-central-sync`) get a hard `TENANCY_ENFORCE_HOST === "1"` refusal — keyed on the deployment flag, NOT an org count (master legitimately has >1 Organization row).

**Domain #2 — MediaFile (July 24, 2026, commit `a444f035`): policy-only.** MediaFile already carries a direct `organizationId` column (the trivial case — no backfill), so this pass landed **step 4** (the flat [prisma/rls/mediafile.sql](../prisma/rls/mediafile.sql), a byte-shape copy of `contact.sql`) + **step 5** (fixtures: the same url in BOTH orgs — MediaFile has no per-org-unique field, so an unscoped `where:{url}` returning only the caller's row is what proves scoping — plus a B-only file + an uploader `User` per org with explicit cross-child-FK cleanup, and an 8-assertion `mediafile-rls.test.ts`; harness 25 → 33) as the **DB backstop (defence #2)** the platform bootstrap runs. **Steps C1–C3 (route compound-where + `runWithTenant`) are deferred** — the media routes org-bind via `findFirst` today and that wiring is only load-bearing once `RLS_SET_LOCAL` turns on; behavior-preserving on master. The `rls-assert` tripwire self-extends via `pg_policy`, so it already covers MediaFile with no code change.

**Domain #3 — BillingAccount (July 24, 2026, commits `ec6b09e5`/`967df18a`/`32a4c43f`): the first FULL finance sweep.** All 5 recipe steps landed: **C1** — `updateBillingAccount` + the merge's delete/update compound-where'd `{ id, organizationId }`, `db.$transaction` → `tenantTransaction`; **C2** — all 8 handlers across the 5 billing routes wrap in `runWithTenant` (the event-nested attach/detach route's shared `gateAndScope` split into `authGuard` before the wrap + `scopeEnds` inside it, so its `BillingAccount` read isn't a false 404 on the platform); **C3** — flat [prisma/rls/billingaccount.sql](../prisma/rls/billingaccount.sql) + a 9-assertion harness test (`@@unique([organizationId, name])` gives the same-name-in-both-orgs fixture; harness 33 → 42). The [check-tenant-als.sh](../scripts/check-tenant-als.sh) gate gained `src/app/api/billing-accounts` + a `SWEPT_ROUTE_FILES` list for the 2 event-nested routes. Cleanly bounded because every BillingAccount mutation lives in one service (no MCP tool, no public-register caller). Behavior-preserving on master.

**Domain #4 — Invoice (July 27, 2026, commits `ead36bd7` C1 / `b7414121` C2a / `0118cb0d` C2b / `6a4b96eb` C3 / `65607a23` C4): the second finance sweep, and the biggest surface — Invoice is written from 13 sites, so C2 split in two.** **C1** — the service's 4 interactive txns → `tenantTransaction`; `transitionInvoiceStatus` gained `organizationId` in its ctx and compound-where's its `findFirstOrThrow` load + status update `{ id, organizationId }`; the promote / parent-flip / sent-stamp / updateMany by-id writes org-bound. **C2a** — `runWithTenant` on the 8 org-scoped staff handlers (`/api/invoices` list+export, the 5 event-nested invoice routes, the staff quote route) + the 4 MCP `invoices` executors. **C2b** — NARROW wraps around only the invoice-write block in the 6 cross-domain writers (Stripe webhook, reconciliation worker, manual payments, documents-resend, public document, `payment-service.issueCreditNoteForRegistration`), leaving their Payment/Registration writes for those domains' own sweeps. **C3** — flat [prisma/rls/invoice.sql](../prisma/rls/invoice.sql) + a 9-assertion harness test (each org gets an Attendee→Registration→Invoice chain; `invoiceNumber` is globally unique so scoping is proven by per-lane counts + unscoped by-number/by-id misses, not a shared value; harness 42 → 51). The [check-tenant-als.sh](../scripts/check-tenant-als.sh) gate gained `src/app/api/invoices` + the 6 event-nested staff routes + `src/lib/agent/tools/invoices.ts`. **Deliberately deferred: the 3 REGISTRANT invoice/quote reader routes are cross-org (`organizationId=null`) — the resource-org binding is the open Phase-1 identity decision — so they're left unwrapped + un-gated;** the C2b cross-domain narrow wraps get pinned when their home domain is swept. Behavior-preserving on master.

**Domain #5 — CrmContact (July 27, 2026): policy-only pass, MediaFile-style.** Unblocked when the CRM deployed July 24 (the "CRM parked / not on prod" blocker died). CrmContact carries a direct `organizationId` (trivial case) and holds the CRM's PII (the org's business-contact book — sponsor reps' emails/mobiles/notes), so it gets its policy before the rest of the `Crm*` family (those land with the future full CRM-domain sweep). Landed: flat [prisma/rls/crmcontact.sql](../prisma/rls/crmcontact.sql) + harness fixtures (`@@unique([organizationId, emailKey])` → the same emailKey in BOTH orgs, all FKs nullable so rows org-cascade with no cross-child cleanup) + an 8-assertion `crmcontact-rls.test.ts` (scoped read, unscoped-emailKey miss, by-id miss, fail-closed no-store, per-lane shared-emailKey, WITH CHECK create-smuggle + org-re-home blocks, cross-tenant DELETE P2025) — **harness 52 → 60 green**. NO defence-#1-in-isolation assertion yet: the CRM services org-bind via lookups but their by-id mutations aren't compound-where'd — that C1/C2 wiring is part of the full CRM sweep. Behavior-preserving on master (policy files never applied there).

**Domain #6 — Webinar/Zoom (July 28, 2026, commits `8b488c8e` schema / `6630c72e` C1 / `6e54bf5e` C2 / C3+C4): the first sweep whose tables did NOT carry `organizationId`, and the first multi-table policy file.** All 6 webinar tables (`ZoomMeeting`, `ZoomAttendance`, `WebinarPresence`, `WebinarPoll`, `WebinarPollResponse`, `WebinarQuestion`) scoped via `eventId → Event` only, so the sweep opened with a **schema step**: migration `20260728140000` adds a nullable denormalized `organizationId` (scalar + index, no FK) to all 6, backfilled from Event in 1/2/3-hop join order — ratifying the "columns over join-policies" call (IMPACT §8.2); verified by a local replay-from-empty + `prisma migrate diff` (no difference). **C1** — every writer stamps the tenant key on create, and the 3 sync state machines re-stamp on their update paths (self-healing blue-green-window NULLs); the engagement poll find-or-create txn → `tenantTransaction`; **4 security findings fixed in-band (owner-approved)**: the `sessions/[sessionId]/zoom` GET/PUT/DELETE (+ its panelists sibling) looked up the ZoomMeeting by `sessionId` alone — a caller owning the URL's event could read (`startUrl` = host credential), update, or **delete another org's meeting incl. the remote billable Zoom meeting** via a foreign sessionId (all lookups now bind `{ sessionId, eventId }`, mutations compound-where); the public `stream-status` `updateMany` gained the event predicate (was unauthenticated-reachable with `{ sessionId }` only); `session-service.syncZoomMeetingTimes` compound-where'd; MCP `list_zoom_meetings` pairs `ctx.eventId` with the org. The bulk-email webinar-template + every webinar-route anchor lookup also bind `eventId` so a stale `settings.webinar.sessionId` can't reach another org's row. **C2** — 37 `runWithTenant` wraps across 22 files: the 12 event-nested staff route files, the 5 public session routes (incl. `zoom-join`/`recording`/`detail`, whose nested ZoomMeeting reads would fail-closed under platform RLS without a store), the 5 webinar MCP executors, and per-row wraps in the 3 sync fns + provisioner (org read off the row; the candidate sweep stays org-blind — the known worker precondition, same as the invoice reconciliation worker). **C3** — [prisma/rls/webinar.sql](../prisma/rls/webinar.sql) (6 flat policies in one domain file) + a 10-assertion [webinar-rls.test.ts](../tests/tenancy/webinar-rls.test.ts) (shared Zoom-meeting-number per-lane, 3-hop `WebinarPollResponse` invisibility, fail-closed across all 6 tables, WITH CHECK smuggle + org-re-home blocks, cross-tenant DELETE, and defence-#1-in-isolation on the session→event compound-where). Its fixtures seed in the test's own `beforeAll` via the owner connection — a deliberate one-off deviation (a concurrent session held uncommitted CRM WIP in `seed-tenancy.ts` + `constants.ts`); fold into the seed later. **C4** — the [check-tenant-als.sh](../scripts/check-tenant-als.sh) gate gained the 17 route files (`SWEPT_ROUTE_FILES`) + 5 modules (`SWEPT_MODULES`), verified both ways. **Platform-only precondition (unchanged by the sweep, same class as the CRM §7.1 global-mailbox note): the streaming stack is a GLOBAL singleton** — one MediaMTX container, one `MEDIAMTX_HLS_URL` / `HLS_CDN_BASE` / `/stream/` path space shared by every tenant; cross-tenant stream isolation is streamKey secrecy only. Before a second tenant runs a **streamed** (HLS-mode) webinar the platform needs per-tenant publish auth on MediaMTX or per-tenant path prefixes. Zoom-embed-mode webinars have no such precondition (Zoom creds are per-org, born tenant-ready per IMPACT §6).

**Domain #7 — CRM policy layer (July 28, 2026, commits `48c4e98b` Group 1 / `a639addb` Group 2): the whole `Crm*` family's RLS backstop, in one policy-only pass.** With CrmContact (#5) as the down-payment, the remaining **16 `Crm*` models** get the flat per-domain policy (byte-shape copies of [crmcontact.sql](../prisma/rls/crmcontact.sql)) — every one carries a DIRECT `organizationId` (the trivial case, no backfill anywhere), unlike Webinar (#6). Landed in two harness-verified commits split by fixture complexity: **Group 1** (10 simple direct-org models — Company, Product, PipelineStage, EmailTemplate, QuoteCounter, EmailSendClaim, Notification, Activity, Task, Note) + **Group 2** (the 6 deal-graph models — Deal, DealContact, DealProduct, DealDocument, EmailThread, EmailMessage, seeded as a Deal-on-its-stage with the children hung off it). New [crm-group1-rls.test.ts](../tests/tenancy/crm-group1-rls.test.ts) + [crm-group2-rls.test.ts](../tests/tenancy/crm-group2-rls.test.ts) prove, per model, scoped-read isolation, cross-tenant by-id miss (USING), fail-closed no-store, cross-tenant DELETE P2025, and the WITH CHECK org-re-home block — **harness 60 → 147 green**, idempotent across consecutive local runs. Two edge cases: **CrmQuoteCounter**'s PK IS `organizationId` with NO Organization FK, so it's excluded from the org cascade (teardown deletes it explicitly) and runs the read/delete subset (create/re-home collide on the PK, not RLS); and the deal-graph teardown deletes the deals BEFORE the org cascade (`CrmDeal→CrmPipelineStage/CrmCompany` are `Restrict`). Group 2 proves WITH CHECK via the re-home UPDATE path rather than a cross-org create-smuggle — its models have RLS-gated required parents, so a smuggle-create could fail on the parent's FK lookup instead of on WITH CHECK; INSERT-side WITH CHECK is proven by Group 1's byte-identical policy. The two junctions (DealContact/DealProduct) carry `organizationId` NULLABLE (blue-green prep) — the flat predicate excludes a NULL-org row, which is correct. NO defence-#1-in-isolation assertion yet: the CRM services org-bind via lookups but their by-id mutations aren't compound-where'd — that C1/C2 wiring is the follow-on. Behavior-preserving on master (no schema/src touched; policy files never applied there).

**Domain #8 — Registration-core (July 28–29, 2026, commits `c56053a4` schema / `50c11db5` C1 / `c6271c67`+`d9929746` C2 / C3+C4): the biggest domain in the system, and the second from the "25 tables without an org column" set.** Scope is the 5 core tables — **Registration, Attendee, Payment, RefundAttempt, RegistrationSerialCounter** — deliberately EXCLUDING TicketType/PricingTier/PromoCode (their own follow-up sweep; the seat/promo counters are id-guarded and RLS-backstopped, documented). **Schema:** migration `20260728160000` adds a nullable denormalized `organizationId` (scalar + index, no FK) to all 5, backfilled 1/2-hop from Event. **Attendee is the hard case** — it has NO event link, so it is stamped ONLY when all its registrations agree on one org (`COUNT(DISTINCT)=1`); orphans + the cross-org-shared rows the old public-register reuse race could mint stay NULL and fail closed. **The serial counter got a flat column specifically** to avoid the join-policy hazard where an `INSERT…ON CONFLICT` against a policy-invisible row raises a unique violation misread as "already registered" (the exact bug the counter was built to fix). Replay-from-empty + `prisma migrate diff` verified. **C1** — every Attendee/Registration/Payment/RefundAttempt/serial writer stamps the key (service, public register, 3 importers, MCP bulk, speaker-companion, email-clone, Stripe webhook, manual payments, refund slices; `getNextSerialId` gained an `organizationId` arg, all 7 callers threaded; the webhook + serial upsert re-stamp on update as self-heal); **22 interactive + 2 array-form `$transaction` → `tenantTransaction`** (array form can't carry `SET LOCAL`); and **7 IDOR-fix clusters in-band (owner-approved)** — the public-register orphan-reuse lookup is now org-bound (one tenant can no longer adopt + overwrite another tenant's attendee PII), and the check-in claims, speaker-companion delete, tickets/tiers PUT+DELETE, bulk-type/badges id-lists, the optimistic-lock write, and the DTCM barcode pre-check + write all gained event binds (the webinar-C1 compound-where class). **C2** — `runWithTenant` on ~28 route files (staff registration + imports, the 8 public register/checkout/survey/promo/complete-registration routes, the Stripe webhook money blocks) + the 7 registration-touching MCP executors + per-row wraps in 3 workers (cert auto-issue, refund-reconciliation, checkout-session-cleanup); the **7 `/api/registrant/**` self-service routes + the sign-in email auto-link sweeps are deliberately NOT wrapped** — cross-org by design, carrying an explicit deferral comment to the Phase-1 identity decision (the Invoice-sweep REGISTRANT-reader class). **C3** — [prisma/rls/registration.sql](../prisma/rls/registration.sql) (5 flat policies) + an 11-assertion [registration-rls.test.ts](../tests/tenancy/registration-rls.test.ts): per-lane scoping, the orphan-reuse-shaped unscoped by-email attendee lookup lane-scoped (both orgs share one attendee email), Payment global-unique `stripePaymentId` cross-tenant miss, fail-closed across all 5, **the serial counter's cross-tenant upsert REJECTED not misrouted** (the flat-column payoff), WITH CHECK smuggle + org-re-home blocks, cross-tenant DELETE, and defence-#1-in-isolation on the eventId-bound `updateMany` shape. Harness **157 → 168** green. **C4** — [check-tenant-als.sh](../scripts/check-tenant-als.sh) gained ~28 route files + 4 modules (verified both ways). **Deferred with rationale:** the registrant/auto-link identity class (Phase-1 decision), the seat/promo counter signature re-plumbing (ids always derive from org-verified reads; RLS is the backstop), and the global-unique namespaces (`qrCode`/`dtcmBarcode`/`stripePaymentId` — platform-precondition notes).

**CRM app-wiring — C1/C2/C4 (July 29, 2026, commits `535a12f9` C1 / `76d9efd7` C2 / `dfc24db2` C4): completes Domain #7.** The policy layer (#5 CrmContact + #7 the rest of the `Crm*` family) gave the DB backstop; this is the app wiring that makes it load-bearing. A read-only defence-#1 audit of all 17 CRM service/worker files found **ZERO caller-facing IDOR gaps** — every caller-driven by-id write is already `updateMany`/`deleteMany` with `organizationId`, or a by-id write on a row proven org-owned by an immediately-preceding org-scoped read (BOUND-via-prior-load). So **C1** reduced to: **12 `db.$transaction` → `tenantTransaction`** across 7 services (7 interactive renames + 5 array-form → interactive-sequential — the array form can't carry the RLS `SET LOCAL`), plus ONE hardening — `pipeline-service` reorder, the lone caller-path by-id `.update({ where: { id } })`, → `updateMany({ where: { id, organizationId } })` to match its `deal-type` reorder sibling. **C2** — `runWithTenant` on **all 42 CRM route files (71 handlers)** after the `requireCrm{Read,Write,Delete,Purge}` guard (`ctx.organizationId` always in scope); the deal cluster adversarially reviewed (list reads via `buildDealWhere` (org-bound), by-id reads org-bound, deal-child document reads BOUND-via-prior-load, mutations through the audited org-bound services — no gap); one wrap at the `agent-tools.safeTool` choke point covers every CRM MCP tool; and per-row wraps on the **2 workers** — `reminders-worker` (`runWithTenant(task.organizationId)`, `continue`→`return`, org-bound claim) and `inbound-email-worker` (wrap `processObject`'s org-known tail keyed on the unique-token-resolved `thread.organizationId` + its array `$transaction` → `tenantTransaction` with an org-bound thread update). **C4** — [check-tenant-als.sh](../scripts/check-tenant-als.sh) gained `src/app/api/crm` (SWEPT_ROUTE_DIRS — all 42 routes) + the 3 executor/worker modules (SWEPT_MODULES), verified both ways (stripping a wrap fails naming the file). NO schema change, NO migration — every `Crm*` model already carried a direct `organizationId`, so this pass is app-layer only. Full gate green per commit: tsc, eslint, vitest 4197, build, tenancy harness (which now includes the Domain #7 CrmDealType fixture at 174). Behavior-preserving on master (`runWithTenant`/`tenantTransaction` passthrough; the compound-where tightens already-org-verified writes). As-executed detail: [CRM_TENANCY_SWEEP.md](CRM_TENANCY_SWEEP.md).

**Domain #8 follow-on — Ticketing (July 30, 2026, commits: schema `4629581f` / C1+C2+C3+C4): the carve-off Domain #8 deferred, closing the seat/promo-counter RLS-backstop gap.** Scope is the 5 ticketing tables — **TicketType, PricingTier, PromoCode, PromoCodeRedemption, PromoCodeTicketType** — the clean case (every row belongs to exactly one Event → no orphans, 100% backfill, unlike Attendee). **Schema:** migration `20260730120000` adds a nullable denormalized `organizationId` (scalar + index, no FK) to all 5, backfilled 1-hop from Event (TicketType, PromoCode) and 2-hop via the now-stamped parents (PricingTier←TicketType, PromoCodeRedemption + PromoCodeTicketType←PromoCode). Replay-safe additive/idempotent. **The key framing — two zones:** the seat/promo counter writers (`soldCount`/`usedCount`) live in the **registration flow already wrapped by Domain #8** (`registration-seat-db.ts`, `promo-code-service` which already uses `tenantTransaction`, the wrapped register/import routes + MCP executors), so they only needed org **stamped on their CREATE sites** + the backfill — this sweep's fresh C2 work is the **management surfaces**. **C1** — 11 CREATE sites stamp the key (tickets + tiers CRUD, event-create default types, clone, promo-code-service create + redemption, register redemption, import ticketType, speaker-companion Faculty type via an event-org lookup, MCP `create_ticket_type`); the promo-codes PUT `$transaction`→`tenantTransaction`; the by-id ticket/tier mutations were already `{ id, eventId }`-bound (defence #1 present). **C2** — 17 `runWithTenant` wraps across the 6 management CRUD route files (tickets, tiers, promo-codes) + the 4 promo-code MCP executors, plus **narrow cross-domain wraps** in `events/route.ts` (the default-ticket-type seed) and `clone/route.ts` (the whole clone tx → `runWithTenant`+`tenantTransaction`) — not gated, same policy as the Invoice C2b cross-domain wraps. The **registrant promo-apply route stays unwrapped** (identity class, same as Domain #8). **C3** — [prisma/rls/ticketing.sql](../prisma/rls/ticketing.sql) (5 flat policies) + an 11-assertion [ticketing-rls.test.ts](../tests/tenancy/ticketing-rls.test.ts): per-lane scoping, 2-hop PricingTier lane-scoping, the SHARED promo-code string (both orgs hold `TENANCY10`) lane-scoped via `@@unique([eventId, code])`, fail-closed across all 5, WITH CHECK smuggle + org-re-home blocks, cross-tenant DELETE, and defence-#1-in-isolation on the `{ id, eventId }` shape. Harness **174 → 185** green. **C4** — [check-tenant-als.sh](../scripts/check-tenant-als.sh) gained the 6 route files + `agent/tools/promo-codes.ts`. Full gate green (tsc/eslint/vitest 4242/build). **Domain #8 is now fully closed** — the deferred seat/promo-counter RLS backstop is in place.

**Domain #9 — Speaker (July 30, 2026, commits: schema `20260730160000` / C1+C2+C3+C4): the first CORE-event-entity sweep, a clean 2-table case.** Scope is **Speaker + SpeakerDocument** — Speaker holds faculty PII + the (faculty + presenter) agreement snapshots, SpeakerDocument the uploaded signed-agreement copies / CVs. **Clean case:** every Speaker has `eventId` (100% backfill, no orphans, unlike Attendee); SpeakerDocument is 2-hop via `speakerId`. **Schema:** migration `20260730160000` adds a nullable denormalized `organizationId` (scalar + index, no FK) to both, backfilled 1-hop (Speaker←Event) then 2-hop (SpeakerDocument←Speaker). Additive/idempotent (`ADD COLUMN IF NOT EXISTS`). **C1** — 8 CREATE sites stamp the key (the `createSpeaker` service, the 3 importers' `createMany`, MCP `create_speakers_bulk`, the event-clone `tx.speaker.create`, the SpeakerDocument upload, and `upsertEventSpeaker` — which gained an `organizationId` arg threaded from its 2 public callers, both of which already resolve `event.organizationId`). The by-id mutations are all **bound-via-prior-load** (an org/event-scoped `findFirst` precedes every write — the CRM-audit-accepted pattern, no compound-where churn), and `speaker-service.updateSpeaker` already binds `{ id, eventId }` (defence #1 present). The one genuinely org-agnostic write — `organization/users/[userId]`'s `speaker.updateMany({ userId })` — is **cross-org BY DESIGN** (unlink the person's speakers across every org; the identity class, same as Domain #8's registrant routes) → left unwrapped + unstamped. **C2** — the whole `speakers/**` route family (12 files / 17 handlers), the CSV `import/speakers` route, the 4 speaker-facing PUBLIC routes (`speaker-agreement`, `presenter-agreement`, `submitter`, `abstract-start` — org via `publicEventWhere` → `event.organizationId`, wrap after the event/token resolution), and the 7 speaker MCP executors all wrap in `runWithTenant`; a NARROW **ungated** wrap on `reviewers/route.ts` (its POST does a `speaker.update` to link a userId — cross-domain, gated when the abstracts/reviewer domain is swept). The speaker LIBS (`speaker-service`, `speaker-companion`, `person-tag-sync`) inherit the caller's wrap — no own wraps. **C3** — [prisma/rls/speaker.sql](../prisma/rls/speaker.sql) (2 flat policies) + a 9-assertion [speaker-rls.test.ts](../tests/tenancy/speaker-rls.test.ts): per-lane scoping, the SHARED speaker email lane-scoped (both orgs hold a speaker on one email — `@@unique([eventId, email])` lets them coexist), 2-hop SpeakerDocument lane-scoping, fail-closed across both, WITH CHECK smuggle + org-re-home blocks, cross-tenant DELETE, and defence-#1-in-isolation on the `{ id, eventId }` shape. Harness **185 → 194** green. **C4** — [check-tenant-als.sh](../scripts/check-tenant-als.sh) gained `src/app/api/events/[eventId]/speakers` (SWEPT_ROUTE_DIRS) + the 5 explicit files (import/speakers + the 4 public routes) + `src/lib/agent/tools/speakers.ts` (SWEPT_MODULES). Full gate green (tsc/eslint/vitest 4311/build). Behavior-preserving on master.

**Domain #10 — Accommodation (July 31, 2026, commit: schema `20260731100000` / C1+C2+C3+C4): the cleanest core case yet.** Scope is **Hotel + RoomType + Accommodation** — hotel/room inventory + the per-attendee/speaker room bookings. **Clean case:** every row maps to exactly one Event → one org, no orphans possible (`Hotel.eventId` 1-hop, `RoomType.hotelId` 2-hop via Hotel, `Accommodation.eventId` 1-hop; 100% backfill). Admin-mostly — no public accommodation routes. **Schema:** migration `20260731100000` adds a nullable denormalized `organizationId` (scalar + index, no FK) to all 3, backfilled 1/2-hop from the owning Event. Additive/idempotent. **C1** — 3 CREATE families stamp the key: `hotel.create` (REST `hotels` POST + MCP `create_hotel` + event-clone), `roomType.create` (REST `rooms` POST + MCP `create_room_type` + clone), and `accommodation.create` (the `accommodation-service` atomic overbooking guard). The service's `db.$transaction` (RoomType.updateMany + Accommodation.create) → **`tenantTransaction`** (swept writes must ride the tenant backend), as do the accommodation-detail PUT/DELETE txs + the MCP `updateAccommodationStatus` tx. By-id mutations are all **bound-via-prior-load** (an org/event-scoped `findFirst` precedes every write — the CRM precedent, hardened further by the July-13 accommodation review), so no write-side compound-where + no defence-#1-in-isolation assertion. The cross-domain room-release on registration/speaker **delete** (`releaseRoomForDeletedPerson`) already runs inside those domains' `tenantTransaction`s (Reg-core + Speaker sweeps) — the accommodation writes inherit the caller's store; `accommodation-rooms.ts` writes only via the passed `tx`. **C2** — the whole `hotels/**` + `accommodations/**` route family (6 files) + the 9 accommodation MCP executors wrap in `runWithTenant`; `accommodation-service` inherits its caller's wrap (no own wrap — the service-layer precedent). **C3** — [prisma/rls/accommodation.sql](../prisma/rls/accommodation.sql) (3 flat policies) + a 9-assertion [accommodation-rls.test.ts](../tests/tenancy/accommodation-rls.test.ts): per-lane scoping, the SHARED hotel name lane-scoped (Hotel/RoomType carry no per-org-unique field), 2-hop RoomType + 1-hop Accommodation lanes each proven independently, fail-closed across all 3, WITH CHECK smuggle + org-re-home blocks, cross-tenant DELETE. Harness **194 → 203**. **C4** — [check-tenant-als.sh](../scripts/check-tenant-als.sh) gained the 6 route files (SWEPT_ROUTE_FILES — nested under events, dir-sweep would over-demand) + `src/lib/agent/tools/accommodations.ts` (SWEPT_MODULES) + `hotel|roomType|accommodation` in SWEPT_MODELS (so the read-placement check covers them). Full gate green. Behavior-preserving on master.

**Domain #11 — Abstract (July 31, 2026, commit: schema `20260731140000` / C1+C2+C3+C4): the first domain with an IDENTITY-EDGE split.** Scope is 5 tables — **Abstract, AbstractTheme, ReviewCriterion** (1-hop from Event) + **AbstractReviewer, AbstractReviewSubmission** (2-hop via Abstract). The wrinkle: the abstract review workflow serves **org-INDEPENDENT** callers — SUBMITTER + REVIEWER accounts have `organizationId = null` — so some routes cannot wrap with the caller's session org. Resolved with a **two-mode wrap** (owner-approved): **(a)** the pure ORGANIZER routes (themes/criteria CRUD, reviewer-pool mgmt, per-abstract reviewer assignment, import — 10 files) wrap with the **session org** (`requireOrgId` → `orgGuard.orgId`); **(b)** the DUAL routes that serve org-null callers (abstracts list/create, the abstract detail GET/PUT/DELETE, submissions GET/POST, my-profile, presenter-agreement — 5 files) wrap with the **RESOURCE org** (`event.organizationId`, loaded FIRST, out of the pre-existing `Promise.all`) — which is non-null and correct even for an org-null submitter/reviewer, so a reviewer's score-submission + a submitter's draft-edit ride the right tenant store. The Webinar-public-route precedent. **Schema:** migration `20260731140000` adds nullable denormalized `organizationId` (+ index, no FK) to all 5, backfilled 1-hop (Abstract/AbstractTheme/ReviewCriterion ← Event) then 2-hop (AbstractReviewer/AbstractReviewSubmission ← Abstract). The reviewer/submitter User is org-independent, but each ROW belongs to the abstract's event's org — so all 5 are org-stampable. **C1** — the create sites stamp org (themes/criteria REST + MCP, abstracts REST create + CSV import, and in `abstract-service` the `abstractReviewSubmission` upsert-create (from `event.organizationId`) + the `abstractReviewer` create (from `input.organizationId`)); the service's status-change `db.$transaction` → `tenantTransaction`. By-id mutations are bound-via-prior-load (CRM precedent). **C2** — the 15 route files wrap per the two-mode split; the 14 abstract MCP executors wrap with `ctx.organizationId`; `abstract-service` inherits its caller's wrap (no own wrap). **DEFERRED: `/api/my-reviews`** — the reviewer-portal feed is cross-org BY DESIGN (unions abstracts across every event/org where the reviewer holds a pool membership or assignment; no single org at request time), so it is left unwrapped + documented, the Phase-1 identity-model decision (same class as the deferred REGISTRANT self-service routes). **C3** — [prisma/rls/abstract.sql](../prisma/rls/abstract.sql) (5 flat policies) + a 10-assertion [abstract-rls.test.ts](../tests/tenancy/abstract-rls.test.ts): per-lane scoping, the SHARED theme name lane-scoped, both 2-hop tables proven independently (incl. the submission addressed by its parent abstractId — the resource-org submissions-route shape), fail-closed across all 5, WITH CHECK smuggle + org-re-home blocks, cross-tenant DELETE. **C4** — [check-tenant-als.sh](../scripts/check-tenant-als.sh) gained the 15 route files + `src/lib/agent/tools/abstracts.ts` + the 5 models in SWEPT_MODELS. Full gate green. Behavior-preserving on master.

**Domain #12 — Sessions/Tracks (July 31, 2026, commit: schema `20260731160000` / C1+C2+C3+C4): the deepest backfill + first composite-PK join tables.** Scope is 5 tables — **Track, EventSession** (1-hop from Event) + **SessionTopic** (2-hop via EventSession) + **SessionSpeaker, TopicSpeaker** (composite-PK join tables, 2-hop / 3-hop — no own `id`, so a scalar denormalized org column). **Schema:** migration `20260731160000` adds nullable `organizationId` (+ index, no FK) to all 5, backfilled from the owning Event in hop order (1-hop Track/EventSession → 2-hop SessionTopic/SessionSpeaker → 3-hop TopicSpeaker). **The heavy core is `session-service`:** `createSession` uses a single NESTED create (session + SessionSpeaker + SessionTopic + TopicSpeaker in one op — the db extension applies SET LOCAL per-op, no tx needed, but EVERY nested child is org-stamped so WITH CHECK admits it on the platform); the update + 2 roster txs → `tenantTransaction` with org stamped on all their creates. `CreateSessionInput`/`UpdateSessionInput`/`RosterOpBase` gained a required `organizationId`, threaded from every caller (REST routes + 5 MCP executors). **C2 — all RESOURCE-org** (like Abstract): the session/track routes use `buildEventAccessWhere` and serve org-null submitters on the agenda GET, so they wrap with `event.organizationId` (loaded first); `lobby-status` (public) wraps via `publicEventWhere`. The zoom + other public session routes (detail/presence/recording/stream-status/zoom-join) were ALREADY wrapped by the Webinar sweep — their existing `event.organizationId` wraps now also scope EventSession. 13 MCP executors (sessions + events/tracks) wrap `ctx.organizationId`. Cross-domain creates stamped: clone (track/session/speaker/topic), import/abstracts (track), webinar-provisioner (anchor session). **The `event-agenda` MCP resource** (flagged as a breadcrumb in the Abstract follow-on) is now wrapped. **C3** — [prisma/rls/session.sql](../prisma/rls/session.sql) (5 flat policies) + a 10-assertion [session-rls.test.ts](../tests/tenancy/session-rls.test.ts): 1/2/3-hop lane-scoping, both composite-PK join tables addressed by parent sessionId/topicId (the agenda/roster read shape), fail-closed ×5, WITH CHECK smuggle + org-re-home, cross-tenant DELETE. **C4** — [check-tenant-als.sh](../scripts/check-tenant-als.sh) gains the 6 route files + `tools/sessions.ts` + `tools/events.ts` + the 5 models. Full gate green. Behavior-preserving on master.

**Domain #13 — Certificates (July 31, 2026, commit: schema `20260731180000` / C1+C2+C3+C4): a large surface (21 route files / 24 handlers + a two-phase cron worker) with the RegistrationSerialCounter flat-column pattern.** Scope is 5 tables — **CertificateTemplate, IssuedCertificate, CertificateIssueRun, CertificateSerialCounter** (1-hop from Event) + **CertificateIssueRunItem** (2-hop via CertificateIssueRun). **CertificateSerialCounter** is a composite-PK counter (`@@id([eventId, type])`) and gets a **FLAT org column** for the RegistrationSerialCounter reason — its atomic `INSERT…ON CONFLICT` serial-allocation upsert against a policy-invisible row would raise a spurious unique violation the app misreads, so the writer stamps a flat column on the create branch. **Schema:** migration `20260731180000` adds nullable `organizationId` (+ index, no FK) to all 5, backfilled 1-hop from Event (Template/IssuedCert/Run/Counter) then 2-hop (RunItem ← Run). **C1 — the heavy part is the SHARED cert-issue libs, done by hand:** certs are actually born deep in the pipeline, so `allocateSerial` gained an `organizationId` param (stamped on the counter's create branch; threaded from all 3 callers), and every `issuedCertificate.create` stamps org — `deliver.issueSingleCertificate`/`issueCertificateBundle` (from `ctx.organizationId`, already on `DeliverContext`), `bundle.findOrIssueCertificate` (new `organizationId` arg, threaded from its 3 callers deliver/bulk-issue/issue-worker), `issue-worker`'s render phase (org threaded processRun → processRenderPhase/processBundleRenderPhase → renderAndStoreItem, from the run's own `organizationId`), and `auto-issue`'s run+item creates (from `reg.organizationId`). The **route creates** stamp too — issue + bulk-reissue (run + items), templates + starter + duplicate (template), MCP `create_certificate_template` — with their `db.$transaction` → `tenantTransaction`. **C2 — all SESSION-org** (certs are admin-issued; `requireOrgId`/`session.user.organizationId` + `denyReviewer`, no org-null callers): all 21 route files' 24 handlers wrap their swept read/write in `runWithTenant(<session org>)`; the 5 MCP executors wrap `ctx.organizationId`. **The WORKER** (`issue-worker.tickAllRuns`) scans candidate runs org-blind then wraps each run's render/send in `runWithTenant(run.organizationId ?? "")` (null → "" → passthrough, the established worker pattern); `auto-issue`'s per-registration wrap already existed (from the Reg-core sweep) — this sweep only added its cert-model org stamps. `getTenantOrgId()` is deliberately NOT used for any data stamp (it returns `""` inside a `runWithTenant("")`, ≠ null). **C3** — [prisma/rls/certificate.sql](../prisma/rls/certificate.sql) (5 flat policies) + an 11-assertion [certificate-rls.test.ts](../tests/tenancy/certificate-rls.test.ts): SHARED template name lane-scoped (MediaFile shape), IssuedCertificate global-unique serial → per-lane count + cross-tenant by-id/by-serial miss (Invoice shape), 2-hop RunItem addressed by parent runId (the worker read shape), the composite-PK counter's cross-tenant by-key miss (the flat-column payoff), fail-closed ×5, WITH CHECK smuggle + org-re-home, cross-tenant DELETE. Harness 223 → 234. **C4** — [check-tenant-als.sh](../scripts/check-tenant-als.sh) gains the `certificates` route dir + `tools/certificates.ts` + `issue-worker.ts` + `auto-issue.ts` (the two workers whose own wrap is load-bearing) + the 5 models. Full gate green. Behavior-preserving on master. **Adversarial review round (Aug 3, 2026 — 0 BLOCKER / 2 HIGH / 4 MED / 7 LOW, no cross-tenant leak, every finding fail-closed-direction + master-inert; HIGHs+MEDs fixed same day):** the sweep's "all 22 handlers" count was wrong (21 route files / 24 handlers — all wrapped), and two whole surfaces were MISSED, not deferred — **(H1)** `survey-thankyou-sweep.ts` (the THIRD cert worker phase: swept Reg/Speaker/IssuedCert/RunItem reads + cover-suppression writes, zero wraps, absent from the gate) now wraps per-row in the event org; **(H2)** the certificate BULK-SEND pipeline (`executeBulkEmail` → `executeCertificateBulkSend` — THE post-event cert fan-out since the June-9 jobification) ran unwrapped in BOTH execution contexts — now wrapped at `scheduled-emails-worker.processRow` (`row.organizationId` — this one wrap also covers every email type's swept Registration/Speaker/Abstract recipient reads) + the MCP `send_bulk_email` executor (`ctx.organizationId`), with NARROW Invoice-C2b-style precheck wraps at the two enqueue routes (`emails/bulk` + `emails/schedule` — their own ScheduledEmail domain stays unswept/ungated). Also fixed: **(M1)** `resend-bundle`'s recipient resolution sat BETWEEN two wraps unwrapped (would 409 NO_RECIPIENT_EMAIL under RLS); **(M2)** `auto-issue`'s per-event template load ran org-blind and its fail-closed `[]` fed the TERMINAL `certAutoIssueCheckedAt` stamp (certs silently lost) — load now runs in the event org resolved from its candidate rows; **(M3)** `allocateSerial`'s counter upsert now re-stamps org on the update branch (conditional — the param is nullable, unlike the registration-serial precedent); **(M4)** the harness gained the 3-part counter-UPSERT proof (own-org increment / cross-tenant REJECT / owner-view untouched — the flat-column payoff, previously only the by-key-miss precondition was tested). Harness 255 → 256. **The 7 LOWs shipped same day too** (owner call — L2/L5/L6's failure mode is silence, so "wait for an issue" can't catch them): email-preview's whole body wraps in the **resource org** (it serves org-null SUPER_ADMIN; `buildRealPreviewOverrides` + the sample nested selects moved inside), the worker's `!run` early-return warns `cert-issue:run-invisible-to-tenant-read`, template DELETEs compound-where `{ id, organizationId }` (route + MCP) with a defence-#1-in-isolation harness assertion (harness → 257), the gate's duplicate `auto-issue.ts` entry deduped, `CertificateBulkSendInput.organizationId` made required, and the cert-row org stamp pinned in the bundle + deliver unit suites. Full record: ROADMAP §"Certificates tenancy-sweep review — LOWs".

**Domain #14 — Session Proposals (August 3, 2026, commit: index migration `20260803120000` / C1-already-done + C2/C3/C4): the first "born multi-tenant-ready" sweep — RLS + wraps only, no org column, no backfill, no stamp work.** Scope is 2 tables — **SessionProposal + SessionProposalTheme**, both 1-hop from Event. Both were created (July 30, 2026) carrying a denormalized nullable `organizationId` already stamped at every create site (the LoginEvent/HelpChatQuery convention), so **C1 was pre-done**: the two create sites (proposals POST, themes POST) already stamp org, there is no `$transaction` to convert, and there are **no MCP tools + no cron worker** (v1 is an organizer inbox). **The only schema change is an additive index-only migration** (`20260803120000`) adding `@@index([organizationId])` to SessionProposalTheme so the RLS predicate is indexable — SessionProposal already had one. **C2 — the identity-edge dual-route pattern (like Abstract):** the submission surface serves org-INDEPENDENT SUBMITTERs (`organizationId = null`), so the proposals list/create + detail (GET/PUT) + the theme GET are DUAL routes wrapped with the **RESOURCE org** (`event.organizationId`, loaded first, un-wrapped — Event isn't swept — then the swept read/write rides its lane); the theme write routes (POST + `[themeId]` PUT/DELETE) + the proposal DELETE are org-staff only, wrapped with the **SESSION org**. Every handler was restructured so the un-wrapped Event load precedes the wrap (the read-placement rule). **This sweep also closed a pre-existing latent gap:** `submitter-context/route.ts` read `Speaker` (swept #9) + `_count` of `Abstract` (#11) + `SessionProposal` (#14) **un-wrapped** (missed by the Speaker/Abstract sweeps) — now wrapped with the resource org. **C3** — [prisma/rls/sessionproposal.sql](../prisma/rls/sessionproposal.sql) (2 flat policies) + a 10-assertion [sessionproposal-rls.test.ts](../tests/tenancy/sessionproposal-rls.test.ts): SHARED theme name lane-scoped (SessionProposalTheme has no per-org unique field — the MediaFile shape), the proposals-list nested-Speaker-include read shape resolves on one lane, per-lane count + cross-tenant by-id/by-theme miss, fail-closed ×2, WITH CHECK smuggle + org-re-home, cross-tenant DELETE. Harness 234 → 244. **C4** — [check-tenant-als.sh](../scripts/check-tenant-als.sh) gains the `session-proposals` + `session-proposal-themes` route dirs + `submitter-context/route.ts` (SWEPT_ROUTE_FILES) + the 2 models. Full gate green. Behavior-preserving on master. **1 test-mock fix** (submitter-context route test: `event.findUnique` added to the `@/lib/db` mock for the new resource-org load).

**Domain #15 — Dinner RSVP (August 3, 2026, commit: migration `20260803130000` / C1+C2/C3/C4): 3 tables, RsvpDinner + RsvpInvite (1-hop from Event) + RsvpDinnerResponse (2-hop via RsvpInvite).** None carried an org column, so this is a full add-column sweep (unlike the born-ready #14). **Schema:** migration `20260803130000` adds a nullable denormalized `organizationId` (scalar + index, no FK) to all 3, backfilled 1-hop from Event (dinner, invite) and 2-hop via RsvpInvite (response); additive + idempotent + blue-green safe; `prisma migrate diff` = "No difference detected". **C1** — every create stamps the key (dinner POST, invite bulk `createMany`, the public response `createMany`); the public submit's `db.$transaction` → `tenantTransaction` (it opens its own pooled backend, so it must SET LOCAL its own GUC — a plain `$transaction` inside the wrap would run un-scoped and fail-close). **C2 — the identity-edge dual-route pattern (like Abstract/#14):** the organizer routes serve an org-null SUPER_ADMIN via `buildEventAccessWhere` (so `requireOrgId`'s session-org 403 is wrong here), so dinners CRUD + rsvp-invites roster/add/delete/send all load the (un-swept) Event FIRST for `event.organizationId`, then wrap the swept reads/writes with the **RESOURCE org**; the MCP `list_dinner_rsvps` wraps with the **session (API-key) org**. **The public token route is the subtle one:** `/api/public/events/[slug]/rsvp/[token]` reads RsvpInvite by its GLOBALLY-UNIQUE token — now a swept table, so a token read with NO tenant context fail-closes to null (every link looks invalid). It resolves the tenant org from the Event by host+slug FIRST (`publicEventWhere`, the webinar-public precedent) and runs the token lookup + the replace-all `tenantTransaction` inside `runWithTenant(that org)`; the existing `invite.event.slug === slug` + `eventMatchesRequestTenant` asserts stay as defense-in-depth. The **dashboard setup-page** `db.rsvpDinner.count` is left un-wrapped — it reads `db.invoice.count` (swept #4) un-wrapped already, so server-component reads of swept tables are a known, deliberately-deferred systemic gap, out of scope here. **C3** — [prisma/rls/rsvp.sql](../prisma/rls/rsvp.sql) (3 flat policies) + an 11-assertion [rsvp-rls.test.ts](../tests/tenancy/rsvp-rls.test.ts): the SHARED invitee email lane-scoped (RsvpInvite has no per-org unique on email — both orgs invite the same address), the **globally-unique-token cross-tenant miss** (findUnique({ token: B }) under A's store → null, the public-bootstrap proof), the 2-hop RsvpDinnerResponse lane-scoped by inviteId, per-lane counts, fail-closed across all 3, WITH CHECK smuggle ×2 + org-re-home block, cross-tenant DELETE P2025. Harness 244 → 255. **C4** — [check-tenant-als.sh](../scripts/check-tenant-als.sh) gains the `dinners` + `rsvp-invites` route dirs, the public `rsvp/[token]` route file, `agent/tools/dinner.ts`, and the 3 models. Full gate green. Behavior-preserving on master.

**Domain #16 — Survey (August 3, 2026, migration `20260803150000`): 1 table, SurveyResponse (1-hop from Event) — the smallest sweep yet.** **Schema:** nullable denormalized `organizationId` (scalar + index, no FK), backfilled 1-hop from Event; additive + idempotent + blue-green safe. **C1** — the ONE writer (the public survey submit — token / share / self-identify paths, already wrapped + `tenantTransaction`'d by the Reg-core sweep, which had also gated the route file) now stamps `registration.event.organizationId` on the create. **C2 — the RESOURCE-org pattern:** the two dashboard readers (responses list/aggregate + CSV export) authorize via `buildEventAccessWhere` (org-null SUPER_ADMIN reaches them), so both load the un-swept Event first and wrap the swept `SurveyResponse` reads (+ their nested swept Registration/Attendee selects) in `runWithTenant(event.organizationId)`. The sibling `survey/share-link` route touches only unswept Event — deliberately not swept. Repo-wide census confirmed no other readers (no MCP tools, no worker, no nested `surveyResponse:` relation reads; the cert auto-issue keys off `Registration.surveyCompletedAt`, not this table). **C3** — [prisma/rls/survey.sql](../prisma/rls/survey.sql) (1 flat policy) + a 7-assertion [survey-rls.test.ts](../tests/tenancy/survey-rls.test.ts): per-lane counts + scoped read, cross-tenant by-id miss, the **globally-unique `registrationId` dedup-gate read** cross-tenant miss (the IssuedCertificate-serial shape), the dashboard `findMany({ eventId })` shape at the other org's event → empty, fail-closed, org-re-home UPDATE block (the WITH CHECK proof — a create-smuggle has no insertable fixture since `registrationId` is a globally-unique FK and both seeded registrations hold a response; documented in the test header), cross-tenant DELETE P2025. Harness 257 → 264. **C4** — [check-tenant-als.sh](../scripts/check-tenant-als.sh) gains the `survey/responses` route dir + the `surveyResponse` model. Full gate green. Behavior-preserving on master.

**Domain #17 — Reimbursement (August 3, 2026, migration `20260803160000`): 2 tables, SpeakerReimbursement (1-hop from Event) + SpeakerReimbursementDocument (2-hop via the reimbursement) — the last clean core domain.** **Schema:** nullable denormalized `organizationId` (+ index, no FK) on both, backfilled 1-hop then 2-hop; additive + idempotent + blue-green safe. **C1** — both create sites stamp: the console's add-speakers `createMany` (from the resource event) and the public upload's document create (from the loaded row's event). **C2 — both patterns in one domain:** the dashboard console (list/add + detail/reopen/delete + document stream + send) authorizes via `buildEventAccessWhere` → **RESOURCE-org** wraps (org-null SUPER_ADMIN reaches it); the `[reimbursementId]` helper returns `{ organizationId, row }` (the Dinner `[dinnerId]` shape) so PATCH/DELETE reuse the org, and the DELETE became compound-where `{ id, eventId }` (atomic bind with the write, the L3 lesson — deliberately NOT on the nullable org column, which would 500 legacy NULL rows on master). The **3 public token routes** hit the swept-table-by-globally-unique-token fail-close: new `resolveReimbursementEventOrg(req, slug)` in [src/lib/reimbursement/server.ts](../src/lib/reimbursement/server.ts) resolves the org from the un-swept Event by host+slug (`publicEventWhere`, the RSVP pattern), then each handler wraps its whole body (loader + conditional-claim submit / upload+stamp / doc delete); `loadReimbursementForSlug`'s slug + `eventMatchesRequestTenant` asserts stay as defense-in-depth. `activity-feed.ts`'s reimbursement read verified inside the already-wrapped speaker-activity route. **C3** — [prisma/rls/reimbursement.sql](../prisma/rls/reimbursement.sql) (2 flat policies) + an 8-assertion [reimbursement-rls.test.ts](../tests/tenancy/reimbursement-rls.test.ts): globally-unique **token** + **speakerId** cross-tenant misses (the public-bootstrap proof ×2), 2-hop document by parent id + by-id miss, per-lane counts, fail-closed ×2, WITH CHECK smuggle on the DOCUMENT (the insertable 2-hop child — the speakerId-unique parent has no insertable fixture), org-re-home UPDATE block, cross-tenant DELETE P2025. Harness 264 → 272. **C4** — [check-tenant-als.sh](../scripts/check-tenant-als.sh) gains the console dir + the public `reimbursement` dir + both models (`server.ts` is a runs-inside-wraps lib, documented not-listed). Full gate green. Behavior-preserving on master.

**Domain #18 — Comms-log: EmailLog + ScheduledEmail (August 3, 2026, migration `20260803170000`): the first of the entangled trio, unblocked by the owner's "keep them, hidden" decision on NULL-org rows.** **Schema:** both tables already carried `organizationId` (ScheduledEmail non-null + FK'd since birth; EmailLog nullable) — the migration only adds ScheduledEmail's `@@index([organizationId])` (RLS predicate) and **backfills EmailLog's derivable NULL-org rows** (1-hop from the tagged Event, else via the owning Registration/Speaker's swept org columns or Contact's native org); genuinely org-less rows (auth emails to org-null accounts) deliberately stay NULL. **C1 — the logEmail choke point:** EmailLog has ONE writer, so org attribution + the RLS lane are established there for every sender: explicit context org wins, else the org resolves 1-hop from the tagged event (closing the historical several-senders-thread-eventId-but-not-org class behind the `getEmailLogsFor` OR-null fallbacks), and the insert **self-wraps** in `runWithTenant(resolvedOrg)` so stamped rows ride their lane regardless of caller context (auth routes included); failure-isolated (a lookup blip degrades to an un-attributed row, never a lost one). **The asymmetric-policy discovery:** Prisma's `create()` emits `INSERT..RETURNING`, and **RETURNING must pass the SELECT-side USING check** — which deliberately hides NULL-org rows — so the null-org branch writes via `createMany` (plain INSERT, admitted by the WITH CHECK carve-out); pinned in both the unit suite and the harness (a `create()` probe on the same shape is asserted rejected). **C2:** the EmailLog read surface (`/api/email-logs` list + stored-body fetch, both session-org) + the event Email Activity rollup wrapped; the **whole worker `processRow`** (claim / heartbeat / callbacks / terminal writes) now runs on the row's org lane (supersedes the earlier narrow Certificates-H2 wrap around `executeBulkEmail` alone — ALS propagates into the heartbeat timer + fire-and-forget chains); all 4 ScheduledEmail enqueue/management routes wrapped session-org (the two narrow Invoice-C2b precheck wraps superseded by whole-handler wraps); MCP `list/cancel_scheduled_email` wrapped ctx-org (cancel's bare update-by-id also org-bound — defence #1); the `reimbursements/send` **EmailLog dedup read** wrapped resource-org (it fail-closed while its candidate read succeeded → would have RE-MAILED the whole batch — the fail-closed-read-feeding-a-terminal-action class); the survey-thankyou sweep's EmailLog dedup documented as inseparable from its org-blind candidate scan (both fail-close together; never split their lanes). `webinar-email-sequence.ts` verified runs-inside-wraps (sequence route + provisioner + public register all wrap). **Worker/ops preconditions (documented, not fixed):** the scheduled-emails tick scan + stuck sweep, the **email-log-prune job** (under RLS it would silently see zero rows and STOP PRUNING → unbounded htmlBody growth), and the SUPER_ADMIN ops reads in `infra/aws-ops.ts` are org-blind by design — the platform runs them on a privileged maintenance lane. **C3** — [prisma/rls/emaillog.sql](../prisma/rls/emaillog.sql): EmailLog's **asymmetric** policy (`WITH CHECK (org IS NULL OR org = setting)`, strict USING) + ScheduledEmail's flat policy; a 10-assertion [emaillog-rls.test.ts](../tests/tenancy/emaillog-rls.test.ts): SHARED `to` address lane-scoped (no per-org unique field — the MediaFile shape), both asymmetry halves (bare createMany admitted → invisible from BOTH lanes AND bare reads; the create()-RETURNING rejection pinned), smuggled-stamp rejection (the carve-out is no bypass), the **worker CLAIM shape** cross-tenant miss (`updateMany PENDING→PROCESSING` on B's row under A → count 0, B still claimable), fail-closed ×2 WITH the null row present, org-re-home block, DELETE P2025. Harness 272 → 282. **C4** — [check-tenant-als.sh](../scripts/check-tenant-als.sh) gains the `email-logs` dir + the 5 emails/email-activity route files + `email-log.ts` (module) + both models. Full gate green. Behavior-preserving on master.

**Sweep queue (not yet swept):**
- **Remaining domains — the last two, each blocked on a recorded decision:** HelpChatQuery (SUPER_ADMIN global read conflicts with RLS — the act-as-tenant decision), AuditLog (no flat org column + every mutation writes it + the `recordExport` attribution item below). Registration-core + ticketing + finance + CRM + webinar + Speaker + Accommodation + Abstract + Sessions/Tracks + Certificates + Session Proposals + Dinner RSVP + Survey + Reimbursement + **Comms-log (EmailLog/ScheduledEmail)** are done.
- **AuditLog-sweep checklist item (from the Survey review, Aug 3):** the `recordExport`/`recordImport` call sites attribute `session.user.organizationId` (NULL for org-null SUPER_ADMIN) and sit OUTSIDE the tenant wraps — when AuditLog sweeps, switch them to the resource org + decide wrap placement for ALL callers at once (the survey-export route is one instance of the repo-wide convention).
- **Platform data-migration checklist item (from the Survey review):** a legacy NULL-org Attendee row 500s the public survey submit under RLS (the in-tx `attendee.update` P2025s, not the caught P2002) — the Reg-core backfill deliberately left conflicted/orphan attendees NULL, so any legacy-data migration onto the platform must resolve them first. Greenfield platform + master (RLS off) unaffected.
- ~~**CRM app-wiring (C1/C2/C4)**~~ — ✅ **DONE (July 29, 2026)**, see the "CRM app-wiring" entry above + [CRM_TENANCY_SWEEP.md](CRM_TENANCY_SWEEP.md). The whole `Crm*` domain (policy layer #5 + #7 + this app-wiring) is now fully swept — the pre-audit gap list here turned out to be overcautious (the audit found zero caller-facing IDOR gaps; only `pipeline:390` needed hardening).

6. **The RLS tripwire (review H1; owner decision: refuse to boot).** No-FORCE means enforcement lives in the connection role — so a deployment that applies the policies but wires an OWNER connection (Supabase's *default* string) would silently no-op every policy. `src/lib/tenant/rls-assert.ts` closes the hole: under `RLS_SET_LOCAL=1`, both the web tier (`src/instrumentation.ts`) and the worker (`worker/index.ts`, before any schedule registers) assert `row_security_active()` on every policied table (self-extending via `pg_policy` — no hand-kept list) and **refuse to boot** if the role bypasses RLS or zero policies were applied. Flag off (master): zero-cost no-op. The harness pins the mechanism (assert resolves as app_user, refuses as owner).

**Phase 3 — Platform features.** Custom-domain TLS automation + verification; **Stripe Connect** (onboarding, destination charges, Connect webhooks, refunds); per-tenant email sender-domain verification; self-serve onboarding pipeline; per-tenant quotas + the **Redis** rate limiter (platform-instance concern; master's single-container in-memory limiter is fine as-is); zero-downtime deploys; impersonation + suspension/lifecycle. **Dogfood gate (§0 guardrail 3): one real/shadow MM Group event runs on platform before customer #1.**

**Phase 4 — Scale & consolidate.** Per-tenant cost attribution + usage billing; capacity planning for concurrent big webinars; promote heavy tenants to DB-per-tenant silo *within platform*; **the §0 re-evaluation trigger fires here** — decide merge-MMG-into-platform vs silo-forever. DR fan-out; the worker session-mode (`DIRECT_URL`) lock fix before any second worker shares a DB.

---

## 14. Decision summary & recommendations for EA-SYS

| Decision | Recommendation | Why |
|---|---|---|
| **Topology** | ✅ **DECIDED July 22, 2026: two-silo** — master (MMG-only, current box) + platform (all external tenants, Pool+, fresh DB); one repo, one image, two deploy targets (§0) | Worst-case asymmetry: pooled-plan failures are safety failures on live events; two-silo failures are bounded cost/discipline failures. Greenfield RLS. |
| Isolation default (platform) | **Shared DB + RLS (Pool+)** | SaaS economics; Supabase-native; fixes the IDOR-class risk by enforcing in the DB |
| Isolation premium | **DB per tenant (Silo)** for regulated/high-value — *within* platform, never a separate app instance | Physical separation + residency for those who pay; silos capped at two (§0) |
| First customer | ✅ **DECIDED: on the platform instance (Pool+)** — supersedes the Silo++-per-customer lean | A third environment would start the silo-per-tenant slide |
| Tenant resolution | **Host → `TenantDomain` in middleware**, cached | Custom domains are the white-label requirement |
| TLS | **Caddy on-demand TLS** (custom domains) + wildcard (subdomains) | Lowest-ops auto-issuance |
| Tenant context | **`AsyncLocalStorage` + Prisma extension `SET LOCAL`** | Works under pgbouncer transaction mode; drives RLS without manual threading |
| Payments | **Stripe Connect (Express), destination charges + application fee** | Tenant's money → tenant's account; you take a fee; you're not an MSB |
| Users | **Tenant-scoped identity** (`@@unique([organizationId, email])`) | A white-label tenant's users shouldn't collide across tenants |
| Rate limiting | **Redis-backed, per-tenant** | The in-memory limiter resets on deploy + isn't shared — untenable at scale |
| Logging | **Tenant on every log line + Sentry scope + `/logs` filter** | "What happened for tenant X" in seconds; noisy-neighbour detection |
| Biggest cost watch | **CDN egress for streamed webinars** | Can dwarf everything else per event — meter/cap/bill-through |
| The gate | **Tenant-isolation test suite + RLS before any shared-infra tenant** | The IDOR history says app-scoping alone is not safe |

---

## 15. Anti-patterns & pitfalls

- **"It's already org-scoped, multi-tenant is a flag."** No — the audit found cross-tenant IDOR. App-scoping alone is not provable isolation. RLS + an isolation test suite is the real work.
- **A code fork per deployment** ("keep the master and redo everything in a copy") — the two-silo plan (§0) is one repo / one image / two deploy *targets*. A forked repo or long-lived divergent branch doubles maintenance, drifts within weeks (see the July 2026 cross-caller duplication audit for what drift does *inside one repo*), and turns two deployments into two products. Behavior differences are data/env-driven, never code-conditional.
- **Shipping a new table without an RLS policy** in a Pool+ DB — a silent leak. Enforce in CI.
- **Becoming a money-services business** by collecting + remitting instead of Stripe Connect — compliance/liability you don't want.
- **In-memory rate limiting at platform scale** — resets on deploy, per-container; one tenant's abuse or your own deploy removes protection. Move to Redis.
- **Forgetting CDN egress** — a single 5k streamed webinar can cost more than a month of compute. Meter and cap.
- **A privileged RLS-bypass connection used as the default path** — one bug and isolation is gone. Use it only for explicit, audited cross-tenant jobs.
- **Manual onboarding** — doesn't scale; every step (domain, TLS, Stripe, sender-domain) must be automated + state-tracked.
- **Migrating MM Group's live prod into the shared DB early** — do it last, risk-managed, after isolation is proven.
- **Global uniqueness left global** (event slug, user email) — collides across tenants. Audit every `@unique`.
- **Per-tenant DB-per-tenant by default** — the per-tenant DB floor + N-way migrations sink you at scale. Silo is a premium tier, not the default.

---

## 16. Glossary

- **Tenant** — a customer organization (`Organization`) with isolated data, branding, domain, and integrations.
- **Pool / Bridge / Silo** — shared infra / mixed / dedicated infra per tenant (AWS SaaS terms).
- **RLS (Row-Level Security)** — Postgres feature enforcing per-row access rules; here, tenant isolation in the database itself.
- **Stripe Connect** — Stripe's platform model; tenants are connected accounts, you take an application fee.
- **`SET LOCAL`** — a transaction-scoped Postgres session variable; how the tenant id reaches RLS under transaction-mode pooling.
- **Noisy neighbour** — one tenant's load degrading others on shared infra.
- **Blast radius** — how many tenants an incident can affect.
- **Tenant-isolation test suite** — automated tests proving tenant A cannot access tenant B's data; the safety net for multi-tenancy.

---

*Companion docs: `ARCHITECTURE.md` (current single-org architecture), `AWS_OPERATIONS.md` (ops + the add-Cloudflare-later playbook), `LIVE_STREAMING.md` (the 5k HLS/CDN design), `ROADMAP.md` (deferred items that become mandatory at multi-tenant scale), `HANDOVER.md`. This doc is the forward-looking multi-tenant reference. **EA-SYS runs single-org (master) today** — the multi-tenant *platform* deployment does not exist yet. But the §0 topology decision (two-silo) is made, **the Phase-0 spine is built** (see the §0 build status), and the **Phase-2 per-domain sweeps are underway** — Contacts + BillingAccount + Invoice + Webinar/Zoom + Registration-core + the whole CRM (`Crm*`) family (full sweeps — CRM = policy layer CrmContact + Groups 1–2 **plus C1/C2/C4 app-wiring, DONE July 29**; see [CRM_TENANCY_SWEEP.md](CRM_TENANCY_SWEEP.md)) + MediaFile (RLS policy + route wiring) have landed, all behavior-preserving on master, and the swept-domain `runWithTenant` invariant is CI-gated ([check-tenant-als.sh](../scripts/check-tenant-als.sh)).*
