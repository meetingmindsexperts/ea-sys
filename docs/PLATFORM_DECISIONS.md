# Platform pre-launch decisions — the 8-item round (Aug 4, 2026)

> **What this is.** The Phase-2 multi-tenancy sweep finished on Aug 4, 2026 (all 20
> domains — see [MULTI_TENANCY.md](MULTI_TENANCY.md) §13). What remained before the
> future **platform** instance (the second silo hosting external tenants under RLS)
> can launch was a list of 8 items — decisions, one infrastructure build, and one
> ops step. A ninth (per-tenant email, §9) was added Sep 2, 2026. This
> document records that round: **what is done, what the owner
> decided, what inputs were exchanged, and what is still open** — so the
> discussion can be revisited without re-deriving it.
>
> Participants: Krishna (owner) + Claude. Owner inputs are recorded close to
> verbatim. Nothing here starts building without explicit go-ahead.

**Status at a glance**

| # | Item | Status |
|---|------|--------|
| 1 | Tenant-offboarding data handling | ✅ DECIDED — archive to S3, delete after years, offboarded badge in tenant mgmt |
| 2 | NULL-org row purge | ✅ DECIDED — archive to S3, then delete from DB |
| 3 | Org-null audit-write loss | ✅ DECIDED: stamp a **synthetic platform org**, not MMG's (nuance resolved Aug 11) |
| 4 | The `?? ""` fallback pass | ✅ **DONE** Aug 11, 2026. Decision CORRECTED then shipped (§4) |
| 5 | Privileged maintenance lane | ✅ **BUILT** Aug 11, 2026. All four decisions taken, code shipped (§5) |
| 6 | Phase-1 identity model | ✅ **BUILT** Aug 21, 2026 — per-tenant accounts, enforced by a column (§6) |
| 7 | Per-tenant Stripe / Zoom / Anthropic keys | ✅ **IMPLEMENTED** Aug 4, 2026 (§7) |
| 8 | Master ops step (TenantDomain + DEFAULT_ORG_ID) | ✅ **DONE** Aug 4, 2026 — verified live (§8) |
| 9 | Per-tenant email (no fallback, onboarding gate) | ✅ **DECIDED** Sep 2, 2026 — not built (§9) |

---

## 1. Tenant offboarding — what happens to a departed tenant's data

