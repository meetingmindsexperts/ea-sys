# Platform pre-launch decisions — the 8-item round (Aug 4, 2026)

> **What this is.** The Phase-2 multi-tenancy sweep finished on Aug 4, 2026 (all 20
> domains — see [MULTI_TENANCY.md](MULTI_TENANCY.md) §13). What remained before the
> future **platform** instance (the second silo hosting external tenants under RLS)
> can launch was a list of 8 items — decisions, one infrastructure build, and one
> ops step. This document records that round: **what is done, what the owner
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
| 6 | Phase-1 identity model | 🔶 OPEN — owner thesis + counter-inputs recorded (§6), discussion pending |
| 7 | Per-tenant Stripe / Zoom / Anthropic keys | ✅ **IMPLEMENTED** Aug 4, 2026 (§7) |
| 8 | Master ops step (TenantDomain + DEFAULT_ORG_ID) | ✅ **DONE** Aug 4, 2026 — verified live (§8) |

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

## 6. Phase-1 identity model — 🔶 OPEN (thesis recorded; discussion pending)

**Background.** Today `User.email` is **globally unique** — one email = one
account across everything. On a multi-tenant platform, the same person (e.g.
a doctor) may register with two different tenant orgs' events.

**Owner's thesis (his words, recorded as a starting position, not a final
decision):** *"I think one email is global and unique per tenant, and for the
other tenant, the email is global and unique. We need to keep that
distinction. This is my thought process, I may be wrong, we will discuss
further."* — i.e. **email uniqueness is scoped per tenant**: the same address
can exist independently in two tenants, as two separate accounts.

**Claude's inputs:**
- This is the **standard SaaS model** and likely the right call.
- Implications to walk through in the discussion:
  - **Login becomes tenant-scoped** — you sign in *on a tenant's domain*, and
    the credential lookup keys on `(organizationId, email)`, not global email.
  - The global-unique `User.email` index changes to a compound
    `(organizationId, email)` unique.
  - **The hard edge is the org-null roles** (REVIEWER crossing orgs,
    SUBMITTER, REGISTRANT) — they currently rely on ONE global account
    spanning orgs. Per-tenant uniqueness needs a story for them (per-tenant
    accounts vs a Membership join model).
  - The **two-silo topology softens this**: a person active in MMG *and* a
    platform tenant already has two accounts (separate DBs), so per-tenant
    uniqueness inside the platform DB is the consistent continuation, not a
    break.
- Nothing else on this list is blocked by item 6 — items 7 and 8 proceed
  independently.

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

**Updated Aug 11, 2026.** Items 4, 5, 7 and 8 are done; item 3's nuance is
resolved. **Item 6 (identity model) is now the only decision still open**, and
it is the last thing on this list that needs a conversation rather than a
build.

- **One discussion left:** item 6 (§6). Nothing else here is blocked by it.
- **Build-later (decided, not scheduled):** items 1, 2 and the §3 stamp. Each
  has its "build-time items" listed in its section, and all three now depend
  on the privileged lane that item 5 shipped, so they are unblocked whenever
  they are scheduled.
- **Then it is the platform instance itself**, which is mostly not application
  code: second box + fresh DB, the two DB roles, applying `prisma/rls/*.sql`,
  turning on `RLS_SET_LOCAL` and `TENANCY_ENFORCE_HOST`, DR/monitoring/runbooks
  before tenant #1 (guardrail 2), a tenant-onboarding flow, per-tenant custom
  domain TLS, and dogfooding one real MMG event on it (guardrail 3). See
  [MULTI_TENANCY.md](MULTI_TENANCY.md) §0.
- **Still globally shared, and each a precondition:** SES + the CRM's single
  `CRM_EMAIL_FROM_ADDRESS` reply-forward mailbox (a real cross-tenant leak on a
  shared instance, see `MULTI_TENANCY_IMPACT.md` §7.1), MediaMTX as a singleton,
  and the globally-unique `invoiceNumber` / `qrCode` / `dtcmBarcode` /
  `stripePaymentId` namespaces.
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
