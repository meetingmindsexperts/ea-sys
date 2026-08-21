# Standing up the platform instance

> **What this is.** The ordered checklist for turning the multi-tenancy work
> from 39 policy files that have only ever run in a test container into a
> deployed, RLS-enforced instance.
>
> **Read first:** [MULTI_TENANCY.md](MULTI_TENANCY.md) §0 for the two-silo
> decision, [PLATFORM_DECISIONS.md](PLATFORM_DECISIONS.md) for what is decided
> and what is still open.
>
> **Master is never a target of anything in this document.** Master keeps a
> database with zero RLS objects, deliberately. `scripts/bootstrap-rls.ts`
> refuses master's Supabase project ref outright.

---

## The shape of it

Two phases, in this order, and the order is the point.

| | | Cost | Proves |
|---|---|---|---|
| **A** | Local rehearsal: the two-tenant sandbox, then the prod copy | nothing | Isolation holds in a running app, and the app runs against real data |
| **B** | The platform instance | a box + a Supabase project | Everything else |

Phase A exists because of one property of RLS that makes it unlike most
infrastructure changes: **a query that is not inside a tenant lane returns zero
rows, silently.** Not an error, not a 500, not a log line. A blank list where
there should be forty registrations. Nothing in CI catches that, because the
isolation harness proves *isolation* (two synthetic tenants, ~30 assertions) and
never boots the application.

So the question Phase A answers is not "is it isolated" — that one is answered.
It is "does every one of the several hundred queries in this codebase actually
run inside a lane". Finding out on a fresh box you just paid for is the
expensive way.

---

## Phase A — local rehearsal

Two rigs. Run them in this order; they answer different questions.

### A1. The sandbox — does isolation hold in a running app?

`npm run sandbox:setup` builds a dedicated `sandbox` database inside the
tenancy container with **two throwaway tenants**, Acme and Globex, each with a
verified TenantDomain, an admin login, and an event **sharing the same slug** so
host-based public routing is directly demonstrable.

```bash
docker compose --profile tenancy up -d
npm run sandbox:setup
npm run dev:sandbox
```

- Acme:   http://acme.localhost:3114   (`admin@acme.test` / `sandbox123`)
- Globex: http://globex.localhost:3114 (`admin@globex.test` / `sandbox123`)

The app connects as the non-owner `app_user`, so RLS actually enforces. Sign in
as each tenant and confirm you see only that tenant's event, contact and
speaker; then hit `/e/annual-summit` on both hosts and confirm the same slug
resolves to different events.

This never touches your prod copy, and `npm run test:tenancy` (a different
database) cannot clobber it.

Before walking the UI, prove it at the database layer, which takes one command
and is unambiguous:

```bash
DIRECT_URL=postgresql://postgres:postgres@localhost:55432/sandbox \
DATABASE_URL=postgresql://app_user:app_user_pw@localhost:55432/sandbox \
npx tsx scripts/verify-tenant-isolation.ts
```

It sets each tenant's lane as the **app role** and counts rows per table, with
the owner connection supplying the denominator. Expect each policied table with
data to split between the tenants and to return **zero** with no lane set. Two
readings that look like failures and are not:

- **`Event` shows the full count from every lane, including no lane.** That is
  the un-swept table, visible. See the last section of this document.
- **`AuditLog` shows rows the owner can see and no lane can.** Those carry a
  NULL org, and the policy is strict on `USING`, so they are reachable only from
  the privileged lane. That is `PLATFORM_DECISIONS.md` §2 and §3 working.

The same script runs against the platform later with no arguments at all, since
its `DIRECT_URL` and `DATABASE_URL` are already the two roles it needs.

### A2. The prod copy — does the app run against real data?

The sandbox has one event, one contact and one speaker per tenant, so it cannot
exercise the data-rich surfaces: a webinar console with a real ZoomMeeting,
certificates with real templates, a registrations list with hundreds of rows.
`ea_sys_prod_local` can.

**This is fully reversible.** Applying policies changes no rows, and
`npm run db:refresh` rebuilds the local DB from the DR dump regardless.

```bash
npx tsx scripts/bootstrap-rls.ts --dry-run          # see the plan, change nothing
RLS_APP_USER_PASSWORD=local_dev_pw npm run rls:bootstrap
npx tsx scripts/add-tenant-domain.ts localhost <org-slug> --verified
```

