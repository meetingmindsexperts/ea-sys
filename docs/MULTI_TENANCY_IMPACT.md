# Multi-Tenancy — Impact & Blast-Radius Assessment

> **Companion to [docs/MULTI_TENANCY.md](MULTI_TENANCY.md).** That doc is the
> *conceptual* reference (tenancy models, RLS, Stripe Connect, cost model). **This
> doc is the codebase-grounded impact analysis**: exactly where single-org
> assumptions live today, what must change to go multi-tenant, the **blast radius**
> (what breaks / what leaks if done wrong), and how breaking vs additive each change
> is. Produced from a 3-lens read-only audit of the actual code (June 24, 2026) —
> org-scoping/isolation, schema/identity, and payments/integrations/infra.
>
> **Read [MULTI_TENANCY.md](MULTI_TENANCY.md) first for the target architecture**
> (shared-DB + Postgres RLS default; DB-per-tenant premium; host→tenant routing;
> tenant-scoped identity; Stripe Connect). This doc assesses the gap to *that* target.
>
> **Topology DECIDED July 22, 2026 — the two-silo plan** ([MULTI_TENANCY.md §0](MULTI_TENANCY.md)):
> master (current box, MM Group only) + a new **platform** instance (fresh DB, all
> external tenants, Pool+ with RLS from day one), one repo / one image / two deploy
> targets. Consequence for this doc: the RLS enablement + `organizationId` backfills in
> §2/§6 land on the **greenfield platform DB**, not on MMG's live DB — the live-DB
> risk called out below applies only if/when MMG merges in (deferred to the §0
> re-evaluation trigger). The findings themselves (what must be scoped, what leaks)
> are unchanged.

---

## 0. Executive verdict

**EA-SYS is well-disciplined for single-org, but far from safe tenant isolation.** The
discipline is real — `denyReviewer`, `getOrgIdSecure`, `buildEventAccessWhere`, finance
redaction, two audit rounds. But every one of those is **application-layer and opt-in**.
There is **zero database-level isolation today**: 0 RLS policies, 0 per-request tenant
session vars. Isolation is **by convention** — every query author must remember
`where organizationId`, and the audits prove that convention leaks (IDOR found in May
*and* June).

Going multi-tenant safely is **months of foundational work, not a hardening pass**:
denormalization/backfill for RLS, identity rework, slug-namespace routing, Stripe
Connect, per-tenant email. The **good news**: the *patterns to copy already exist in
the repo* (`getOrgIdSecure` as the central guard; `@@unique([organizationId, slug])`
already used on `Event`, `EmailTemplate`, `Contact`, `BillingAccount`), so the design
direction is clear even though the surface area is large.

### The single most dangerous latent bug (fix-worthy *regardless* of multi-tenancy timeline)

**Every public route resolves `findFirst({ where: { slug } })` with no `organizationId`
filter** — across ~15 routes (`public/events/[slug]/route.ts:31`, lobby-status, stream-status,
register, survey, presence, validate-promo, …). `Event.slug` is **already**
`@@unique([organizationId, slug])` (schema is correct), so it is **only unique per-org**.
Today this is "correct by accident" (one org). **The instant a second org exists with a
duplicate slug, `findFirst` returns whichever row matches first → another tenant's event
data served on a public URL**, then memoized 3s by the lobby/stream micro-caches. This is
the highest cross-tenant leak surface in the system and the first thing host→tenant
routing must close.

---

## 1. Impact summary (by subsystem)

