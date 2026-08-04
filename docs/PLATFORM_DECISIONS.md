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
| 3 | Org-null audit-write loss | ✅ DECIDED (one nuance to confirm) — stamp default MMG org id + tenant identifier |
| 4 | The 16-instance `?? ""` fallback pass | ✅ DECIDED (same nuance) — default MMG org id + tenant identifier |
| 5 | Privileged maintenance lane | 🔶 OPEN — inputs delivered (§5), discussion pending |
| 6 | Phase-1 identity model | 🔶 OPEN — owner thesis + counter-inputs recorded (§6), discussion pending |
| 7 | Per-tenant Stripe / Zoom / Anthropic keys | ✅ DECIDED — **next immediate build priority** (not started) |
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

**⚠ Open nuance (flagged by Claude, to confirm before build):** under RLS,
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

**Recorded design posture:** one mechanical pass replacing the `?? ""`
fallback with resolution to `DEFAULT_ORG_ID` (now live on master — §8), with
a log line when the fallback fires. Same §3 nuance applies (operator-lane
visibility); same confirmation point.

---

## 5. Privileged maintenance lane — 🔶 OPEN (owner asked for inputs; discussion pending)

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

## 7. Per-tenant API keys (Stripe, Zoom, Anthropic — and MMG's own) — ✅ DECIDED, next build priority

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

## What happens next

- **Immediate build priority (on go-ahead): item 7** — per-tenant keys.
- **Two discussions to schedule:** item 5 (privileged lane — decisions a–d in
  §5) and item 6 (identity model). The §3/§4 operator-visibility nuance rides
  along with the item-5 discussion.
- **Build-later (decided, not scheduled):** items 1, 2, 3, 4 — each has its
  "build-time items" listed in its section.
- Once items 5 + 6 close, this document gets updated in place (statuses
  flipped, decisions appended) — it is the single revisit point for this
  round.