The bootstrap creates the non-owner `app_user` role if missing, grants it table
and sequence privileges plus `ALTER DEFAULT PRIVILEGES` (without which every
table a future migration adds is invisible to it), applies all the policy files,
and verifies `row_security_active()` under `SET LOCAL ROLE`. All idempotent;
re-run whenever a new domain policy lands.

`--verified` on the domain is load-bearing: the resolver looks the host up and
checks `verifiedAt` and nothing else. Do **not** pass `--primary` — that marks
the canonical public domain, and localhost is not it.

Then in `.env.local`, switch **only** `DATABASE_URL` to the app role. `DIRECT_URL`
stays on the owner, because migrations need DDL rights the app role deliberately
does not have:

```
DATABASE_URL="postgresql://app_user:local_dev_pw@localhost:54322/ea_sys_prod_local"
RLS_SET_LOCAL=1
```

**If you forget to switch `DATABASE_URL`, the dev server will not start.** The
boot tripwire (`src/lib/tenant/rls-assert.ts`) runs the same check the bootstrap
ran, over the app's own connection, and refuses to serve with an error naming
every table that bypasses. That refusal is the safety net for this phase: the
failure it prevents is a database that looks isolated and is not.

### A3. What you are looking for

**Things that are empty, not things that error.** An unwrapped query under RLS
returns zero rows silently. A registrations list showing nothing is the bug, and
there will be no stack trace and no log line.

- [ ] Events list, then one event: dashboard tiles, registrations, speakers, agenda, abstracts
- [ ] Registration detail sheet including the Billing tab
- [ ] Check-in; print a badge
- [ ] Communications: recipient counts non-zero and matching the list
- [ ] Certificates: templates, eligibility for a tagged recipient
- [ ] CRM: deals board, companies, contacts, a deal detail page
- [ ] Public: `/e/<slug>`, `/e/<slug>/register`, `/e/<slug>/agenda`
- [ ] Settings: users, integrations, email templates
- [ ] `/admin/infra`, `/logs`
- [ ] Worker logs: every job ticking, no lease errors

For anything empty the diagnosis is nearly always a query that needs a
`runWithTenant` wrap it does not have, or a `$transaction` that should be a
`tenantTransaction`. `scripts/check-tenant-als.sh` pins the swept routes, so
gaps will be outside its allowlist.

### A4. Revert

Unset `RLS_SET_LOCAL` and restore the owner `DATABASE_URL`, or
`npm run db:refresh`.

---

## Phase B — the platform instance

Do not start this until Phase A is clean.

### B1. Database