| # | Area | Current state | Risk | Effort | Breaking? |
|---|---|---|---|---|---|
| 1 | **No RLS + 25/33 tenant models lack an `organizationId` column** | Isolation by-convention only; ~25 models scoped only via `eventId→Event` | **High** | **L** | additive policies, but design-heavy |
| 2 | **Public slug routing ignores org** (`where:{slug}`, no org) | Systemic across ~15 routes + micro-caches | **High** | **M** | breaking (must land with host routing) |
| 3 | **`User.email` global-unique** (tenant-scoped identity) | One email = one global user; org-null roles | **High** | **L** | **breaking — cannot be 1-step** |
| 4 | **193 `organizationId!` assertions + IDOR-by-convention** | No central data-access guard; `null!` matches all org-null rows | **High** | **M** | non-breaking (RLS + lint) |
| 5 | **Payments: single Stripe account → Connect** | One platform account; no connected-account/app-fee | **High** | **L** | additive cols, breaking flow |
| 6 | **Host → tenant routing absent** | `Host` used only for CSRF; no domain→org map | **High** | **L** | new table + middleware |
| 7 | **Email sender: one SES domain, no per-tenant DKIM** | Shared identity; `From` is cosmetic, on Event | **Med-High** | **M-L** | additive |
| 8 | **File storage not tenant-isolated** | Paths keyed by date+uuid, public unauth read (certs are event-scoped) | **Med** | **M** | additive prefix + serve-guard |
| 9 | **Logging not tenant-tagged**; `/logs` global | `SystemLog` has no `organizationId`; viewer SUPER_ADMIN-only | **Med** | **M** | additive |
| 10 | **Rate limiter in-memory/per-container**; some IP-only buckets | Resets on deploy; not shared across containers | **Med** | **M** | additive (swap store) |
| 11 | **Worker: no per-tenant fairness + pooler-lock caveat** | Global FIFO drain; advisory lock not safe across 2 workers | **Med** | **M** | non-breaking |
| 12 | **Secrets: AES key = global `NEXTAUTH_SECRET`** | Row-isolation yes, key-isolation no | **Med** | **M** | additive |

**Already multi-tenant-ready — do NOT redo:** Zoom creds + token cache (per-org), EventsAir
creds (per-org), branding (`logo`/`primaryColor` per-org), company/invoice identity per-org,
the MCP/API-key/OAuth surface (`getOrgIdSecure` 404-on-mismatch), and the schema uniques on
`Event.slug`, `Contact.email`, `BillingAccount.name`, `AbstractTheme.name`, all event-keyed
counters. The integration-credential layer (`Organization.settings.{zoom,eventsAir}`) is the
hard part already done right.

---

## 2. Detail — isolation & RLS (the central project)

