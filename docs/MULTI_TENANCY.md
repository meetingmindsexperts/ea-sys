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
- **Resolution in middleware** (`src/proxy.ts` / Next middleware): read the `Host` header → look up `TenantDomain` → attach `organizationId` to the request (header, or via a request-scoped store). Cache the host→org map in-process (it changes rarely) with a short TTL — this is a per-request hot path (same micro-cache pattern used for the webinar `lobby-status`).
- **Edge case:** the marketing site / signup / platform-admin live on the *apex* platform domain, not a tenant domain. Route those before tenant resolution.

### 3.2 Tenant context propagation

The resolved tenant must reach the data layer on **every** code path (API route, server component, server action — though EA-SYS uses none today, cron, webhook). Options:
- **Explicit threading** — pass `orgId` into every service/query. Verbose but obvious; EA-SYS already does much of this via `getOrgContext`.
- **`AsyncLocalStorage`** — a per-request store holding the tenant, read by a Prisma client extension that injects the RLS session var (see §5). This is the cleanest for RLS because the DB filter doesn't depend on the developer remembering to pass `orgId`.

**Recommendation:** keep explicit scoping at the app layer (defence #1) **and** add RLS via `AsyncLocalStorage` + a Prisma extension (defence #2). Belt and braces — exactly because the audit showed defence #1 alone is fallible.

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

*Companion docs: `ARCHITECTURE.md` (current single-org architecture), `AWS_OPERATIONS.md` (ops + the add-Cloudflare-later playbook), `LIVE_STREAMING.md` (the 5k HLS/CDN design), `ROADMAP.md` (deferred items that become mandatory at multi-tenant scale), `HANDOVER.md`. This doc is the forward-looking multi-tenant reference; it does not describe shipped code — EA-SYS is single-org today. The §0 topology decision (two-silo) is made; the build has not started.*
