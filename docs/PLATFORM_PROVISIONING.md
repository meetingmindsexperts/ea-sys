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
| **A** | Local rehearsal on `ea_sys_prod_local` | nothing | The app **runs** under RLS against real prod-shaped data |
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

### A0. Prerequisites

- `ea_sys_prod_local` running with a recent restore (`npm run db:refresh`).
- `.env.local` pointing `DATABASE_URL` / `DIRECT_URL` at it (this is already the
  default local setup, see [LOCAL_DEV_DATABASE.md](LOCAL_DEV_DATABASE.md)).

**This is fully reversible.** Applying policies changes no rows, and
`npm run db:refresh` rebuilds the whole local DB from the DR dump regardless.
There is no way to lose anything in this phase.

### A1. Apply the role split and the policies

```bash
npx tsx scripts/bootstrap-rls.ts --dry-run          # see the plan, change nothing
RLS_APP_USER_PASSWORD=local_dev_pw npm run rls:bootstrap
```

What it does, all idempotent:

1. Creates the non-owner role `app_user` if missing (password only needed the
   first time; a re-run against a provisioned DB needs no secret at all).
2. Grants it table + sequence privileges and, critically,
   `ALTER DEFAULT PRIVILEGES` so tables added by future migrations are visible
   to it. Without that line the symptom is a permission error on one endpoint,
   weeks later.
3. Applies all 39 `prisma/rls/*.sql` files.
4. Verifies `row_security_active()` under `SET LOCAL ROLE app_user` for every
   policied table, and fails loudly if any of them bypasses.

Re-run it any time a new domain policy file lands.

### A2. Point the app at the non-owner role

In `.env.local`:

```
DATABASE_URL="postgresql://app_user:local_dev_pw@localhost:54322/ea_sys_prod_local"
DIRECT_URL="postgresql://postgres:postgres@localhost:54322/ea_sys_prod_local"
RLS_SET_LOCAL=1
```

`DIRECT_URL` stays on the **owner** — migrations and `db push` need DDL rights
the app role deliberately does not have.

**If you forget to switch `DATABASE_URL`, the dev server will not start.** The
boot tripwire (`src/lib/tenant/rls-assert.ts`) checks the same thing the
bootstrap verified, over the app's own connection, and refuses to serve with an
error naming every table that bypasses. That refusal is the whole safety net for
this phase: the failure mode it prevents is a database that looks isolated and
is not.

### A3. Make the host resolve

The dashboard takes its tenant from the session, but public event pages take it
from the **hostname**, so `localhost` needs a mapping or every `/e/[slug]` page
resolves to no org and renders empty:

```bash
npx tsx scripts/add-tenant-domain.ts --list
npx tsx scripts/add-tenant-domain.ts localhost <org-slug> --primary --verified
```

`--verified` is load-bearing: the resolver only routes verified rows. The
resolver micro-caches for ~60s per process, so a change takes up to a minute.

### A4. Walk the app and catalogue what breaks

`npm run dev`, then work through the surfaces below. **You are looking for
things that are empty or missing, not for errors.** An unwrapped query does not
throw; it returns nothing.

- [ ] Log in; events list shows the real events
- [ ] One event: dashboard tiles, registrations list, speakers, agenda, abstracts
- [ ] Registration detail sheet incl. the Billing tab (finance paths)
- [ ] Check-in page; print a badge
- [ ] Communications: recipient counts are non-zero and match the list
- [ ] Certificates: templates list, eligibility for a tagged recipient
- [ ] CRM: deals board, companies, contacts, a deal detail page
- [ ] Public: `/e/<slug>`, `/e/<slug>/register`, `/e/<slug>/agenda`
- [ ] Settings: users, integrations, email templates
- [ ] `/admin/infra`, `/logs`
- [ ] The worker container's logs: every job ticking, no lease errors

For anything empty, the diagnosis is nearly always the same: a query that needs
a `runWithTenant` wrap it does not have, or a `$transaction` that should be a
`tenantTransaction`. `scripts/check-tenant-als.sh` pins the swept routes, so
gaps will be in code paths outside its allowlist.

### A5. Revert when done

Either flip `RLS_SET_LOCAL` back off and restore the owner `DATABASE_URL`, or
`npm run db:refresh` for a clean slate.

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

## What is deliberately not done

Each of these is decided but unbuilt, and each has its build-time items recorded
in [PLATFORM_DECISIONS.md](PLATFORM_DECISIONS.md):

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
- **The unpoliced-model audit.** `EmailTemplate`, `Notification`, `DeviceToken`,
  `InvoiceCounter`, `EventBillingAccount`, `McpOAuthClient`, `EventStats` and
  `ImportLog` carry tenant data with no `organizationId` and no policy. RLS is
  opt-in per table, so a table with no policy is readable from every lane.
  `InvoiceCounter` and `McpOAuthClient` look like the two that matter.
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