### 2.1 No RLS, and most tables can't take a flat policy
- **Evidence:** `grep "ROW LEVEL SECURITY|CREATE POLICY" prisma/migrations` → **0**. No `SET LOCAL`/`current_setting`/`set_config` anywhere. Prisma talks to Supabase directly with no per-request tenant context.
- **Structural complication:** of ~33 tenant-owned models, **only ~7 carry a direct `organizationId` column** (Organization, User, Event, Contact, MediaFile, Invoice, ScheduledEmail, EmailLog, BillingAccount, ApiKey). The **~25 others** (TicketType, PricingTier, Attendee, Registration, Payment, Speaker, Abstract, EventSession, Hotel, RoomType, Accommodation, ZoomMeeting, ZoomAttendance, WebinarPoll/Question, Certificate*, SurveyResponse, AuditLog, SystemLog…) have **no org column** — scoped transitively via `eventId → Event.organizationId`.
- **Required change:** either (i) **denormalize `organizationId` onto all ~25 tables** (+ backfill + keep-in-sync) and use flat RLS, or (ii) **join/subquery RLS policies** (`event_id IN (SELECT id FROM "Event" WHERE organization_id = current_setting('app.current_org'))`) — simpler migration, heavier query cost. Plus a per-request `SET LOCAL app.current_org` wired through a Prisma client extension, **made pgbouncer-transaction-mode-safe** (set the GUC inside the same tx as the query — the same hazard already documented for the worker's advisory lock).
- **Blast radius:** getting RLS *wrong* (bad join, or a `SET LOCAL` that leaks across pooled connections) is **worse than no RLS** — silent cross-tenant reads with a false sense of safety. **Risk High, Effort L (weeks).**

### 2.2 `organizationId!` (193 occurrences) + IDOR-by-convention
- **Evidence:** `grep "organizationId!"` → **193 hits**; hot clusters in reviewers, email-templates, dashboard, organization/users, billing-accounts, and the two core helpers `event-access.ts:44,59`. June-23 audit found IDOR-1 (promo GET) + IDOR-2 (accommodation roomType) — *the PUT/DELETE in the same file bound org, the GET didn't* → it's inconsistency, not pattern.
- **The footgun:** for an org-null user, `where: { organizationId: null! }` compiles to `WHERE organizationId IS NULL` which **matches every org-independent row** (returns "all reviewers across the system" instead of throwing). Already bitten once (PRODUCTION_AUDIT #25).
- **Durable fix:** RLS removes the *leak* vector; a **CI lint rule** (flag `findUnique({where:{id}})` / `findFirst({where:{id,eventId}})` on tenant models without an org bind) prevents recurrence — the June-23 audit recommends exactly this. **Risk High (latent now, live with a 2nd tenant), Effort M.**

### 2.3 Cross-org admin readers need an RLS-bypass discipline
- SUPER_ADMIN `x-org-id` override (`api-auth.ts:32`, `org-context.ts:23`); `/logs` (SystemLog has **no** org column); `/admin/docs` (filesystem); AuditLog (no org column). Under RLS these need a **`BYPASSRLS` role / dedicated non-tenant connection** used *only* by super-admin tooling. **If that bypass connection is ever reused on a tenant request path, RLS is silently defeated.** Risk Med, Effort M.

---

## 3. Detail — schema & identity

### 3.1 The hardest decision: user identity across tenants
- **Current:** `User.email @unique` (global), `User.organizationId String?` (nullable). Login is **email-only** (`auth.ts:42` `findUnique({ where: { email } })`). Team roles (ADMIN/ORGANIZER/MEMBER/ONSITE) are org-bound; REGISTRANT/REVIEWER/SUBMITTER are org-null + event-scoped. A registrant signing up on tenant B with a tenant-A email **silently links to the tenant-A user** (`register/route.ts:544`).
- **The decision (three options):**
  - **(a) Per-tenant user rows** — `@@unique([organizationId, email])`, forces `organizationId` NOT NULL. **Breaks** the org-null roles AND the explicit *cross-org reviewer* feature (one reviewer across many orgs). Largest rewrite.
  - **(b) Shared global `User` + a `Membership`/`OrgUser` join table** — preserves cross-org roles; one login identity spans tenants. Additive (backfill one membership per existing team user). **Recommended** — the current org-null design strongly favors this.
  - **(c) Hybrid** — team identity tenant-scoped, registrants/reviewers/submitters stay global. Middle ground.
- **Blast radius of (a):** login rewrite (must know tenant before the query → tenant-context login), JWT `organizationId` becomes load-bearing for identity, internal-domain auto-attach (`internal-domains.ts`) re-framed, the cross-org reviewer breaks. **This is the one change that genuinely cannot be made non-breaking in a single migration** (duplicate-email collisions must be resolved first; every `findUnique({email})` breaks at the same instant) → **dual-write + backfill + flagged cutover** on a live payments system. **Risk High, Effort L.**

### 3.2 Slug routing (see §0) — schema OK, routing breaking
`Event.slug` is already `@@unique([organizationId, slug])` ✅. The work is **routing**: derive tenant from `Host`, then `findFirst({ where: { slug, organizationId } })` across ~15 public routes + thread the tenant into every public-URL builder (emails, QR codes, confirmation pages). **Must ship atomically with the host resolver** — landing the org filter *before* the resolver would 404 every currently-global slug. Risk High, Effort M.

### 3.3 Host → tenant routing (absent) + Organization fields
- New `TenantDomain { id, organizationId, hostname @unique, isPrimary, verifiedAt, sslStatus }` + a middleware step in `proxy.ts` resolving `Host` → org (subdomain or custom domain). Custom domains must also be whitelisted as valid CSRF origins (today `originHost !== host` only allows same-host).
- New **additive** `Organization` columns: `plan`/tier, `status` (TRIAL/ACTIVE/SUSPENDED/CHURNED), `stripeConnectAccountId` (+ onboarding state), sender-domain verification record, optional `dbStrategy` (shared-RLS vs dedicated). Risk Low (additive), Effort S–M.

---

## 4. Detail — payments, integrations & infra

### 4.1 Payments — single Stripe account → Connect (High / L)
- **Current:** one platform SDK from `STRIPE_SECRET_KEY` (`stripe.ts:6`); checkout has **no** `application_fee_amount`/`transfer_data.destination`/`{stripeAccount}` (`checkout/route.ts:151`); one webhook + one signing secret (`webhooks/stripe/route.ts:25`); `Payment` has **no** `stripeAccountId`/`applicationFeeAmount`.
- **Change:** `Organization.stripeConnectAccountId` + Express onboarding; **destination charges** (`transfer_data.destination` + `application_fee_amount`); Connect webhook routing on `event.account`; thread `{ stripeAccount }` through every webhook retrieve + refund; add `Payment.stripeAccountId`/`applicationFeeAmount`.
- **Blast radius:** the entire money path. **The webhook is the riskiest** — a mis-routed `event.account` could attach a payment to the wrong org's registration, or a platform-context Charge retrieve against a connected-account charge throws → Stripe retries forever. Each tenant completes their own KYC; you take Connect platform liability.

### 4.2 Email sender — shared SES, no per-tenant DKIM (Med-High / M-L)
- **Current:** AWS SES, ONE shared verified identity (EC2 role); per-tenant surface is only the cosmetic `From:` header, and it lives on **Event** (`emailFromAddress`), not Organization. **No per-org SPF/DKIM/DMARC** — every tenant rides `meetingmindsexperts.com`.
- **Change:** per-tenant SES verified identity / configuration set + DKIM provisioning; move sender resolution Event → Organization default. **Blast radius:** every `sendEmail()` call site. Until done, a tenant `From: noreply@theirbrand.com` fails DKIM/SPF alignment → **deliverability + spoofing/compliance problem.**

### 4.3 File storage not tenant-isolated (Med / M)
- Upload paths `/uploads/{photos,media}/{YYYY}/{MM}/{uuid}` — **no org segment** (certs are the exception: `certificates/{eventId}/`). Served publicly + unauthenticated. UUID names make enumeration hard, but **any leaked/guessed URL crosses tenants — no org check on read** (attendee-photo PII / PDPL). **Change:** prefix `{organizationId}/` + an org-aware serve guard, or per-tenant buckets/prefixes.

### 4.4 Observability, rate limiting, worker, secrets
- **Logging (Med / M):** `SystemLog` has **no `organizationId`**; `/logs` is global SUPER_ADMIN-only. Add an indexed org column + a per-request child logger bound to the tenant + an org-scoped `/logs` view. Can't answer "what happened for tenant X" today.
- **Rate limiting (Med / M):** in-memory `globalThis` Map, per-container, resets on deploy; public webinar buckets are **IP-only** (shared across orgs). Move to Redis (interface is already store-agnostic) + a per-tenant quota dimension.
- **Worker (Med / M):** `scheduled-emails` drains globally FIFO (`take MAX_PER_TICK`) — one tenant queueing thousands **starves all others' due emails**. Add fair-share (cap N/org/tick). **Must** fix the advisory-lock pooler-mode caveat (point worker at `DIRECT_URL`, session mode) **before** running a 2nd worker (DR/scale) or risk double-sends.
- **Secrets (Med / M):** all per-org encrypted creds use the single global `NEXTAUTH_SECRET` as the AES key (`eventsair-client.ts:58`). Row-isolation yes, **key-isolation no** — one secret compromise decrypts all tenants. Move toward per-tenant keys / a KMS at scale.

---

## 5. Blast-radius ranking (where "done wrong" hurts most)

1. **RLS + the 25 org-column-less tables** — get it wrong → silent cross-tenant leaks *with false confidence*. The central project.
2. **`where:{slug}` with no org** (+ inherited micro-caches) — a cross-tenant public-page leak the **instant** a 2nd org exists. Correct today purely by accident.
3. **`User.email` global-unique** — blocks the "same person across tenants" model; the only change that can't be made non-breaking in one step; touches auth on a live payments system.
4. **Stripe Connect webhook routing** — a mis-attributed `event.account` writes a payment to the wrong tenant's registration.
5. **193 `organizationId!` + IDOR-by-convention** — each a latent cross-tenant read; recurs across audits; needs RLS + a CI lint to stop the bleeding structurally.

---

## 6. Breaking vs additive (migration sequencing on the live shared DB)

**Additive / blue-green-safe (ship anytime):** `TenantDomain` table; `Organization` columns (plan/status/Stripe Connect/sender-domain); a `Membership` join table (if identity-option b); `Payment.stripeAccountId`/`applicationFeeAmount`; `SystemLog.organizationId`; RLS *policies* (Postgres objects are additive — but mind the `SET LOCAL` pooler wrinkle); denormalized `organizationId` columns on the 25 tables (add + backfill, then enforce).

**Breaking — must be staged carefully:**
- **`User.email @unique` → `@@unique([organizationId,email])`** — resolve duplicate emails first; dual-write + backfill + flagged cutover; every `findUnique({email})` flips at once. Cannot be 1-step.
- **Public slug routing gaining `organizationId`** — a behavioral cut that must land **atomically with** the Host→tenant resolver, never before.

---

## 7. Recommended sequencing (maps to MULTI_TENANCY.md §13, recast for the §0 two-silo decision)

**Do now, regardless of multi-tenant timeline (latent-bug hygiene + foundation):**
1. **CI lint** for `where:{id}`/`where:{slug}` without an org bind (cheap; stops IDOR recurrence the audit keeps finding).
2. ~~Decide the **isolation model**~~ ✅ decided (two-silo topology + Pool+/RLS on the platform instance, MULTI_TENANCY.md §0). Still open: the **identity model** (recommend: shared `User` + `Membership` join table).
3. **Denormalizing `organizationId`** onto the 25 event-scoped tables (the prerequisite for flat RLS) happens per-domain during the Phase-2 sweeps. Under two-silo it's trivial on the greenfield platform DB; on master it's only needed if/when MMG merges in — no live-DB backfill campaign now.

**Phase 0/1 — the spine (the gate):** stand up the platform instance (second box + fresh DB, same image, first-class prod from birth); host→tenant routing + `TenantDomain`; tenant context via `AsyncLocalStorage` + a pooler-safe Prisma `SET LOCAL` extension; the slug-routing cut shipped *with* the resolver; a **tenant-isolation test suite** (seed 2 tenants, prove A can't read B per PR). Master gets the identical code inert (one `TenantDomain` row).

**Phase 2 — domain-by-domain isolation sweeps:** per domain: `organizationId` column → org-bind queries → enable RLS → domain isolation tests green. Pilot **Contacts** (full sweep, July 23), then blast-radius order (§5); **MediaFile** RLS policy + harness landed July 24 (policy-only — the DB backstop; the already-org-keyed trivial case, route wiring deferred); **BillingAccount** full sweep landed July 24 (C1 compound-where + tenantTransaction, C2 runWithTenant on all 8 handlers, C3 flat RLS policy + harness — the first finance domain). Close the `organizationId!` IDOR class. **No external tenant onboards until the domains they touch are proven.**

**Phase 3 — platform features:** Stripe Connect; per-tenant email sender-domain verification; custom-domain TLS; per-tenant logging/quotas (Redis limiter — platform-instance concern); tenant lifecycle + suspension. Dogfood one MMG event on platform before customer #1.

**Phase 4 — scale & consolidate:** per-tenant cost attribution; worker fairness + the `DIRECT_URL` lock fix before a 2nd worker shares a DB; per-tenant secret keys/KMS; the §0 re-evaluation trigger — merge MM Group into platform vs silo-forever.

---

## 7.1 CRM email — per-tenant plumbing (one gap is a confidentiality LEAK)

The CRM email subsystem (deal/sponsor sends, the reply Inbox, reply-forwarding — shipped through July 24, 2026) is **data-model ready** for multi-tenancy: `CrmEmailThread` / `CrmEmailMessage` carry `organizationId`, and `CrmEmailThread.notifyEmails` (the CC/BCC copy-list) is just a column on an org-scoped row — it gets an RLS policy exactly like the Contacts pilot. The **plumbing**, however, leans on three *global* env vars, not per-tenant config. On **master** (MMG-only) all three are correct and there is no issue; they only bite in a silo hosting **more than one** tenant (the platform instance).

1. **🔴 CROSS-TENANT LEAK — the reply-forward to `partnerships@` (introduced July 24, 2026).** [inbound-email-worker.ts](src/crm/inbound-email-worker.ts) forwards every inbound reply to `process.env.CRM_EMAIL_FROM_ADDRESS` (a single global value) alongside the deal owner + the thread's CC/BCC. Owner + CC/BCC resolve from the org-scoped thread (fine); the **hardcoded partnerships constant does not** — so on a multi-tenant silo, **tenant B's sponsor-reply content forwards into the ONE shared partnerships mailbox**, exposing it cross-tenant. This is confidentiality, not branding. **Fix: resolve the "partnerships" forward address from the thread's org (a per-org setting), never a global env. HARD PRECONDITION before the platform onboards a 2nd tenant.**
2. **🟠 Sender identity + reply subdomain are global.** `CRM_EMAIL_FROM_ADDRESS` (the From, via `crmSenderFrom()` in [sponsor-email-service.ts](src/crm/services/sponsor-email-service.ts)) and `CRM_REPLY_DOMAIN` (the tokenized Reply-To, via `crmReplyDomain()` in [crm-email-thread-service.ts](src/crm/services/crm-email-thread-service.ts)) are one value each. Every tenant would send *from* MMG's address and receive replies at MMG's subdomain — functional but wrong-branded and not DKIM-aligned to the tenant's own domain. This is the "per-tenant email sender-domain verification" Phase-3 item above, **plus its reply-domain half** (per-tenant reply subdomain, or subdomain-per-tenant token routing).
3. **🟡 The inbound worker is org-blind by construction.** It resolves a thread by globally-unique `replyToken` *before* it can know the org. Under RLS it needs the same treatment as `contacts-central-sync` — a bypass role, or set `app.current_org` *after* resolving the thread. Known, precedented pattern.

---

## 8. The decisions that need a human call (before any build)

1. **Identity:** per-tenant user rows vs shared `User` + `Membership` (recommend the latter — preserves cross-org reviewer, avoids forcing `organizationId` NOT NULL). **OPEN.**
2. **Isolation:** ✅ **DECIDED July 22, 2026** — two-silo topology; the platform instance is shared-DB + RLS (Pool+), DB-per-tenant reserved as a premium tier *within* platform ([MULTI_TENANCY.md §0](MULTI_TENANCY.md)). **Policy shape RATIFIED July 23, 2026 by the Contacts pilot: FLAT** — `USING/WITH CHECK ("organizationId" = current_setting('app.current_org', true))` on the row's own column ([prisma/rls/contact.sql](../prisma/rls/contact.sql), proven end-to-end by `tests/tenancy/contact-rls.test.ts`). Consequence: the ~25 event-scoped tables get `organizationId` **denormalized** during their Phase-2 sweeps (additive backfill; trivial on the greenfield platform DB) rather than join-policies. Recipe-as-executed: [MULTI_TENANCY.md §13](MULTI_TENANCY.md).
3. **Payments:** Stripe Connect destination charges + application fee (recommend) — confirms "tenant's money → tenant's account, you take a fee." **OPEN.**
4. **MM Group's place:** ✅ **DECIDED July 22, 2026** — stays siloed on the master instance; merge-vs-silo-forever deliberately deferred to the §0 re-evaluation trigger (~6 months stable platform, or the first two-env ops incident).

*Cross-reference: [MULTI_TENANCY.md](MULTI_TENANCY.md) (architecture + cost), [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md) Round 2 (the IDOR class this formalizes), [HANDOVER.md](HANDOVER.md).*