**Background.** When an org row is deleted today, FK behavior is a per-table
accident: some tables cascade-delete, some SetNull (rows fall into the
NULL-org invisible pool — e.g. a deleted org's whole EmailLog), audit rows
persist forever. Flagged during the Comms-log (#18) and AuditLog (#19) sweeps
(ROADMAP §"Comms-log sweep — deferred decisions").

**Owner decision:** *"Archived and stored in S3 as if we are doing a database
restore; we can delete that after years. SUPER_ADMIN can see a tenant
offboarded in his tenant-management platform."*

**Recorded design posture:**
- Offboarding = **archive-first**: export the tenant's data to S3 as a
  restore-grade dump (same class of artifact as the existing DR `pg_dump`
  pipeline) **before** anything is removed from the live DB.
- The S3 archive has long retention ("delete after years" — exact retention
  period to be set at build time; the DR bucket's lifecycle-rule machinery is
  the existing pattern).
- The tenant-management view (platform SUPER_ADMIN) shows the org in an
  **"offboarded"** state rather than the org silently vanishing.

**Claude's note:** this decision *supersedes* the original per-table
SetNull-vs-Cascade question at the design level — the question narrows to
"after the archive is safely in S3, what does the in-DB removal do per table?"
That per-table pass still happens at build time, but under a clear rule:
archive is the source of truth for the departed tenant; the live DB gets
cleaned.

**Build-time items:** export script (per-org filtered dump), S3 prefix +
lifecycle rule, `offboardedAt` marker on Organization (or equivalent), the
tenant-management UI state.

---

## 2. NULL-org row purge

**Background.** Some rows legitimately carry `organizationId = NULL`
(EmailLog auth emails to org-null accounts, AuditLog rows from org-null
actors, HelpChatQuery rows from REVIEWER/SUBMITTER/REGISTRANT askers,
LoginEvent unknown-email attempts). Under platform RLS **no tenant lane can
read them** — only the privileged lane — so without a reaper they accumulate
forever.

**Owner decision:** *"Archive to S3 and delete from database."*

**Recorded design posture:** a scheduled worker job (privileged lane — see
§5) that periodically exports NULL-org rows past an age threshold to S3, then
deletes them. Same shape as the existing `email-log-prune` /
`login-event-prune` jobs, plus the archive step.

**Build-time items:** age threshold + cadence per table (to be picked at
build), S3 prefix + retention, job registration in the worker (advisory-lock
JOB_ID), and the privileged-lane connection it depends on (§5).

**Note:** decisions 3 + 4 below will *shrink* the NULL-org pool considerably
(most rows get stamped with the default org instead of NULL), so this purge
job's population becomes small — mostly genuinely unattributable rows.

---

## 3. Org-null audit-write loss

**Background.** All 163 AuditLog write sites use Prisma `create()`, which
emits `INSERT..RETURNING`; under the platform's asymmetric RLS policy a
NULL-org `create()` is rejected on its RETURNING clause and the row is
**silently lost** (fire-and-forget catch logs it, nothing crashes). Recorded
during the AuditLog sweep (#19) as an accepted platform-only risk pending an
owner decision.

**Owner decision:** *"Use default MMG org id for audits and logs. If it is a
tenant, an additional identifier — tenantName: MMG, ACME, GLOBEX and so on."*

**Recorded design posture:**
- Rows that would otherwise be NULL-org get stamped with the **default (MMG /
  operator) org id** — so the write always passes RLS and is never lost.
- An **additional tenant-identifier field** (e.g. `tenantName`) labels which
  tenant the row is actually about, for rows where the org id is the default
  rather than the true tenant.
- Rows attributable to a real tenant keep being stamped with **that tenant's
  own org id** (this is what the sweep already does — the auto-stamp
  extension resolves explicit → ambient lane → eventId 1-hop; the loss case
  was only the residue with no org at all).

**✅ Nuance RESOLVED Aug 11, 2026, option (b): a synthetic platform org.**
The owner chose the dedicated org over MMG's id. Rationale as discussed: the
org id a row carries *is* the lane that can read it, so stamping MMG's would
make every ownerless/system row visible inside MMG's ordinary tenant lane,
with `tenantName` describing them but not isolating them. A synthetic org that
owns nothing and that nobody logs into costs one seed row and keeps those rows
readable only from the privileged lane (§5). **Build-time items:** seed the
row, a `PLATFORM_ORG_ID` env var beside `DEFAULT_ORG_ID`, and the audit-stamp
extension's null branch resolving to it. Not built yet: the extension change
lands with the tenant-management work, since it is inert until RLS is on.

*(Original framing of the nuance, kept for the record.)* **⚠ Open nuance
(flagged by Claude, to confirm before build):** under RLS,
*whatever org id a row carries is the lane that can read it*. Rows stamped
with MMG's id are therefore **visible in MMG's tenant lane** — the
`tenantName` field labels them but does not isolate them. Two readings:
- **(a) Intended:** MMG *is* the platform operator; operator-org visibility of
  ownerless/system rows is by design. (Claude's read of the owner's intent.)
- **(b) Alternative:** if these rows should be visible *only* to the
  SUPER_ADMIN platform views, use a dedicated synthetic "platform" org id
  instead of MMG's.

To be confirmed in the §5 discussion (they're related — the privileged lane
is the other way operator-only visibility is achieved).

---

## 4. The 16-instance `runWithTenant(session.user.organizationId ?? "")` pass

**Background.** 16 call sites across the Invoice + Registration-core sweeps
wrap in `runWithTenant(orgId ?? "")`. An empty-string lane matches **no**
rows, so an org-null SUPER_ADMIN on those routes fail-closes to 404/empty
under platform RLS. Fail-closed (safe direction), platform-only, deferred as
a single consistent pass rather than 16 inconsistent point-fixes (ROADMAP
§"Comms-log sweep — deferred decisions").

**Owner decision:** *"Use default MMG org id with additional identifier of
tenant"* — i.e. the same posture as §3: where no real org resolves, fall back
to the default/operator org id (with the tenant-identifier label where
applicable) instead of an empty-string dead lane.

**⚠ CORRECTED AND SHIPPED Aug 11, 2026 (commit `fdf54c3c`). The recorded
decision above does not work, and the correction is the useful part of this
entry.**

Measuring the sites before building showed there were **45, not 16**, and that
**33 of them are lane wraps on routes that read a TENANT's event data**
(check-in, refund, credit notes, badges, invoices, clone). For those, stamping
the operator's org id gives a lane that still cannot read tenant ACME's
registration. It swaps one dead lane for another *while looking like a fix*,
the worst kind of change, because the symptom disappears from the plan without
disappearing from the system. The org stamped on a row IS the lane that can
read it; that is the same fact that drove §3 to a synthetic org.

So the real question was never which org to stamp. It was **whether a platform
operator with no org should be able to act inside a tenant's event at all.**

**Owner decision: no.** The operator runs the platform, the tenant runs their
events, and an operator who must act inside a tenant gets a membership there.
This is also the only option that adds **no privileged surface**: check-in,
refunds, credit notes and badge printing are precisely the handlers you least
want executing with RLS switched off. (The two alternatives offered were:
resolve the event's org on the privileged lane then borrow that tenant's lane;
or run the whole handler privileged. Both were declined.)

**What shipped:** `runWithTenantLane(orgId, { route, userId }, fn)`
([src/lib/tenant-lane.ts](../src/lib/tenant-lane.ts)) still enters an empty
lane when there is no org (fail-closed, unchanged) but logs
`tenant:no-org-lane` with the route and caller first, so a platform 404 is
traceable instead of mysterious. `route` is REQUIRED, unlike the optional one
on `denyReviewer`, because this wrap only exists where an org-null caller is
genuinely possible: a line naming who but not what would be useless every time
it fired. Applied to all 33; master behaviour is unchanged (RLS off ⇒
passthrough for any value including `""`), pinned by test.

**Deliberately NOT converted:** the 15 public `tenant.orgId ?? ""` sites (host
resolution, not an operator, and the resolver already logs its own unresolved-host
ramp) and the 12 `organizationId: (… ?? "")` service arguments and Prisma
predicates (not lanes at all; an empty string there fails closed inside the
service or matches no rows).

---

## 5. Privileged maintenance lane: ✅ BUILT (Aug 11, 2026)

> **Status: decided and shipped**, commits `2b74dee4` (the lane + the CI gate),
> `f763016c` (the surfaces), `fdf54c3c` (the `?? ""` correction, §4).
>
> **The four decisions (a–d), as taken:**
>
> | | Question | Decision |
> |---|---|---|
> | (a) | Surface list | Confirmed, and **narrowed by measurement**. Only jobs scanning an RLS-POLICIED model qualify: `system-log-prune`, `log-archive`, `oauth-cleanup` and `login-event-prune` scan SystemLog / McpOAuth* / LoginEvent, which carry no policy, so they need no exemption. When LoginEvent is swept its prune job joins the list. |
> | (b) | Who is a platform operator | **SUPER_ADMIN.** No new role: reusing the existing one costs no migration and the operator surface is a handful of reads, not a job function. |
> | (c) | Worker access | **Per-job, allowlisted.** A new job defaults to the tenant-scoped client and fails closed. |
> | (d) | §3/§4 operator-org nuance | **Synthetic platform org** for ownerless rows (see §3); and for §4 the decision was *corrected* rather than applied, see §4. |
>
> **What shipped:**
> - `dbOperator` ([src/lib/db.ts](../src/lib/db.ts)): a client on
>   `DATABASE_URL_OPERATOR` (the table-owner role, exempt from the no-FORCE
>   policies). **On master it is the SAME OBJECT as `db`**, so one client, one
>   pool, byte-identical behaviour; pinned by test. Carries `audit-org-stamp`
>   but deliberately NOT `tenant-set-local`.
> - `denyNonOperator` ([src/lib/platform-operator.ts](../src/lib/platform-operator.ts))
>   is the RBAC wall, the **seventh** visibility boundary and narrower than all
>   six. **Refuses org API keys**, which every other surface treats as
>   admin-equivalent: a key belongs to one tenant.
> - An **allowlist CI gate** in
>   [check-tenant-als.sh](../scripts/check-tenant-als.sh): any unlisted file
>   importing `dbOperator` fails CI. Mutation-verified.
> - **11 surfaces wired.** In 8 of the 9 jobs the privileged part is ONE
>   statement: the candidate scan finds work across tenants, reads the org off
>   the row, then does the work inside `runWithTenant` on the normal client.
>   *Borrow the tenant's lane; do not stay privileged.* The exceptions are
>   `email-log-prune` (privileged end to end: it reaps by row age across the
>   NULL-org pool, which has no lane to borrow) and `crm-inbound-email` (the
>   reply-token → thread lookup, where the tenant is the ANSWER).
> - `/admin/infra` became **scope-aware** rather than operator-only: the
>   platform operator gets totals across every tenant, a tenant's ADMIN gets
>   their org. The scope picks the client AND the `organizationId` filter
>   together, so the org view is correct on master too, and the 60s cache is
>   keyed on the scope so one audience's totals can never be served to the
>   other.
>
> **Two walls, always.** The DB lane removes RLS; `denyNonOperator` decides who
> may ask. Neither substitutes for the other, and the gate's failure message
> says so.
>
> **Remaining ops step (platform only):** provision the non-owner `app_user`
> role, point `DATABASE_URL` at it and `DATABASE_URL_OPERATOR` at the owner
> role. Until then both strings are the same and the lane is inert.

*(Original inputs round below, kept for the record.)*

## 5a. Privileged maintenance lane: the inputs that produced the decision

**Background.** Several surfaces are *deliberately cross-tenant* and would
see **zero rows** from any tenant lane under platform RLS:
- Worker jobs' cross-tenant scans: `email-log-prune` (mandatory — it is the
  NULL-pool's only reaper), `login-event-prune`, the scheduled-emails tick
  scan + stuck sweep, invoice-reconciliation candidate sweep, cert auto-issue
  sweep, webinar crons' candidate scans.
- Operator readers: `GET /api/help-chat/queries` (the SUPER_ADMIN
  `/admin/help-queries` view — deliberately operator-global per the owner's
  Aug 4 decision), the `infra/aws-ops.ts` queue-health reads, DR scripts.
- The future tenant-management views (§1).

**Owner:** *"We will discuss — I need some inputs from you."*

**Claude's inputs (delivered Aug 4, 2026):**

1. **Half of this already exists by design.** The RLS policies are created
   **without FORCE**, so the *table-owner* database role bypasses them
   automatically. That is exactly the two-role split the tenancy harness runs
   (owner connection seeds; `app_user` connection is enforced) — built as the
   platform's reference architecture. No `BYPASSRLS` grant needed.
2. **Two connection strings on the platform:** the app serves requests as a
   non-owner `app_user` role (RLS enforced); a second, owner-role connection
   string is the privileged lane.
3. **A dedicated client export** (e.g. `dbOperator` in `src/lib/db.ts`) built
   on the owner string — privileged access becomes a *greppable import*,
   never a runtime flag on the normal `db`.
4. **An allowlist CI gate:** extend `scripts/check-tenant-als.sh` so only
   enumerated files may import `dbOperator`; anything else importing it fails
   CI. (Same mechanism that already pins `runWithTenant` coverage.)
5. **Route-level guard:** any HTTP route using the operator client must ALSO
   pass an "is this user a platform operator" RBAC check — the DB lane and
   the RBAC check are two independent walls.
6. **Master unaffected:** on master both strings can point at the same DB;
   the split only becomes real on the platform.

**Decisions the owner needs to make in the discussion:**
- (a) Confirm the enumerated surface list above.
- (b) Is "platform operator" = MMG SUPER_ADMIN, or a new distinct role?
- (c) Do worker jobs get the operator client wholesale or per-job? (Claude
  recommends per-job, allowlisted.)
- (d) The §3/§4 nuance: operator-org stamping (MMG-lane visible) vs a
  synthetic platform org (privileged-lane only).

---

## 6. Phase-1 identity model — ✅ DECIDED (Aug 21, 2026)

**Decision: per-tenant accounts, enforced by a column.** `User.organizationId`
becomes **required**, and email uniqueness moves from global to
**`@@unique([organizationId, email])`**. The same address in two tenants is two
independent accounts with separate passwords. This is the owner's original
thesis, taken as written after the discussion below.

### Background

`User.email` is globally unique today — one email, one account, everywhere. On
a platform the same person (a doctor, say) may register with two tenants.

**Owner's thesis (recorded Aug 4 as a starting position):** *"I think one email
is global and unique per tenant, and for the other tenant, the email is global
and unique. We need to keep that distinction. This is my thought process, I may
be wrong, we will discuss further."*

### What the discussion changed

**The decision was narrower than this item made it look.** The Aug 6 ruling in
[IDENTITY_AND_ROLES.md](IDENTITY_AND_ROLES.md) §1 — that external logins stay
org-null on master and never inherit an event's org — already named its own
exception: *"the one sanctioned future version: the platform identity model
(item 6) makes external accounts tenant-bound **by design**, with the supporting
redesign (tenant-scoped login, membership seam)."* The two positions are
consistent, not in tension, and the shape was pre-committed. What was genuinely
open was the **mechanism**.

**The numbers reframed the "hard edge".** This item recorded org-null roles as
an edge case. Measured on prod (read-only, Aug 21): **113 of 126 accounts — 90%
— are org-null** (REGISTRANT 86, SUBMITTER 27) against 12 org-bound team
accounts. They are not an edge; they are the user table, and they are precisely
what the change is about. Also measured: **zero REVIEWER accounts exist**, so
the named hard case (one reviewer serving several orgs) is hypothetical.
*(The one org-null ORGANIZER is the seeded `mcp-remote@system.local` system
user, not an anomaly.)*

### The alternative, and why it lost

A **Membership table** — `User` keeps a globally unique email, and
`Membership(userId, organizationId, role)` carries the per-tenant role — was
weighed seriously, and it is **much cheaper than it first appears**. The
expected cost was "move `role` off `User`, touch ~200 `session.user.role` reads
and all nine visibility predicates". That is wrong: the JWT already carries
`{ role, organizationId }` as a pair, so every consumer reads the *session*, not
the database. Only **three** sites write `token.role`, plus one 5-minute
revalidation read. The session shape would not change at all.

It lost on three grounds, none of them cost:

1. **A shared account shares a password.** One compromised credential reaches
   every tenant that person belongs to. The column contains it to one.
2. **The two-silo topology already answers it.** A person active at MMG *and* a
   platform tenant has two accounts regardless — separate databases. Per-tenant
   accounts inside the platform DB are the consistent continuation.
3. **Its unique advantage has no instances.** The only thing Membership buys
   that the column does not is one human serving several tenants without
   duplicate accounts. Prod has zero reviewers, and no tenant has asked.

### A third option, raised and declined: an org ARRAY on User (Aug 24, 2026)

**Owner's question:** could a submitter simply *acquire* the org of each event
they submit to, held in an array, so one person submitting to two organisations
stays one account?

**Owner's ruling, after the trade was laid out:** *"a doctor active at MM Group
and at a platform tenant already has two accounts and two passwords" — "yes that
should be the case."* Per-tenant accounts confirmed; the array is declined.

**Why the array was a real question and not a naive one.** It is friendlier —
one login, no duplicate account, nothing for the person to keep track of. It
also came from a live signal rather than theory: `tenant:no-org-lane` was firing
on `events:speakers` for three distinct SUBMITTERs, because an org-null caller
has no lane to give.

**But it answers the wrong question, and that is the load-bearing part.** An org
list says *who may this person access*. It does not say *which tenant is this
request about*. A submitter calling `GET /api/events/123/speakers` still needs
ONE lane picked, and `[acme, globex]` does not pick it — **event 123 does**. So
the array would not have fixed the thing that prompted it; taking the lane from
`event.organizationId` does, with no schema change at all.

**Three costs, the first of them fatal:**

1. **It is mutually exclusive with this item's mechanism.** `UNIQUE
   (organizationId, email)` needs one org per row. With an array there is none,
   so email returns to globally unique across the whole platform DB — undoing
   what [010-user-identity.sql](../prisma/platform/010-user-identity.sql) now
   enforces.
2. **A shared account shares a password**, so one compromised credential reaches
   every tenant that person belongs to. The column contains the blast radius to
   one tenant; the array removes that containment.
3. **`User.role` is single-valued.** Submitter at one org and reviewer at another
   is unrepresentable by an array of orgs — and that is the realistic case, not
   an edge one. Expressing it needs `Membership(userId, organizationId, role)`.
   **The array is a half-measure that breaks exactly where it would first be
   used**, which is why the alternative above is Membership and not this.

**The argument that decided it.** Master and platform are separate databases, so
a person active at both **already** has two accounts and two passwords, with no
design choice involved. Per-tenant accounts inside the platform DB are the
consistent continuation of a split the topology already forces, rather than a
new inconvenience invented by this decision.

**Measured the same day (prod, read-only):** 28 SUBMITTERs, speaking at events in
**one** organisation, and **zero** REVIEWERs. The problem the array solves has
not one instance today. The revisit trigger is unchanged and stated above: a real
tenant asking for shared reviewers or shared staff — and the answer then is
**Membership**, not an array.

**Recorded honestly: the column is the LESS reversible choice.** Membership →
column is easy; column → Membership means merging duplicate accounts, which is
painful. This was accepted knowingly. **Revisit trigger:** a real tenant asking
for shared reviewers or shared staff across tenants.

### Two traps, both load-bearing

**1. The NULL trap — the constraint must come after the stamp.**
`@@unique([organizationId, email])` on a *nullable* column enforces **nothing**
for org-null rows: Postgres treats NULLs as distinct, so two
`(NULL, 'doctor@x.com')` rows are perfectly legal and the index looks like
protection while providing none. Every row must carry a non-null org *before*
the constraint is added. Free on the greenfield platform DB (no rows); a live
footgun if anyone attempts it on master, where 90% of rows are org-null.

**2. Login must resolve the tenant BEFORE the lookup.** `src/lib/auth.ts` does
`user.findUnique({ where: { email } })` with no org in scope — it cannot stay
that way once email is only unique per tenant. The host resolver
(`src/lib/tenant/resolver.ts`) already exists, so this is wiring rather than new
machinery. **The UX consequence is deliberate and needs designing:** signing in
on the wrong tenant's host reads as "no such account", which is correct and
confusing.

This is the same structural fact today's ADMIN-gate sweep ran into from the
other side: **anything read before identity is resolved cannot be protected by
identity.** Login is the canonical case — the tenant must come from the *host*,
because the credential cannot supply it.

### The implementation constraint: this cannot be a Prisma migration

Discovered while scoping the build, and it changes the shape, so it is recorded
here rather than in a commit message.

**Master and the platform share `schema.prisma`.** One repo, one image, two
deploy targets (MULTI_TENANCY.md §0, guardrail 1) means they also share the
migration chain. A migration making `organizationId` required would run on
master, where 113 of 126 users are org-null *by design*, and fail
`prisma migrate deploy`. The two ways round it each break a recorded rule:
forking the schema violates the identical-build guardrail, and stamping
master's external logins reverses the Aug 6 ruling.

So the constraint lives where the RLS policies live —
**[prisma/platform/010-user-identity.sql](../prisma/platform/010-user-identity.sql)**,
applied by `scripts/bootstrap-rls.ts` and by the isolation harness, never by the
migration chain. `readPolicyFiles`/`applyPolicyFiles` already took a *list* of
directories, so this needed no new machinery. Master's database never sees it.

The file drops the global `User_email_key` and creates
`UNIQUE (organizationId, email) NULLS NOT DISTINCT`. That last clause is the
NULL trap above, defused structurally: an org-less row falls back to *global*
email uniqueness rather than to none at all.

**One thing the constraint cannot do, and it is why the code half is not
optional.** Prisma's client still believes `email` is `@unique`, so
`user.findUnique({ where: { email } })` keeps compiling and keeps running once
the index is gone — it simply becomes ambiguous, returning whichever tenant's
row the planner reaches first. Dropping an index cannot make application code
fail loudly. Routing every user-by-email lookup through one tenant-aware
resolver is what closes that, and it must land with, or before, this file.

### Build-time items

- ✅ **Done Aug 21:** the platform-only constraint SQL, its bootstrap + harness
  wiring, unit conformance tests (both `DROP` and `NULLS NOT DISTINCT`
  mutation-verified) and a real-Postgres behavioural test asserting that two
  tenants may share an address, that one tenant may not repeat it, and that an
  org-less row still gets global uniqueness.
- `schema.prisma` stays as it is — `organizationId String?`, `email @unique` —
  because master needs both. The divergence is deliberate and documented in the
  SQL file's header.
- ✅ **Done Aug 21:** the tenant-aware resolver
  ([src/lib/tenant/user-lookup.ts](../src/lib/tenant/user-lookup.ts)) plus the
  two sign-in paths (`src/lib/auth.ts`, `api/auth/mobile-login`), which resolve
  the tenant from the **Host** via the existing resolver before the lookup.
  Three `token.role` write sites and the 5-minute revalidation read are
  untouched, as predicted.

  **The rule turned out to need no environment flag, and that is the useful
  part.** A tenant-scoped lookup matches *this tenant's row, or a tenant-less
  one, preferring this tenant's*. That single rule is correct on both
  deployments because what differs between them is the **data**, not the code:
  master's 113 org-null accounts are served by the org-less branch, the
  platform's tenant-bound ones by the org branch, and on master email is still
  globally unique so exactly one branch can match — behaviour is unchanged.
  A `PLATFORM_ORG_ID`-style fork was rejected because forgetting to set it on
  the platform fails **OPEN**: global lookups against a database that no longer
  guarantees global uniqueness, i.e. the same shape as the `x-org-id` defect
  found the same day. There is nothing to misconfigure.

  The strict `{ organizationId, email }` that looks like the obvious
  implementation was rejected for a blunter reason: on master it misses every
  org-null row, so **90% of accounts could no longer sign in**. The org-less
  branch is not a convenience; it is what lets one rule serve both.

  Two properties are mutation-verified against a real planner
  ([tests/tenancy/user-identity.test.ts](../tests/tenancy/user-identity.test.ts)):
  dropping the org-less branch breaks org-null sign-in, and flipping the
  `NULLS LAST` ordering makes a tenant-less account **shadow** a real tenant
  account with the same address — Postgres genuinely returns the wrong row
  without it, so the ordering is not decoration.
- ✅ **Done Aug 21:** all remaining by-email sites, and the CI gate
  ([scripts/check-user-email-scope.sh](../scripts/check-user-email-scope.sh),
  three mutations verified). The rule it pins is that a by-email `User` lookup
  is tenant-safe in exactly two ways: through the resolver, or by carrying
  `organizationId` in the same `where`.

  **Two facts from prod reframed the migration, and both were measured rather
  than assumed.** Master has **exactly one organisation** (12 org-bound users,
  **0** emails held in two orgs), so "this org OR no org" covers the entire user
  table and every narrowing below is a provable no-op there. And the two CRM
  deal-owner lookups were **already correct** — a strict `{ email,
  organizationId }`, which is right because that answer must be an org *member*,
  so an org-less row must not match. A mechanical sweep would have widened them
  and broken that.

  **The migration split by what each site is FOR, not by where it lives:**
  - *Identity reads* — "which account is this person?" — become tenant-scoped:
    sign-in, the token flows, `registrant-account`'s create-or-link (on the
    platform, linking by email alone attaches one tenant's registration to
    another tenant's user), the public-registration doors.
  - *Collision checks* — "will this write collide?" — must mirror **the
    constraint the write can violate**, which is global on master and
    per-tenant on the platform. Scoping them is what makes them follow whichever
    rule the deployment actually enforces.
  - The second kind exposed something worth fixing on its own account: a
    pre-check is a **read**, and a read is not a guarantee. Two admins inviting
    the same address concurrently both passed it and the loser got a raw P2002
    → 500. The team-invite and reviewer-invite routes now map that to the same
    409 the pre-check returns, so the constraint has the last word and neither
    ordering can 500. That is a pre-existing race closed in passing.
- ⚠️ **Two things only running it found, both fixed Aug 21.** Neither had a
  failing test, because both are about *reachability* rather than logic — the
  recurring shape of this whole round.

  **1. An unrecognised `Host` was a universal login.** The resolver returns a
  null org for two opposite reasons, and `scopeFromRequestHost` collapsed them:
  `unscoped` (master, no `DEFAULT_ORG_ID` — legacy global behaviour, correct)
  and `unknown-enforced` (the platform, where an unknown host is *defined* to
  resolve nothing). Falling back to a global lookup meant `Host: evil.example`
  signed in fine against any tenant on the enforcing sandbox — verified, then
  verified fixed. Not a privilege escalation (the session still carries the
  caller's own org), but it defeats the binding the change exists for, and it
  means removing a tenant's `TenantDomain` would not have closed its front door.
  `Host` is attacker-controlled, so the enforcing deployment now fails **closed**
  via a third scope, `{ none: true, reason }`, which matches nothing and does not
  query. Both directions are mutation-verified — failing closed on *both*
  branches would lock master's 113 org-null accounts out.

  **2. The platform operator had no door.** The synthetic operator org (§3) was
  seeded deliberately with **no `TenantDomain`** — "a home for the operator, not
  a tenant" — which was fine while sign-in was global and became a lockout the
  moment it became host-bound. The operator signs in on an **operator console
  host** and *then* reaches a tenant through `x-org-id`; that is exactly the flow
  `resolveActingOrgId` was written for, and nothing had exercised it. Recorded as
  a provisioning requirement in
  [PLATFORM_PROVISIONING.md](PLATFORM_PROVISIONING.md) §B2, because the symptom
  is an ordinary "invalid email or password" that tells the operator nothing.
- **The escape hatch is the deliverable, not a loophole.** A genuinely
  cross-tenant lookup is written as `{ unscoped: true, reason: "…" }`, so
  `grep 'unscoped: true'` is the list of decisions the platform must revisit —
  a sentence someone wrote and a reviewer read, rather than an omission nobody
  noticed. There are none in `src/` today.
- **Flagged, not fixed: the login throttle is keyed on email globally.**
  `isLoginBlocked(email, ip)` shares one bucket across tenants, so on the
  platform an attacker hammering tenant A's login with a known address locks
  that address out at tenant B. Low severity (a nuisance, not a breach) and
  deliberately out of scope for the identity change, but it is the same class
  of global-by-email assumption and should move with the rest.
- ✅ **Done Aug 21:** the `/api/registrant/**` routes take their tenant lane —
  all 12 handlers across 10 routes, gated in
  [check-tenant-als.sh](../scripts/check-tenant-als.sh).

  **The lane comes from the HOST, and it has to.** A REGISTRANT is org-null on
  master by design (the Aug 6 ruling), so the session cannot supply it; and
  `Registration` carries an RLS policy, so the rows cannot be read first to find
  out. Same shape as sign-in: the front door is the only thing that knows.
  `resolveRequestOrgId` is the one-liner both use, and it exists rather than
  being inlined because those two lines include `normalizeHost` — skip it and a
  `Host` with a port silently resolves nothing.

  **The sandbox had ZERO registrant accounts**, so the entire portal —
  my-registration, invoices, quotes, barcodes, promo codes — had never once run
  against a deployment with RLS on. That is the same gap that hid the operator
  lockout the day before, and it is now a fixture plus a browser test asserting
  each tenant's delegate sees their OWN registration and not the other's.
  Asserting only "not the other tenant's" would have passed against the bug,
  since an empty list is exactly what a missing lane produces.

  Mutation-verified: removing the lane makes the portal **500** under RLS.
- The three stale "deliberately cross-org, pending the identity-model decision"
  comments (`registrant-account.ts` ×2, the portal's link-on-read sweep) are
  corrected: those sweeps are by EMAIL, and inside a tenant lane they are
  tenant-local by construction rather than by a where-clause someone has to
  remember.
- Password reset, invitation acceptance and email verification all key on email
  and become tenant-scoped with it.
- `buildEventAccessWhere`'s org-null branches: external accounts now carry an
  org, so revisit whether linkage-based access is still the right rule or
  becomes belt-and-braces.

**Master is untouched by all of this.** The column change lands on the platform
instance only; the Aug 6 ruling that external logins stay org-null on master
stands, for exactly the reasons it gives.

---

## 7. Per-tenant API keys (Stripe, Zoom, Anthropic — and MMG's own) — ✅ IMPLEMENTED (Aug 4, 2026)

> **Status update — BUILT + shipped Aug 4, 2026** (commits `14173797..96d9436e`,
> six phases). What shipped, beyond the original decision:
> - **Stripe**: `getStripe(orgId)` resolves org key → env; per-org webhook
>   endpoint `/api/webhooks/stripe/[orgId]` verifying against the org's own
>   signing secret, both routes delegating to ONE shared dispatcher
>   (`src/lib/stripe-webhook-handler.ts`). The Stripe *publishable* key turned
>   out to be dead code (checkout is a server-side redirect) — only the secret
>   key + webhook secret went per-org. **Direct keys confirmed over Connect.**
> - **AI**: per-org Anthropic AND **OpenAI** keys (owner scope addition during
>   planning), plus a per-org **Help Chat provider choice**
>   (`settings.ai.helpChatProvider`). The Event Agent stays Anthropic-only
>   this round (tool loop + web_search are Anthropic-specific — porting is a
>   recorded follow-up; a tenant's own key also needs web search enabled in
>   that tenant's Anthropic Console).
> - **Zoom/EventsAir** were already per-org (the template) — untouched.
> - Storage: AES-256-GCM in `Organization.settings.{stripe,anthropic,openai,ai}`;
>   Settings → Integrations gains Stripe Payments + AI Assistant cards
>   (masked, blank-keeps-existing, test-connection with `source: org|env`).
> - Fallback chain everywhere: org key → env — master with nothing configured
>   is byte-identical (pinned by test: an org without a key gets the IDENTICAL
>   env client instance).
> - Known accepted edge (documented in UI + PAYMENT_FLOW.md): switching Stripe
>   accounts after payments exist leaves old PaymentIntents refundable only
>   from the old account; no silent env-key retry.

*(Original decision record below.)*

**Owner decision:** *"Stripe, Zoom and Anthropic all should be tenant's own
keys, including our own — in fact that is our next immediate priority. We
will give provision under org settings; they are encrypted, and fallbacks
should be in place."*

**Recorded design posture:**
- Every tenant (including MMG itself) configures its **own** Stripe, Zoom,
  and Anthropic keys under **Org Settings**.
- Stored **encrypted** — the pattern already exists: Zoom and EventsAir
  credentials are already AES-256-GCM-encrypted per-org in
  `Organization.settings` with a Settings UI (encryption keyed off
  `NEXTAUTH_SECRET`). Stripe + Anthropic (and later the email provider)
  follow that established shape.
- **Fallback chain:** tenant key → platform default (the current env-var
  keys), so nothing breaks while a tenant hasn't configured theirs.

**Claude's notes for kickoff (when the owner says go):**
- This **partially supersedes the old "Stripe Connect" open question** — the
  owner's direction is *direct per-tenant keys* (each tenant's own Stripe
  account/keys), which is simpler than Connect (no platform-mediated payouts,
  no application fees). The one question to settle at kickoff: confirm direct
  keys vs Connect, since Connect is what enables platform-level fee-taking if
  that's ever a business model.
- Blast radius to plan for: the Stripe SDK singleton (`src/lib/stripe.ts`)
  becomes per-org; **webhook routing** (each tenant's Stripe account needs
  its webhook endpoint + per-tenant `STRIPE_WEBHOOK_SECRET` verification);
  the Anthropic key threads into `src/lib/ai/` (help chat) + the in-app
  agent + MCP `research_sponsor`.
- **Not started** — awaiting explicit go-ahead; will open with a short plan +
  the kickoff questions above.

---

## 8. Master ops step — ✅ DONE (Aug 4, 2026, executed by owner, verified by Claude)

**What it was:** the two-part config so master resolves its hostname to MM
Group first-class instead of warn-logging `tenant:host-unresolved-unscoped`
~1/min/container.

**What was done (owner ran on the Mumbai box, container-only runtime):**

1. **TenantDomain seeded** —
   `docker exec ea-sys-worker npx tsx scripts/add-tenant-domain.ts events.meetingmindsgroup.com mme --primary --verified`
   → `events.meetingmindsgroup.com → MM Group (mme, cmknqh87j0000mj0wk4j1tzk0) [primary] [verified]`.
   (Idempotent; `--verified` is load-bearing — the resolver only routes
   verified rows. Resolver micro-cache ≈60s per container.)
2. **`DEFAULT_ORG_ID=cmknqh87j0000mj0wk4j1tzk0`** confirmed present in
   `/home/ubuntu/ea-sys/.env` — it predated the current containers (already
   loaded in both `ea-sys-green` and `ea-sys-worker`, verified via
   `printenv`), so **no redeploy was needed**.

**Verification (read-only):** `--list` shows the mapping; zero
`tenant:host-unresolved` warnings in SystemLog after the change; the live org
confirmed as MM Group (owns all 385 events; the second "Meeting Minds" org
row is a stray with 1 test event — never use it for platform config).

---

## 9. Per-tenant email: ✅ DECIDED (Sep 2, 2026), NOT BUILT

**Owner decisions, verbatim:**
- *"no defaults, fail loudly, make sure email must be set as part of onboarding"*
- *"for acme should have one aws ses account and globex has one ses account
  then? by the way we manage that. we pay for it."*

**The decision, in four parts:**

1. **No tenant-mail fallback.** A tenant with no email configured cannot send.
   There is no shared platform sender that tenant mail falls through to.
2. **Email configuration is an onboarding gate.** A tenant cannot publish an
   event or invite a user until a real test send has round-tripped. This is
   what makes part 1 safe: it makes "live tenant with no sender" unreachable
   rather than merely loud.
3. **Two senders, structurally separate.** Platform-operational mail (the
   tenant invitation, billing, the "your email is broken" alert) uses a
   platform identity. Tenant mail uses the tenant's own. They never mix.
4. **One AWS account per tenant, under AWS Organizations, MMG-created and
   MMG-paid.** Acme gets an account, Globex gets an account, billing
   consolidates to MMG.

### Why account-per-tenant, and why the platform's own account got simpler

SES sending quota and complaint-rate enforcement are **account-level**.
Configuration sets and dedicated IPs do not isolate them, because AWS can
suspend an entire account over complaint rates regardless of how it is
partitioned inside. A separate account is the only mechanism that genuinely
stops Acme's list quality from reaching Globex.

**The no-fallback rule then simplified the platform's own account.** The
recommendation here started as a separate AWS account for the platform silo,
on the grounds that tenants sharing a default sender would share reputation
with MMG's own conference mail. With no tenant mail flowing through platform
SES at all, there is nothing left to isolate: the platform identity carries
only operational mail, which is platform-authored, low volume, and goes to
people who have just signed up. So **platform-operational email is a new
identity in the existing account**, not a new account. A new account would
also have started in the SES sandbox and needed its own production-access
request for no benefit.

### Why email cannot follow the Stripe rule exactly

Item 7 settled that platform has **no** Stripe fallback: an unconfigured
tenant simply cannot take payments, which is contained. Email differs in one
way that matters. An unconfigured tenant cannot send password resets or
verification links, so its users have no route back into their own accounts.
That is why part 2 exists. **The gate is the protection; the send-time refusal
is only the backstop.**

### The mechanism, and a correction found while writing this

The refusal cannot key on the env sender being absent, because platform still
needs `EMAIL_FROM` set for its own operational mail.

The first proposal was to key it on the **ambient tenant lane**
(`getTenantOrgId()` non-null means tenant mail), reasoning that `logEmail`
already resolves org in exactly that order and operational sends run outside
any lane. **Reading `src/lib/tenant-context.ts` before writing it down showed
that would have broken master.** `runWithTenant` populates the
AsyncLocalStorage store unconditionally; `RLS_SET_LOCAL` only controls whether
the Prisma extension issues `SET LOCAL`. So on master every swept route
already carries MMG's org in the lane, none of them have `settings.email`, and
the refusal would have stopped all production email on deploy.

**Use the mechanism Stripe already proved, not a new flag.** The fix for that
was going to be a boolean `REQUIRE_TENANT_EMAIL_CONFIG` set only on platform.
`src/lib/stripe.ts` had already solved the identical problem better on Aug 24,
2026: the env key is an **allow-list of one**. Only the org named by
`STRIPE_ENV_FALLBACK_ORG_ID` may use the shared key, and every other org with no
key of its own is refused. Email mirrors it as `EMAIL_ENV_FALLBACK_ORG_ID`:

- **Master** names MM Group, so MMG resolves the env sender and behaves
  byte-identically to today's singleton. The stray second "Meeting Minds" org
  row noted in §8 is then refused rather than silently sending as MMG.
- **Platform** leaves it unset, so no tenant can ever send as the operator. The
  platform's own operational mail is not lane-bound, so it keeps using
  `EMAIL_FROM` untouched.

That file also records why the boolean would have been worse. It warns against
overloading a tenancy flag, because "a tenancy flag toggled for a test changes
where money lands". The same argument applies to where mail appears to come
from.

Copy the two safety rails with it: the boot-time check in
`src/instrumentation.ts` that errors when a key exists with no org allowed to
use it, and the **master deploy order**, meaning set `EMAIL_ENV_FALLBACK_ORG_ID`
before deploying or MMG's sends refuse.

### Operational facts to plan onboarding around

- **Every new AWS account starts in the SES sandbox**: 200 emails a day, only
  to addresses already verified. Leaving it needs a production-access request
  that a human at AWS reviews, usually about a day, occasionally longer, and it
  can be refused. Raise it when the account is created, not when the tenant
  needs to send.
- **DNS is the tenant's and cannot be delegated.** Mail from
  `noreply@acme.com` requires records on acme.com, which at a hospital or a
  pharma company can take weeks. Offer both: their own domain, or a subdomain
  we control such as `acme.mail.<platform-domain>`, which works the same day
  and reads as less theirs. Starting on ours and migrating later is a
  reasonable default.
- **Cost is time, not money.** SES is roughly $0.10 per 1,000 emails, so a
  tenant sending 50,000 a month costs about five dollars. The real cost is
  about an hour of setup per tenant plus the two waits. Comfortable to roughly
  twenty tenants; past that, script account creation and the IAM key, since the
  AWS approval and the DNS are the only parts that cannot be automated.

### Blast radius when this is built

- `getSesClient()` ([email.ts:276](../src/lib/email.ts)) is a module singleton
  with no org parameter. It becomes `getEmailProvider(orgId)` with an org-keyed
  bounded TTL cache, the same shape as `getStripe(orgId)`.
- The fallback expression `params.from?.email || DEFAULT_FROM_EMAIL` appears at
  email.ts lines 141, 193, 232 and 379, once per provider path. Each is a
  refusal point under the flag.
- `DEFAULT_FROM_EMAIL` falls back to a **hardcoded personal address**
  (email.ts:32). That must not resolve on the platform silo.
- `emailFromAddress` is validated as a well-formed address and nothing more.
  `brandingFrom()` (email.ts:3581) hands it straight to `SendEmailCommand`, and
  nothing anywhere checks it is a verified SES identity. **Precedent:** the
  Aug 6, 2026 group-registration coordinator email fell through to an
  unverified sender and SES rejected it after the registration had already
  committed.
- **36 files call `sendEmail`**, many fire-and-forget by contract, because a
  failed confirmation must never roll back a committed registration. A
  send-time throw therefore produces silent non-delivery plus log noise, which
  is exactly why the gate belongs at configuration time.
- Storage follows item 7 exactly:
  `settings.email = { provider, apiKeyEncrypted, fromAddress, fromName, verifiedAt }`,
  AES-256-GCM through `updateOrganizationSettings`.
- **Verification must be a real send, not a credential probe.** A valid SES key
  passes an API call while the from-address is still unverified, which is
  precisely the Aug 6 failure. Only a delivered test email stamps `verifiedAt`,
  and that stamp is what unblocks publishing an event and inviting a user.
- One synchronously user-visible path needs its own answer: forgot-password
  returns the non-enumerable "if that email exists, we sent a link", which on an
  unconfigured tenant is a lie told to someone locked out. Saying the
  organisation has not configured email leaks nothing about whether the account
  exists.

**Not started.** No code, no schema. Buildable on master as a no-op under the
flag, exactly as item 7 was.

---

## Rehearsal, Aug 21 2026 — five defects before any infrastructure was bought

Phase A of [PLATFORM_PROVISIONING.md](PLATFORM_PROVISIONING.md) ran against the
two-tenant sandbox and found five defects, every one of which rendered an empty
screen rather than an error and passed a green build. The most serious would
have made **public registration dead on arrival** on the platform; another had
our incident log and server metrics reachable by a customer's administrator.
The table, the reasoning, and the four guards now in place are in that document
under "What the rehearsal found".

Two consequences for this list:

- **Item 6 (identity) has a bigger blast radius than recorded below.** The nine
  `/api/registrant/**` self-service routes are deliberately unwrapped, pending
  that decision. Under RLS they fail closed, which means the **entire registrant
  portal** — my-registration, invoices, quotes, barcodes, promo codes — returns
  nothing on the platform until item 6 is resolved. That is worth weighing when
  scheduling it.
- **A new item, not previously on this list: sweep every `ADMIN` gate.** Finding
  4 is one instance of a class — authorisation written when `ADMIN` meant an MMG
  employee, re-read now that it can mean a customer. Bounded, and cheaper before
  launch than after. ✅ **DONE Aug 21, 2026** — see "ADMIN-gate sweep" below.
  (An earlier revision of this line said "four of the five findings share one
  cause". That was wrong: only finding 4 does. Corrected rather than deleted,
  because the overstatement was in the direction that makes a real risk sound
  bigger, and the next reader should know which number to trust.)

---

## ADMIN-gate sweep — ✅ DONE (Aug 21, 2026)

Prompted by rehearsal finding 4 (`Docs` and `Infra / Ops` were `adminOnly`,
written when ADMIN meant an MMG employee). The sweep asked one question of every
authorisation check: **is this still right when ADMIN — or SUPER_ADMIN — is a
customer?**

The serious finding was not `ADMIN` at all.

### Tier 1 — `x-org-id` was a cross-tenant read *and write*

Six sites let a `SUPER_ADMIN` swap the acting organisation by setting a request
header, gated on the role alone with no `PLATFORM_ORG_ID` check:

| Site | Effect |
|---|---|
| `src/lib/api-auth.ts` ×2 (session + mobile JWT) | inherited by **12 API routes** |
| `src/app/api/organization/route.ts` GET | read any tenant's organisation |
| `src/app/api/organization/route.ts` **PUT** | **write** any tenant's organisation — the id went straight into `organization.update({ where: { id: orgId } })` |
| `src/app/api/organization/branding/route.ts` | read any tenant's branding |
| `src/app/api/events/route.ts` | list any tenant's events |

**This is a different and worse shape than the five rehearsal defects.** Those
all failed **closed** — no lane, RLS matches nothing, an empty screen. This
failed **open**: the overridden id is used directly, so a later
`runWithTenant(orgId)` enters the *target* tenant's lane and RLS serves their
rows faithfully. RLS is not a backstop against a caller who has been handed the
wrong tenant id; it is an accomplice.

All six now resolve through `resolveActingOrgId()` in `platform-operator.ts`,
which honours the header for a platform operator only, logs an honoured
override at info (a cross-tenant action must be traceable) and a refused one at
warn (an attempt to reach another tenant is a security event), and stays silent
on the no-op case the org switcher produces routinely.

### Tier 2 — four platform-ops routes on a bare check

`api/logs` and `api/logs/archive` (cross-tenant `SystemLog`, DELETE-capable),
`api/admin/alerts/silence` (silences **our** paging), and `api/organizations`
(enumerates every tenant: name, slug, logo, user and event counts). All said
`SUPER_ADMIN`; none called `denyNonOperator`. All four now do.

### Verified correct, deliberately unchanged

Every `organization/*` credential, user and branding-write route (a tenant admin
managing their own org); `admin/infra` + `traffic` (the bare check is a coarse
pre-filter and `canActAsPlatformOperator` picks the scope — already right);
the abstracts chair-override; MCP consent. The `admin/infra` page derives
`isOperator` from the server's `scope` field rather than a client role check,
which is better than what was asked for.

**Flagged, not changed, needs an owner call:** `api-keys` and `oauth-clients`
let a SUPER_ADMIN grant the `INTERNAL` rate-limit tier, which exempts a key from
*our* rate limit. It is org-bound so it is not a leak, but on the platform it
lets a tenant lift their own ceiling.

### Why the rehearsal missed it, and the lesson

The rehearsal signed in as a tenant **ADMIN**. The gate here is **SUPER_ADMIN**,
and *"SUPER_ADMIN means us"* is the identical assumption one level up.
`platform-operator.ts` documents this exact risk in its own header — that
excluding SUPER_ADMIN from `ASSIGNABLE_USER_ROLES` "is a property of one screen,
not an invariant" — and the predicate was still adopted by only eight files.

> **Writing the right predicate is half the job; the sweep that adopts it is the
> other half.** A guard that exists but is never called is indistinguishable
> from no guard, and is worse than none, because its existence reads as
> coverage.

`scripts/check-platform-operator.sh` (gating in CI) now pins three invariants:
`x-org-id` has exactly one reader; every listed platform surface calls the
operator predicate; and no platform surface decides authorisation with a
standalone `SUPER_ADMIN` comparison. All three are mutation-verified.

**Master is unaffected.** `PLATFORM_ORG_ID` is unset there, so
`canActAsPlatformOperator` reduces to the previous role test and the dashboard
org switcher behaves exactly as before — asserted by a dedicated test rather
than reasoned about.

---

## What happens next

**Updated Aug 21, 2026.** **Every item on this list is now decided.** Items 4,
5, 7 and 8 are built; item 3's nuance is resolved; item 6 was settled on Aug 21
and the ADMIN-gate sweep it spawned is done. What remains is build work and one
standing question below.

- **No discussions left.** Item 6 (§6) closed the list, and its build landed
  the same day: the constraint, the resolver, every by-email site, the CI gate,
  and the registrant portal's own tenant lane. This bullet used to warn that the
  portal would return nothing on the platform until item 6 shipped. That was
  already stale when it was written, and it is corrected in place rather than
  deleted, because a stale caution is the kind of line that makes someone
  re-scope finished work.
- **One small owner call outstanding**, surfaced by the ADMIN-gate sweep and not
  acted on: `api-keys` and `oauth-clients` let a SUPER_ADMIN grant the
  `INTERNAL` rate-limit tier, which exempts a key from *our* rate limit. It is
  org-bound so it is not a leak, but on the platform it lets a tenant lift its
  own ceiling.
- **Build-later (decided, not scheduled):** items 1, 2 and the §3 stamp. Each
  has its "build-time items" listed in its section, and all three now depend
  on the privileged lane that item 5 shipped, so they are unblocked whenever
  they are scheduled. **Item 9 (per-tenant email) joins them**, and unlike the
  other three it is buildable on master today as a no-op under its flag, the
  way item 7 was.
- **Then it is the platform instance itself**, which is mostly not application
  code: second box + fresh DB, the two DB roles, applying `prisma/rls/*.sql`,
  turning on `RLS_SET_LOCAL` and `TENANCY_ENFORCE_HOST`, DR/monitoring/runbooks
  before tenant #1 (guardrail 2), a tenant-onboarding flow, per-tenant custom
  domain TLS, and dogfooding one real MMG event on it (guardrail 3). See
  [MULTI_TENANCY.md](MULTI_TENANCY.md) §0.
- **Still globally shared, and each a precondition:** the CRM's single
  `CRM_EMAIL_FROM_ADDRESS` reply-forward mailbox (a real cross-tenant leak on a
  shared instance, see `MULTI_TENANCY_IMPACT.md` §7.1), MediaMTX as a singleton,
  and the globally-unique `invoiceNumber` / `qrCode` / `dtcmBarcode` /
  `stripePaymentId` namespaces. **SES came off this list on Sep 2, 2026**:
  item 9 (§9) decided one AWS account per tenant with no shared tenant-mail
  sender, so it is now scheduled build work rather than an undecided
  precondition.
- **The eight unpoliced models: audited Aug 21, 2026. No new decisions.**
  They were recorded as eight open questions; they are three, and two of the
  three are already-scheduled work rather than a gap:

  | Models | Verdict |
  |---|---|
  | `EmailTemplate`, `InvoiceCounter`, `EventBillingAccount`, `ImportLog`, `EventStats` | Each carries a **required `eventId`** and nothing else. `Event` is itself unpoliced, so these inherit its status exactly — they are the **Event RLS** decision, not a separate one. |
  | `Notification`, `DeviceToken` | Keyed on `userId`. They follow **item 6 (identity)**. |
  | `McpOAuthClient` | **Correctly global.** A DCR registration is created by an anonymous client *before* anyone consents, so it has no org to carry. The org binding lives on `McpOAuthAccessToken`. |

  **And three models the list missed, which look like the real gap and are not:**
  `ApiKey`, `McpOAuthAccessToken` and `McpOAuthAuthCode` all *do* carry
  `organizationId` and have no policy. Policying them would deadlock login:
  they are read on the **authentication** path, which is what *establishes* the
  lane — no lane exists yet to read the row that says which lane you are in.
  They are the same class as `TenantDomain`: deliberately global, defended by
  the fact that every lookup is by secret hash, so there is nothing to
  enumerate. Written down here because to the next person doing a sweep they
  look exactly like an oversight.

  The general rule worth keeping: **anything read before identity is resolved
  cannot be protected by identity.**
- This document stays the single revisit point: update it in place as items
  close.