1. New Supabase project (**not** master's). Note the project ref.
2. `DIRECT_URL` = the owner string, `npx prisma migrate deploy`.
3. `RLS_APP_USER_PASSWORD=<strong> npm run rls:bootstrap`
4. `npm run rls:verify` — expect every policied table active for `app_user`.

### B2. Seed the first org and an operator

The platform DB is empty, so there is no way to log in yet. It needs an
Organization, a SUPER_ADMIN, and a `TenantDomain` row for its hostname.

> **Not built yet.** There is no tenant-creation surface anywhere in the app
> (`/admin` has docs, help-queries and infra; nothing else), so this is
> currently a manual seed. Building it is the next product track — see
> "What is deliberately not done" below.

### B3. Environment

| Variable | Master | Platform |
|---|---|---|
| `DATABASE_URL` | owner | **`app_user`** |
| `DATABASE_URL_OPERATOR` | unset | **owner** (the privileged lane) |
| `DIRECT_URL` | owner | owner |
| `RLS_SET_LOCAL` | unset | **`1`** |
| `TENANCY_ENFORCE_HOST` | unset | **`1`** — unknown Host resolves nothing (404 semantics) |
| `DEFAULT_ORG_ID` | MMG's org | **unset** — a default org would defeat `TENANCY_ENFORCE_HOST` |

`DATABASE_URL_OPERATOR` is what makes `dbOperator` a real second lane. While it
is unset, `dbOperator` **is the same object as `db`** and the privileged lane is
inert — which is correct on master and wrong on platform.

### B4. The box

Follow [FROM_SCRATCH_REBUILD.md](FROM_SCRATCH_REBUILD.md) end to end: IAM role,
security group (including 1935 for RTMP), **swap** (the INC-001 gap), packages,
nginx from `deploy/nginx.live-snapshot.conf`, blue-green wiring, crontab,
fail2ban, CloudWatch.

Same image, same repo, same migrations folder. A forked branch is explicitly
rejected by guardrail 1.

### B5. Guardrail 2 — first-class prod from birth

DR cron, monitoring, alarms, runbooks **before** tenant #1, not after. The DR
posture is in [infra/dr/README.md](../infra/dr/README.md).

### B6. Guardrail 3 — dogfood

Run one real or shadow MM Group event on the platform before an external tenant
depends on it. Phase A proves the app runs under RLS; this proves it under real
traffic, with the pooler, the worker, Stripe webhooks and email all live.

---

## What the rehearsal found (Aug 21, 2026)

Five defects in one day, none of which any existing test could have caught.
They are recorded here because the *shape* generalises: **every one produced an
empty screen rather than an error**, and every one passed a green build.

| | Defect | Would have looked like |
|---|---|---|
| 1 | The tenant lane never reached the Prisma extension. `db` is cached on `globalThis`, the `AsyncLocalStorage` was not, so two module graphs meant two stores. | **Every** policied table empty, everywhere |
| 2 | `GET /api/public/events/[slug]` read `TicketType` and `PricingTier` outside a lane | Every public event page reading "Registration Closed". Public registration dead on arrival |
| 3 | The public agenda route, same shape | A blank agenda |
| 4 | `Docs` and `Infra / Ops` were `adminOnly`, written when ADMIN meant an MMG employee | A customer reading our incident log, AWS runbook and CPU graphs |
| 5 | `events/[eventId]/tags` and `registration-types` read policied tables outside a lane | An empty tag filter and an empty registration-type dropdown |

Three things worth carrying forward.

**The failure mode is silence.** Under RLS a query outside a tenant lane returns
zero rows, not an error. No exception, no log line, no failing test. A broken
lane and a genuinely empty table are indistinguishable from the outside, which
is why the rehearsal had to *look* rather than reason.

**The bugs were at the edges, not in the swept domains.** Once the mechanism was
fixed, the domain probe passed all thirteen domains first time. The sweep work
was sound. What was missing was the mechanism it depended on, the routes nobody
had swept, and the authorisation gates nobody had re-read.

**One cause repeats: gates written when `ADMIN` meant "us".** Finding 4 is one
instance and there are likely more. ✅ **That sweep ran the same day** and found
ten more sites — six of which let a `SUPER_ADMIN` swap the acting organisation
via an `x-org-id` header, including a cross-tenant **write**. Note the role: the
rehearsal signed in as ADMIN, so it could not have found them. Full record in
[PLATFORM_DECISIONS.md](PLATFORM_DECISIONS.md) § "ADMIN-gate sweep".

**And one shape the rehearsal did NOT contain.** All five defects here fail
*closed*: no lane, RLS matches nothing, empty screen. The `x-org-id` override
fails **open** — the id is used directly, so the tenant lane is entered for the
*target* org and RLS serves their rows correctly. Worth stating plainly, because
"RLS is the backstop" is true for a missing lane and false for a wrong one.

### What now guards against a recurrence

- `npm run tenancy:isolation` — thirteen domains, both tenants, through the
  running app. Asserts each tenant's own rows are **present** as well as the
  other's absent, because absence alone is satisfied by a broken app.
- `scripts/check-tenant-als.sh` — a route in a swept domain that loses its wrap
  fails CI, naming the file and the offending query.
- Policy conformance tests — a copy-pasted policy that narrows `FOR ALL`, drops
  `WITH CHECK` or mistypes the GUC fails the unit suite.
- The RLS boot tripwire — a deployment claiming enforcement while connected as a
  role that bypasses it refuses to start.
- `scripts/check-platform-operator.sh` — `x-org-id` has exactly one reader, every
  platform surface calls the operator predicate, and none decides authorisation
  with a standalone `SUPER_ADMIN` comparison. This is the guard against the
  failure the sweep actually found, which was not a missing predicate but a
  correct predicate that only eight files had adopted.
- **`npm run tenancy:isolation` now also runs the operator boundary as two
  accounts** — a SUPER_ADMIN belonging to a TENANT (refused: `x-org-id` falls
  back to its own org, ops surfaces 403) and one belonging to the platform org
  (granted: reads another tenant with the header, keeps the ops surfaces). The
  two are each other's control; a guard that refused everyone would pass the
  first and fail the second.

  This is also the first time `PLATFORM_ORG_ID` has executed **anywhere**. The
  second condition of `canActAsPlatformOperator` — membership of the platform
  org — was written in August, unit-tested, and never run on any deployment;
  the sandbox seeded only an Acme-bound SUPER_ADMIN, which is precisely the
  account the condition exists to refuse. *Correct and unrun* is the shape of
  every defect found on Aug 21, so a predicate ten authorisation sites now
  depend on should not have stayed in it.

### The evidence pack

[MULTI_TENANCY_PROOF.html](MULTI_TENANCY_PROOF.html) is the shareable write-up
of the working state, paired screenshots and all, with the outstanding gaps
stated rather than omitted. Regenerate its screenshots with
`npm run tenancy:screenshots` while the sandbox is running.

---

## What is deliberately not done

Each of these is decided but unbuilt, and each has its build-time items recorded
in [PLATFORM_DECISIONS.md](PLATFORM_DECISIONS.md):

- **`Event` itself has no RLS policy.** There is one, but only in
  `tests/tenancy/policies/10-event-rls.sql`, which the harness applies and
  neither the sandbox nor the bootstrap does. `Event` was never one of the 20
  swept domains; `setup-sandbox.ts` states the reason in its header, that RLS on
  it "would fail-close the whole dashboard". Sizing the sweep: **343 call sites
  across 201 files**, the largest single domain left. Impact is narrower than it
  sounds, because child tables carry their own denormalized `organizationId` and
  are policied independently, so a leaked Event row does not cascade into
  registrations. What is cross-readable at the DB layer is Event rows: names,
  dates, venues, and the `settings` JSON. Not a blocker for tenant #1, who has
  nobody to leak to. A before-tenant-#2 item, same shelf as the shared SES
  sender and the CRM reply mailbox.
- **Tenant management and onboarding** (§1). Nothing exists. This is the largest
  remaining product gap and the reason B2 is a manual seed.
- **The synthetic platform org** (§3) for ownerless rows, plus `PLATFORM_ORG_ID`
  and the audit-stamp null branch that reads it.
- **Tenant offboarding** (§1) and the **NULL-org purge** (§2), both archive-to-S3.
- **The identity model** (§6) — still open. `User.email` is globally unique
  today. This does not block tenant #1 (one tenant cannot collide with itself);
  it blocks tenant #2. Note the trap when it is decided: Postgres treats NULLs as
  distinct in a unique index, so a naive `(organizationId, email)` compound
  removes uniqueness entirely for the org-null roles.
- **The remaining unpoliced tables.** An audit of org-bearing models against the
  policy set (Aug 21) found four genuine misses, since fixed: `AbstractSubTheme`,
  `SpeakerProfileForm`, `AbstractSerialCounter` and `SessionProposalSerialCounter`
  all carried `organizationId` and wrapped their routes, and simply never got a
  policy file or a CI-gate entry. What remains unpoliced is defensible but worth
  a decision: `TenantDomain` is the tenant list itself, `ApiKey` and `McpOAuth*`
  are read in order to *learn* the tenant, `LoginEvent` is already recorded as
  deferred, and `User` is open decision item 6. Separately, `EmailTemplate`,
  `Notification`, `DeviceToken`, `InvoiceCounter`, `EventBillingAccount`,
  `EventStats` and `ImportLog` carry tenant data with no `organizationId` at all;
  `InvoiceCounter` looks like the one that matters.
- **Still globally shared, each a precondition before tenant #2:** SES, the CRM's
  single `CRM_EMAIL_FROM_ADDRESS` reply-forward mailbox (a real cross-tenant leak
  on a shared instance), MediaMTX as a singleton, and the globally-unique
  `invoiceNumber` / `qrCode` / `dtcmBarcode` / `stripePaymentId` namespaces.

---

## Rollback

**Phase A:** unset `RLS_SET_LOCAL`, restore the owner `DATABASE_URL`. Or
`npm run db:refresh`.

**Phase B:** unset `RLS_SET_LOCAL` and point `DATABASE_URL` back at the owner
role. The policies stay in place and stop being enforced, which is the same
state master is in. Dropping them entirely is
`DROP POLICY … ON …` per table, but there is rarely a reason.

**Master is unaffected by every step here** and cannot be reached by these
scripts.
