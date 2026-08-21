# Local multi-tenant RLS sandbox

A local dress-rehearsal of the future **platform instance** (`docs/MULTI_TENANCY.md §0`):
two throwaway tenants, RLS **on**, host-based routing — so you can *feel* what
multi-tenancy will do before the platform is stood up. **Local only. Prod is
never touched** (the MMG box keeps `RLS_SET_LOCAL` unset and never has these
policies applied).

It is entirely separate from your MMG dev — different command, different
database, different URLs. Your MMG `npm run dev` on `localhost:3113` is unchanged.

---

## What it gives you

- **Two tenants**: *Acme Events* (`acme.localhost`) and *Globex Summits* (`globex.localhost`), plus an **operator console** at `platform.localhost` which is not a tenant and holds no event data.
- **The DB-level backstop is real**: the app connects as the non-owner Postgres
  role `app_user`, so Row-Level Security actually enforces (owners bypass RLS).
  With no tenant context a swept table returns **zero rows** (fail-closed) —
  exactly how the platform behaves.
- **Host-based public routing**: both tenants have a PUBLISHED event on the
  **same slug** (`annual-summit`), so `acme.localhost/e/annual-summit` and
  `globex.localhost/e/annual-summit` each serve their own org's event.
- Seed data per org: an admin, a Contact, and a Speaker (swept tables — you see
  them isolated immediately).

| | Your MMG dev (unchanged) | Sandbox |
|---|---|---|
| Command | `npm run dev` | `npm run dev:sandbox` |
| URL(s) | `localhost:3113` | `acme.localhost:3114` / `globex.localhost:3114` / `platform.localhost:3114` (operator) |
| Database | `ea_sys_prod_local` (:54322) | `sandbox` db in the tenancy container (:55432, as `app_user`) |
| Orgs | 1 (MMG) | 2 (Acme, Globex) |
| RLS | off | **on** |
| Log in as | your MMG users | `admin@acme.test` / `admin@globex.test` (pw `sandbox123`) |

### The four sandbox accounts

All use password `sandbox123`.

| Account | Role / org | What it demonstrates |
|---|---|---|
| `admin@acme.test` | ADMIN, Acme | An ordinary tenant administrator |
| `admin@globex.test` | ADMIN, Globex | The other tenant, for side-by-side comparison |
| `operator@sandbox.test` | SUPER_ADMIN, **platform org** | The real platform operator: reads our logs, enumerates orgs, and may "act as" a tenant via the `x-org-id` header. **Sign in on `platform.localhost:3114`**, not on a tenant's host |
| `super@sandbox.test` | SUPER_ADMIN, **Acme** | The NEGATIVE case — same role, a tenant's org, so **not** an operator |

That last pair is the fixture for the boundary fixed Aug 21, 2026.
`canActAsPlatformOperator` requires SUPER_ADMIN **and** membership of
`PLATFORM_ORG_ID`, and until this seed existed the sandbox had only the
Acme-bound one — so the second condition had nowhere to run, on any
deployment. A customer's own administrator will look exactly like
`super@sandbox.test`, which is why it is kept rather than promoted.

**The operator has a host of its own, and that is not cosmetic.** Sign-in
resolves the tenant from the `Host` (PLATFORM_DECISIONS §6), so an org with no
`TenantDomain` has no door. The platform org originally had none — deliberately,
"a home for the operator, not a tenant" — and the day login became host-bound
that turned into a lockout of the one account that operates the platform. The
operator signs in on the operator console host and *then* reaches a tenant via
`x-org-id`, which is the flow `resolveActingOrgId` was written for and which
nothing exercised until sign-in stopped being global.

---

## Setup (one-time)

```bash
# 1. the tenancy Postgres container must be up (it hosts the sandbox db)
docker compose --profile tenancy up -d

# 2. provision: creates the `sandbox` db, pushes the schema, applies the role
#    split + every prisma/rls/*.sql policy, seeds the two tenants. Idempotent.
npm run sandbox:setup
```

The sandbox lives in a **dedicated `sandbox` database** inside the tenancy
container — so `npm run test:tenancy` (which wipes the separate `tenancy` db)
never clobbers it. Re-seed any time with `npm run sandbox:seed`.

## Run

> ⚠️ **Next.js 16 runs one dev server per project at a time.** Stop your MMG dev
> first (Ctrl-C its terminal, or `kill <pid>`), then start the sandbox. You run
> one *or* the other, not both. (To run both simultaneously you'd need a second
> git worktree — advanced, usually not worth it.)

```bash
npm run dev:sandbox      # acme.localhost:3114 + globex.localhost:3114 + platform.localhost:3114
```

`*.localhost` resolves to 127.0.0.1 automatically — no `/etc/hosts` editing.

---

## What to try

**Dashboard isolation (app-layer + RLS):**
1. Open `http://acme.localhost:3114`, log in as `admin@acme.test` / `sandbox123`.
2. Go to Contacts → you see **only** *Acme Contact*. Open the event → Speakers → only *Acme Speaker*. Create an event / add a contact — it's stamped to Acme.
3. Log out, open `http://globex.localhost:3114`, log in as `admin@globex.test` → you see **only** Globex's data. Acme's is invisible, at the database level.

**Public host routing (the resolver + shared slug):**
- `http://acme.localhost:3114/e/annual-summit` → Acme's event.
- `http://globex.localhost:3114/e/annual-summit` → Globex's event.
- Same URL path, different tenant — disambiguated purely by host.

**"Switch org"** = log in as the other org's admin (dashboard) and/or change the
host (public). There is no in-session switcher (that's a future feature).

---

## Honest caveats (this is a partial platform — that's the point)

Only ~14 domains are swept so far, so with RLS on:

- ✅ **Events + swept domains** (contacts, speakers, registrations, abstracts,
  sessions, certificates, invoices, billing, accommodation, CRM, ticketing,
  webinar, session-proposals) isolate correctly and work.
- ⚠️ **Un-swept tables** (Survey, RSVP, Reimbursement, EmailLog, AuditLog,
  EventStats…) have no policy yet → **not isolated** (would show cross-org).
- ❌ **A page that reads a swept table via a not-yet-wrapped path** → **fail-closes**
  (empty / 404 / error). **Finding these is genuinely useful** — each is a sweep
  gap the automated harness can't catch. If a dashboard widget shows empty/errors
  in the sandbox but works in MMG dev, you've found an un-wrapped reader.

So: treat rough edges as *data*, not bugs — they map the remaining sweep work.

---

## How it's wired (for reference)

- **DB**: `sandbox` database in the `ea-sys-tenancy-db` container (port 55432).
  App connects as `app_user` (RLS enforced) **directly** — no pgbouncer. The
  automated harness uses pgbouncer (transaction pooler) to test the harder prod
  topology; the interactive sandbox doesn't need that.
- **Flags** (`dev:sandbox` script): `RLS_SET_LOCAL=1` (the db extension issues
  `SET LOCAL app.current_org` per query) + `TENANCY_ENFORCE_HOST=1` (an unknown
  host 404s instead of falling back — so public isolation is strict). Everything
  else (`NEXTAUTH_SECRET`, email, etc.) comes from your normal `.env`.
- **Policies**: `00-roles.sql` (the app_user split) + every `prisma/rls/*.sql` —
  deliberately **not** the Event pilot policy (`tests/tenancy/policies/10-event-rls.sql`),
  because Event is un-swept and RLS on it would fail-close the dashboard.
- **Files**: `scripts/setup-sandbox.ts`, `scripts/seed-sandbox.ts`, the
  `dev:sandbox` / `sandbox:setup` / `sandbox:seed` package scripts.
