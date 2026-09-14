# Budget & Procurement Module: build plan

**Status: PLANNED, NOT BUILT. Do not start without owner go-ahead.**

Companion to [BUDGET_PROCUREMENT_MODULE.html](BUDGET_PROCUREMENT_MODULE.html) (rev. 3.6 plain edition, rev. 3.5 technical text). The spec says *what* is built and *why*. This document says *in what order, in which files, with which gates, and what it costs the box*. Written 10 September 2026 from the spec's Part 2 §3, §5, §10 and §12 and from measurements of the code and the production instance as of commit `8e7c9543`.

Two questions from the owner shaped it: what does this do to the server at deploy time and under hundreds of concurrent users, and does it need its own worker. Section 1 answers both before any code is listed.

---

## 1. Capacity, concurrency and deployment

### 1.1 What is measured today

| Measure | Value | Source |
|---|---|---|
| Instance | t3.large (2 vCPU, 8 GiB), Mumbai | AWS_OPERATIONS.md |
| CPU, idle | about 2.4%; 40 to 78% during a deploy, for under a minute | CRM plan §infra headroom, Aug 2026 |
| CPU credits | pinned at 864 (maximum) | same |
| Memory | about 2.0 GiB used of 7.6, plus 4 GiB swap | same |
| Pooler connections | 24 of 90 in use (web pool 10, worker pool 10) | spec §3 |
| Container caps | web 3500m per slot, worker 2600m, mediamtx 512m | docker-compose.prod.yml |
| Event-loop p99 | 10 to 20 ms typical, worst since boot 173 ms | `/api/health` `eventLoop` |
| Load test | **never run against prod**; k6 scripts exist in `loadtest/k6/` | LOAD_TESTING.md, conference readiness memo |

The burstable note in AWS_OPERATIONS.md §3 matters here: a t3.large throttles to a 30% per-vCPU baseline once credits are gone, and throttling presents as sustained slowness, not a peak. Credits have never drained, and the two CloudWatch alarms `ea-sys-ec2-cpu-high` and `ea-sys-ec2-cpu-credits-low` already page if they do.

### 1.2 What the module adds, and where it can hurt

The module's users are internal: a few dozen staff raising requests, three approvers, one finance user. Its *count* of requests is small. Its *weight* per request is what to watch, because the web tier is one Node process per slot and the public registration rush shares that process.

| Load | Size | Design rule that keeps it off the request path |
|---|---|---|
| Budget editor saves | tens per day | Ordinary row writes inside one transaction |
| Dashboard and cross-event view | a few hundred reads per day | **Totals are stored, never recomputed on read.** `EventBudget` carries `plannedExpenseTotal`; each `BudgetLine` carries `planned / committedOpen / committedTotal / actual / paid`, updated inside the transaction that changes them. The cross-event view reads one row per budget (about 30 a year). |
| Version compare | occasional | Two versions' lines by `lineKey`, indexed; capped at the line count |
| Spend request form side panel | per keystroke on one field | One indexed read of the chosen line's stored figures |
| PO PDF | one per approval | pdfkit on demand, the same path invoices take today; never generated in bulk |
| QuickBooks push | one per approval | **Never on the request path.** The route writes an outbox row in the same transaction; the worker posts it. |
| QuickBooks read-back | nightly, plus on demand | Worker job, batch-bounded, one tenant lane per row |
| FX rates | once a day | Worker job |
| Reminders and escalation | hourly sweep | Worker job, indexed on `ApprovalStep.dueAt` |
| Reports (§11) | monthly | Paginated, capped like every other list (200 or 500 rows), CSV via the shared escaper |

So the request path gains only indexed reads and short transactions. Everything that talks to QuickBooks, sends email in volume or scans tables runs in the worker, which already has its own pool and its own CPU budget.

**The genuine collision is a registration rush plus a staff report at the same moment.** That collision exists today for every staff screen and is bounded by the same three things: nginx per-IP limiting, the in-app rate limits on the public routes, and pgbouncer. The module does not change the shape of that risk, but it is the reason §1.5 makes a load test a Phase 0 gate: we should know the box's ceiling before adding a module rather than discovering it during a pilot.

### 1.3 Deploy-time profile

A deploy is: ECR pull and extract (seconds), start the inactive slot (cold start, the 40 to 78% CPU spike, under a minute), `prisma migrate deploy` (additive statements, sub-second per phase), health check, graceful nginx reload, stop the old slot. The old slot serves throughout, so the spike is invisible to users.

What the module changes: a larger standalone bundle (about 3 to 5 MB more server code; the App Router code-splits client chunks per route, so the public pages do not grow) and one more second of cold start. The worker image copies `src/` wholesale, so it grows by the same amount. Both are within what the blue-green health check waits for. Memory during the swap, when both web slots plus the worker are up, is today about 2 GiB actual against caps that sum past physical memory; actual usage is what matters and there is room for a second web slot twice over.

Two rules to keep, both already practice: never deploy during a registration rush or on an event morning, and every migration stays additive and idempotent so the old slot keeps serving against the new schema (ROLLBACK.md §1.6 records that a rollback across a migration is still undrilled).

### 1.4 One worker container, with a switch to split later

Four new jobs join the nineteen in `worker/index.ts`. They stay in the same container because they are I/O-bound (waiting on QuickBooks or SES), batch-bounded, and each runs under its own expiring lease (`worker/lib/job-lease.ts`, 5-minute TTL, 60-second heartbeat), so a slow QuickBooks poll cannot block scheduled emails or certificate issue. A second container today would double the ops surface (watchdog, health check, digest cadence, deploy) and isolate nothing.

The cheap preparation, built in Phase 3 with the first new job: a `WORKER_JOBS` environment variable, a comma-separated allow-list read once in `worker/index.ts` and applied to the `JOBS` array before `cron.schedule`. Unset means every job, which keeps master byte-identical. With it, the same worker image can run twice (say, `WORKER_JOBS=outbox-drain,qbo-readback` on a second small instance and everything else on the box) with no code change. The daily digest's `EXPECTED_JOBS` roster (`src/lib/worker-jobs.ts`) is per deployment, so a split also sets that roster per instance; the plan notes it so the digest does not report the moved jobs as under-running.

**When to split, in numbers.** Any one of: sustained CPU above 50% for ten minutes outside a deploy window; `/api/health` `eventLoop.p99Ms` above 200 ms for the web slot during business hours; pooler connections above 60 of 90; available memory under 1.5 GiB. First response is the documented resize to t3.xlarge (AWS_OPERATIONS.md §3, brief downtime, Elastic IP retained) or `c7a.large` if credits are the problem; the split comes after that if the worker alone is the load.

### 1.5 Phase 0 gate: the load baseline

Before Phase 1 starts, run `loadtest/k6/read-burst.js` against production off-hours per LOAD_TESTING.md and record p95 latency, CPU and event-loop figures for the current build. Repeat the same run at the end of Phase 2 with the module's routes in the image (they are behind the module flag and cost nothing when off, so the comparison isolates the bundle and cold-start effect) and again at the end of Phase 4 before the pilot, with a short authenticated scenario against the budget dashboard added. Three numbers, same script, same box: that is how we know rather than believe that the module did not move the ceiling.

---

## 2. Effort and shape

Sized against the two modules already in the tree.

| | CRM (shipped) | HR (shipped) | Budget & Procurement |
|---|---|---|---|
| Tables | 12 | 6 | 20 to 22 |
| Source files | 133 | 38 | 150 to 200 |
| Lines of code incl. tests | 28k | 7.8k | 30k to 40k |
| Screens | 10 | 5 | 15 |
| Worker jobs | 2 | 1 | 4 |
| Test files | 49 | 22 | 70 to 90 |

Per phase, following the spec's §12 timeline (16 weeks to a parallel run, 22 with revenue and benchmarking):

| Phase | Weeks | Tables | Files | LOC | Worker jobs | Gate to leave the phase |
|---|---|---|---|---|---|---|
| 0 Decisions | before 1 | 0 | 0 | 0 | 0 | §3 answered, load baseline recorded |
| 1 Budget core | 1 to 5 | 8 | 45 | 9k | 0 | Budget written, versioned, approved single-step, closed; RLS harness green |
| 2 Purchasing | 6 to 9 | 8 | 55 | 11k | 1 (escalation) | Request to PO to receipt on a sandbox realm, no QuickBooks yet; PDF to supplier |
| 3 Connector | 10 to 12 | 3 | 30 | 7k | 3 (outbox, read-back, FX) | Outbox drains to the sandbox; read-back matches bills; Integration Monitor shows a forced failure and a recovery |
| 4 Migration and pilot | 13 to 16 | 2 | 12 | 2.5k | 0 | Open POs linked; archive loaded; one pilot event through a month-end close |
| 5 Revenue | 17 to 20 | 2 | 15 | 3k | 0 | Event P&L and cross-event view reconcile to QuickBooks for the pilot |
| 6 Benchmarking | 21 to 22 | 0 | 15 | 3k | 0 | Picker, column, approver delta line on a real previous edition |

Two developers as the spec assumes: the connector (OAuth, pulls, mapping screens) is the junior developer's track from Phase 2 onward.

---

## 3. Phase 0: what must be answered before a line is written

From spec §14, the items that gate Phase 1 rather than Phase 3:

1. **QuickBooks bill practice** (Q16): are bills entered from the PO today, with the Class? The read-back model depends on it. If not, the operating rule starts with the pilot and Phase 4 carries a training step.
2. **FX source** (Q15): Central Bank of the UAE daily rates unless finance needs intraday. Decides whether `FxRateProvider` fetches a page or a paid feed.
3. **Sandbox realm**: a QuickBooks Online sandbox company for Phases 2 to 4. Without it Phase 3 tests against production accounting.
4. **`Event.code` uniqueness**: Phase 1 makes it unique per organisation and immutable once referenced. Today it is a nullable, free, name-derived string (`prisma/schema.prisma` line 349). Phase 0 runs a read-only count of duplicates and nulls on production so the Phase 1 migration's backfill is written against real data, not assumed clean.
5. **Load baseline** (§1.5).
6. **ProcurementExpress export**: one real CSV export of open POs and the last two years of closed ones, so Phase 4's importer is written against the real column set (the Freshsales lesson: a declared format, never a guessed one).

### 3.1 Phase 0 record (Friday 11 September 2026)

Owner decision the same day: Phase 0 today, Phase 1 starts Monday 14 September. The load baseline runs Sunday 13 September (no events; Friday and Saturday carry the Pan Hematology Summit and the Oman Oncology Pharmacy Value Forum, and the written rule is off-hours). It gates the Phase 2 comparison, not the Phase 1 code, so Monday is unaffected.

| # | Item | State | Who | Detail |
|---|---|---|---|---|
| 1 | QuickBooks bill practice (Q16) | OPEN | Medhat / finance | Are bills entered from the PO today, carrying the event Class? If yes, read-back works from day one of the pilot. If no, the operating rule starts with the pilot and Phase 4 carries a training step. Needed before Phase 3, not before Monday |
| 2 | FX source (Q15) | OPEN | finance | Default in the spec: Central Bank of the UAE daily rates, unless finance needs intraday. Decides whether `FxRateProvider` reads a published page or a paid feed. Needed before Phase 2 |
| 3 | QuickBooks Online sandbox company | OPEN | owner | Create one in the Intuit developer account for the app. Without it Phase 3 tests against production accounting. Needed before Phase 2 ends |
| 4 | `Event.code` uniqueness | DONE | measured, read-only on production | See below |
| 5 | Load baseline (§1.5) | SCHEDULED, Sunday 13 Sep | Claude, owner present | See below |
| 6 | ProcurementExpress export | OPEN | Medhat / finance | One CSV of open POs plus the last two years of closed ones. Needed before Phase 4; the earlier the better, since the subscription ends |

**Item 4, `Event.code` on production (39 events, one organisation):** 20 events have a null code, 19 have one, all 19 are distinct and all match `^[A-Z0-9-]+$`, and no event has an empty string. Running `deriveEventCode()` (the helper `POST /api/events` and MCP `create_event` already use) over the 20 null names produces 20 codes with **zero collisions** against the existing 19 and among themselves, so the Phase 1 migration is a plain backfill followed by the unique index; no collision handling is needed on real data. What it produces, for the record:

| Derived | Event |
|---|---|
| `MEHFC2026` | Middle East Heart Failure Conference 2026 |
| `EMM1J2026` | EGHS Monthly Meeting - 19th Jan 2026 |
| `5GHEF2026W` | 5th GCC Hematology Expert Forum 2026 - Wave 1 |
| `EMM2F2026` | EGHS Monthly Meeting - 2nd Feb 2026 |
| `2OGSC2026` | 2nd Oman Gastroenterology Society Conference 2026 |
| `9BSCUC2026` | 9th Big Sky Cardiology Update Conference 2026 |
| `1ICOCH2026` | 1st International Conference of Classical Hematology 2026 |
| `OASIS2026` | Oncology Advances & Scientific International Summit 2026 |
| `1EHC2026` | 14th Emirates Haematology Conference 2026 |
| `WT` | Webinar Test |
| `1HFF2026` | 1st Heart Failure Forum 2026 |
| `CADIF2026` | Cold Agglutinin Disease in Focus 2026 |
| `HPHFS2026` | Haya Public Health Foresight Summit 2026 |
| `I2026` | IOHNC 2026 |
| `6IOHNC2026` | 6th International Oncology & Hematology Nursing Conference 2026 |
| `E2026` | EIGHC 2026 |
| `8OSOHC2026` | 8th Omani Society of Hematology Conference 2026 |
| `1IBC2026` | 1st International Burn Conference 2026 |
| `DDM2026` | DH Departmental Meeting 2026 |
| `1BSCUC2027` | 10th Big Sky Cardiology Update Conference 2027 |

Two things the numbers show that the plan did not: **ordinals are truncated to their first digit** (`14th` and `10th` both derive to `1`, so `1EHC2026` and `1BSCUC2027`), and **a name that is already an acronym derives to a near-empty code** (`IOHNC 2026` to `I2026`, `EIGHC 2026` to `E2026`, `Webinar Test` to `WT`). Neither collides today, but a code becomes the accounting Class label and the budget's `eventCode`, so both are worth a decision on Monday: either improve `deriveEventCode` for ordinals and acronym names before the backfill, or backfill as-is and let organisers rename (the code stays editable until a numbered document, budget or commitment references it, which is the spec's own rule). The 20 are mostly DRAFT events; the one PUBLISHED row is the 10th Big Sky 2027.

**Item 4, the Monday decision (owner, 14 September 2026): backfill nothing.** The unique index on `Event(organizationId, code)` is created with NULLs left as they are, so the 20 events without a code stay without one and cannot hold a budget until an organiser sets a code in Settings. `deriveEventCode` is unchanged (the ordinal and acronym oddities stand for NEW events too, and a derived code that collides with an existing one is now dropped to null with a warning rather than suffixed). The migration names any duplicate before the index would refuse it. Consequence for the create paths: an explicit code that is taken is a 409 `EVENT_CODE_TAKEN` on the event POST, the event PUT, MCP `create_event` and MCP `update_event`; a code that a budget references can no longer change or be cleared (409 `EVENT_CODE_REFERENCED`); the invoice service's lazy backfill treats a collision as an expected miss.

**Item 5, the baseline command and what to record (Sunday):**

```bash
k6 run -e BASE_URL=https://events.meetingmindsgroup.com -e EVENT_SLUG=BHS2026 \
  -e PEAK_VUS=15 -e RAMP=30s -e HOLD=2m loadtest/k6/read-burst.js
```

Why those numbers: from one machine every request shares one client IP, and nginx caps a single IP at 100 requests/s (`limit_req` burst 200, `limit_conn` 100). Each virtual user makes two requests per iteration with up to 0.5 s of think time, about 6 requests/s, so 15 users sit just under the nginx limit and the run measures the box, not the limiter. The `check-email` half still trips the app's own 200/hour per-IP limit within seconds, which is expected and documented in LOAD_TESTING.md; the number that matters is the `public-event-detail` GET, the heaviest read on the register page. The machine's egress IP (94.202.108.26) is in fail2ban's `ignoreip`, so the 429s cannot ban it. Record, into this section: `http_req_duration` p95 and p99 for the `public-event-detail` tag, `rate_limited_429`, `http_req_failed`, the CloudWatch 1-minute CPU maximum during the run, `CPUCreditBalance` before and after, and `/api/health` `eventLoop.p99Ms` and `worstMaxMs` read during the hold. Repeat with the identical command at the end of Phase 2 and Phase 4.

**A real-traffic data point taken today instead**, Friday 11 September, the Pan Hematology Summit's first day (22 registrations, badge scanning in the morning): CPU averaged 4 to 7% with 5-minute maxima of 5 to 12%, `CPUCreditBalance` pinned at 864, `/api/health` event loop p99 11 ms at noon. The one spike, 84.8% at 11:28 GST, is the `974c0c25` blue-green deploy landing (the "40 to 78% during a deploy" line in §1.1 is now 85% once), not the event. This is the shape the baseline should confirm under synthetic load: a box that is idle on an event day.

---

## 4. Module boundary and the primitives that live in core

### 4.1 The namespace

`src/procurement/` (lib, services, integrations, hooks, components), `src/app/api/procurement/*`, `src/app/(dashboard)/procurement/*`. One-way imports procurement → core, enforced by adding the three globs to the CRM rule in `eslint.config.mjs` with the same shape, and exempting only the worker job shims that must import the module's tick functions (the `worker/jobs/crm-reminders.ts` precedent).

### 4.2 Availability flag

`PROCUREMENT_MODULE_ENABLED=true`, read by one function in `src/lib/module-flags.ts` beside `isHrModuleEnabled`, fail-closed, not derived from anything else. Enforced in depth as HR is: routes 404 when off, the dashboard layout returns `notFound()`, the sidebar entry hides, the grant checkboxes in Settings → Users do not render. This is what lets every phase deploy to production dark: the code ships, the flag stays unset until the pilot.

### 4.3 Grants

Three nullable-or-false columns on `User`, one additive migration in Phase 1: `procurementRequest Boolean @default(false)`, `procurementApproveCeilingAed Decimal?`, `procurementApproveUnlimited Boolean @default(false)`, `procurementSettle Boolean @default(false)`. Carried in the JWT and re-validated on the existing 5-minute cycle in `src/lib/auth.ts`, exactly like `hrAccess` (schema line 156).

Predicates in core, client-safe, in `src/lib/procurement-visibility.ts`: `canRequestProcurement`, `canApproveProcurement(amountAed)`, `canSettleProcurement`. The route guard in the module, `src/procurement/lib/procurement-roles.ts`, exports `denyNonProcurement(session, { route, need })` with `need` one of `request | approve | settle`, returning 404 when the flag is off and 403 otherwise, logging the refusal itself with the `{ route }` shape `denyReviewer` uses. API keys are refused: the approver's identity is the point of the audit trail and a key has no ceiling.

`scripts/check-guard-route.sh` pins that guards name their route with a literal string; the new guard is added to that script's list in Phase 1 so it is held to the same rule.

### 4.4 Outbox (`src/lib/outbox/`, Phase 3)

The first transactional outbox in EA-SYS, owned by the platform, with procurement as its first consumer.

Table `Outbox`: `id`, `organizationId`, `topic` (`qbo.po.create | qbo.po.close | qbo.vendor.create`), `aggregateType`, `aggregateId`, `payload Json`, `idempotencyKey @unique`, `status` (`pending | inflight | done | dead`), `attempts`, `nextAttemptAt`, `lastError`, `claimedBy`, `claimedAt`, timestamps. Index on `(status, nextAttemptAt)`.

Contract: a producer writes the row **inside the same transaction** as the state change it announces (an approved Commitment and its outbox row commit together or not at all). The drainer claims with one conditional `updateMany` (`status = pending AND nextAttemptAt <= now`), the seat-claim shape, so two workers cannot take one row; backoff 1, 5, 15, 60 and 180 minutes between attempts; after the sixth failure the row is `dead` and the drainer emails the settle grant holder through `admin-alert`. Every attempt writes a `SyncLog` row (request, response, status, error), which is what the Integration Monitor reads. Idempotency key is the aggregate id plus topic, and the QuickBooks adapter passes it as the request's idempotency header so a retried create cannot make a second PO.

Job: `worker/jobs/outbox-drain.ts`, every minute, batch of 25, under its lease. Not a shim over the module: the drainer is core and dispatches by topic to a registry the module populates at import time, so a second consumer (SES sends are named next in the spec) registers a handler and nothing in core changes.

### 4.5 Approvals (`src/lib/approvals/`, Phase 1 single-step, Phase 2 full)

Tables `ApprovalWorkflowDefinition` (per org, a list of bands with ceilings in AED and the role or grant that decides each), `ApprovalRequest` (subject type and id, amount in AED, status, `version` for optimistic locking), `ApprovalStep` (assignee, `dueAt`, `remindedAt`, `escalatedAt`, decision, decidedAt, note). Rules the primitive owns, not the callers: requester is never assignee; an approver's own request routes to the tier above; a decision is a conditional claim on the step's status so two tabs cannot both approve; every transition writes an `AuditLog` row with `source`.

Job: `worker/jobs/approval-escalation.ts`, hourly, reads steps where `dueAt` has passed and `remindedAt` is null (24h reminder) or where 48h have passed since assignment (delegate, then next tier at 96h), each a conditional claim so a retried tick cannot send twice. Notifications go through the existing `sendEmail` with `logContext`, so they appear in the email history.

Built in core because the HR module will reuse it for leave approvals; procurement is the first consumer and the only one in this project.

### 4.6 Counters, PDFs, secrets

- `requestNo` and `commitmentNo`: one organisation-scoped counter row per sequence, `INSERT ... ON CONFLICT DO UPDATE SET lastSerial = lastSerial + 1` inside the creating transaction, the `RegistrationSerialCounter` mechanism (`src/lib/registration-serial.ts`).
- The PO PDF reuses `src/lib/pdf/document-layout.ts`: `drawHeader`, `drawInfoBoxes`, `drawLineItemsTable`, `drawTotals`, `drawFooters`. New: a tax-code column and the supplier block as bill-to. No new renderer.
- QuickBooks OAuth tokens: AES-256-GCM under `NEXTAUTH_SECRET` inside `Organization.settings.quickbooks`, the Zoom and EventsAir pattern, with a `configuredAt` and fingerprint audit on change. Re-authorisation is a settle-grant action on the Integration Monitor.

---

## 5. Phase 1: budget core (weeks 1 to 5)

**Tables (one additive migration):** `EventBudget`, `BudgetTemplate`, `BudgetTemplateLine`, `BudgetCategory`, `BudgetLine`, `ApprovalWorkflowDefinition`, `ApprovalRequest`, `ApprovalStep`, plus the three `User` grant columns, `Event.previousEditionEventId`, and the `Event.code` unique index with its backfill (guarded so it runs once, the `20260902120000` pattern). `EventFinancialSummary` (the archive entry, §13a) is created here empty because benchmarking's data foundations are a Phase 1 decision in the spec.

**Files.** `src/procurement/lib/` money math (`Decimal` only, `remaining`, forecast default, at-risk test, reallocation cap), `src/procurement/services/` budget-service (create from template, version clone with `lineKey`, submit with the completeness check, approve, activate, reallocate with the 10% rule and the own-pending-request guard, freeze, close with variance notes), `src/app/api/procurement/budgets/*` (about 12 route files), `src/app/(dashboard)/procurement/budgets/*` (dashboard, editor, version compare, freeze and close-out: 5 pages), `src/procurement/hooks/`, sidebar entry, Settings → Users grant checkboxes, `src/lib/agent/tools/procurement.ts` with `list_budgets`, `get_budget`, and the `update_event` whitelist gate for `code`.

**Tenancy package, same PR as the tables:** `organizationId` on every table stamped in the service, `runWithTenant` in every handler, `prisma/rls/procurement.sql` (one domain file, the `webinar.sql` shape), fixtures in `prisma/seed-tenancy.ts`, `tests/tenancy/procurement-rls.test.ts`, `src/app/api/procurement` in `SWEPT_ROUTE_DIRS` and the agent tool file in `SWEPT_MODULES` of `scripts/check-tenant-als.sh`.

**Tests.** Money math (every rule in §7 as a table of cases), the reallocation guard both directions (mutation-verified: removing the own-pending-request check must fail a test), version clone keeps `lineKey`, the completeness check, the grant matrix per route, the RLS harness. Route tests use the real `denyNonProcurement`.

**Slice 1 record (Monday 14 September 2026).** Landed locally, held from push by owner decision (the checkpoint tag `checkpoint-2026-09-14-pre-budget-module` marks what production runs): the migration, the RLS file and harness suite, the flag, the grants through the JWT, the guard, the money library, the category seed, and the four Event.code writers. Reviewed before push: H1 (money helper vs Prisma Decimal) and H2 (immutability count outside the lane) fixed. **Open review debt for slice 2:** M1 a P2002 backstop at each Event.code writer (a same-second derived collision is a 500 today); M2 validate the code format on the REST writers and compare against a canonicalised stored value; M3 the spec's DB CHECK constraints (`fxRateToReporting > 0`, non-negative amounts, `procurementApproveCeilingAed > 0`), pending a check that the migration-replay gate tolerates constraints Prisma does not model; LOWs: grants on a target whose role changes in the same request and grants surviving demotion (an owner call on ONSITE as a grant target), the blue/green window's derived-collision 500 on the old container, the event DELETE route's missing `EVENT_HAS_BUDGET` guard against the Restrict FK, `reallocationExceedsCap` throwing where the caller expects a value, the category sortOrder read outside a transaction.

**Slice 2 record (Monday 14 September 2026, afternoon).** Landed locally on top of slice 1, still held from push. The approvals primitive in core (`src/lib/approvals/approvals-service.ts`: resolve an approver from the definition bands then the grant holders by ascending ceiling, the requester never their own approver; one step per request in Phase 1; a decision is a conditional claim on the step, so two deciders racing commit once), the budget rules (`missingForSubmission`, `cloneLineForNewVersion`, `reallocationAuthority`), the budget service (create from template, lines, header with the optimistic lock, submit, decide, new version, reallocate within and beyond the owner's 10%, freeze, unfreeze, close with variance notes and the `EventFinancialSummary` archive row, sign-off, reopen, discard), the template service (Conference / Webinar / Hybrid seeded once, one blank line per top-level expense category), the Zod schemas, the route helpers, and 17 routes under `src/app/api/procurement/` (budgets, lines, submit, decide, versions, reallocate, transition, the approvals inbox and decide, categories, templates and template lines). **Exit gate run on the local prod copy through the real routes** with the flag on, two throwaway accounts (a SUPER_ADMIN author with no grant, an ADMIN given the unlimited-approval and settle grants through the users PUT): template → lines → submit → approve → active → reallocate 5% (immediate) → reallocate 6% more (routed for approval, approved) → freeze → close (variance note demanded and then accepted, archive row written) → sign-off → reopen; and on a new version: the stale-write 409, a blank line deleted, a category left uncovered refused at submit, marked not applicable, submitted, rejected back to draft, discarded. The SUPER_ADMIN author was refused at decide (no grant) and at sign-off (no settle grant); the flag off is a 404 for everyone. **Two defects the run found, fixed in-band with tests (mutation-verified):** a reallocation INTO the contingency line was accepted, and because the totals recompute re-sizes that line from the percent, the amount left the source line and landed nowhere (refused now at the request and on the apply path a queued request takes, so a request queued before the guard fails on approval instead of vanishing money); and reopen accepted an empty reason (it undoes a close-out and a sign-off; a reason is required). **Two things for the owner to rule on, not changed:** (a) a template-seeded budget submits with nothing entered, because each blank template line counts as covering its category under spec §6a's letter ("every category has lines or is marked not applicable"); the recommended tightening is that only a line with a planned amount covers a category, so the organiser must either enter a figure or mark the category not applicable; (b) `reallocatedOut` counts only the owner's own moves (an approved move is applied with `countAgainstOwner: false`), so after 5% moved on own authority and 6% approved, the owner still has 5% of own authority left on that line; this reads as the spec's "10% without approval" but is worth confirming. No email is sent on an approval in Phase 1 (the notification rides the Phase 2 outbox). +30 tests in slice 2 (approvals primitive, rules, the route grant matrix, the service guards), +6 for the MCP tools, +3 for the review fixes: 7,240 in the suite. **MCP (same afternoon):** `list_budgets` and `get_budget` register from inside the module (`src/procurement/agent-tools.ts`, the CRM pattern; core touches it only from `register-mcp-tools.ts`), only while the flag is on and only for an OAuth grant whose user may read (an API key is refused, the HR rule), so production's tool list is unchanged until the flag turns on; verified on the local standalone through a real dynamic-client registration, consent, PKCE exchange and Bearer session (115 tools with both reads) and through a minted API key (113, neither). Package 0.4.31 → 0.4.32. **Deviation from §5 as planned:** the in-app event agent does not get these tools, because `event-tools.ts` would become a third named touch point on the import boundary; widening the boundary is an owner call.

**Slice 2 review (same day, independent adversarial pass, four lenses): 0 BLOCKER, 3 HIGH, 6 MED, 12 LOW; tenancy, RBAC, the approval claim, the version archive and the migration verified clean.** Following the slice 1 ruling (fix the HIGHs, hold the push), fixed in-band with mutation-verified tests: **H1** the requester supplied the reporting-to-AED rate that decided who approves and set the variance-note floor (a rate of 0.0001 would route a two-million budget to the lowest tier); now `resolveReportingToAedRate` in `money.ts` takes the pegs (AED, USD 3.6725, SAR 0.97933) as facts and never from the caller, a floating currency's rate must sit inside a wide plausibility band (2.5 to 8 AED), the rate and its source travel on the approval request's payload and on the SUBMIT, REALLOCATION_REQUESTED and CLOSE audit rows, and close-out now takes the same reporting-to-AED rate (the floor is 5,000 AED divided by it); **H2** reallocation was a read-then-write with no lock, so two clicks could lose a move or add up past the 10% cap; `applyReallocation` now locks both lines with `SELECT ... FOR UPDATE` in id order, re-reads them, and judges the owner's 10% on the locked row (`CAP_EXCEEDED`, 409); **H3** a move rewrote the unit cost as the reporting-currency figure and left the planned tax stale, so a USD line cloned into a new version recomputed to the wrong planned amount; the unit cost is now the planned amount back in the line's own currency and the tax is re-derived. Also fixed: **M4** the decider's authority is read from the grant ROW at decision time, not from the five-minute-old JWT (a lowered ceiling bites at once); **M5** an unknown `?status=` on the list is a logged 400 `INVALID_FILTER` and the five GETs report a failed read as a logged 500 through one `guardedRead`; **L1** the settle grant never decides, whatever else the person holds, and the users PUT refuses settle beside an approval ceiling (`SETTLE_CANNOT_APPROVE`); **L4** the close-out attendance count uses the shared `EXCLUDE_FACULTY_WHERE`; **L5** the primitive's ceiling rule is core's `approvalCeilingAed`; **L10** the reallocation amount's message; **L12** the cancel test now asserts the step write. **Open review debt for slice 3 (owner to pick):** M1 the final approver's own budget routes to a subordinate rather than being refused (spec §8.2 "tier above" is implemented as "skip the requester"); M2 reopen can leave two ACTIVE versions of one event (close v1, approve v2, reopen v1); M3 line writes carry no optimistic lock while the header does; M6 the approvals decide route ignores the named request id for a BUDGET subject and a failed apply leaves no audit row; L2 reopen keeps the close-out summary and recorded attendance, sign-off has no already-signed or closer-is-not-signer check; L3 `financeOwnerUserId` and `benchmarkSourceId` are stored unvalidated; L6 four hand-copied status maps in the template and category routes; L7 a partial template seed sticks; L8 discard also deletes an UNDER_REVIEW budget from an approver's inbox; L9 the currency lock is check-then-act and the contingency line keeps the old currency; L11 `readJson` swallows the parse reason. **Plan gaps the review named:** the own-pending-request reallocation guard, the tier-above routing, a worker for `freezeAt`, 13 of 17 handlers without a grant-matrix test, and whether Phase 1 expects a human settle-check step before approval (spec §6a) or the machine completeness check only. **The fixes verified live on the local standalone:** two concurrent 6% moves on one line ended 200 and 409 `CAP_EXCEEDED` with exactly one move applied; the moved USD line came back with its unit cost in USD (8,366 at 3.6725) and the tax re-derived; a EUR budget refused a 0.0001 rate and a missing rate and routed at 4.2 with `amountAed` 420,000 and the rate on the request payload; `?status=FOO` is a logged 400; the settle-plus-ceiling pair is a logged 400 on the users PUT.

**Slice 3a record (same day, evening): the module's scaffolding in the dashboard, held from push.** `src/procurement/hooks/use-procurement-api.ts` (the HR hooks' shape: every fetch through `apiFetch`, so `ApiError` carries the status the session-expiry handler reads; registered with the query-fetcher guard), `src/app/(dashboard)/procurement/layout.tsx` (the HR gate: flag off is `notFound()`, the wrong person gets a refusal that says who grants what), `/procurement` (every version of every budget with a status strip that doubles as the filter, planned, contingency, forecast, attendance and the at-risk flag; New budget offers only events that carry a code and says how many do not, and the template follows the event type), `/procurement/budgets/[budgetId]` (a read-only view of one version: the four figures, the lines with committed, actual, paid, remaining and forecast, the lifecycle dates), the sidebar entry `Budgets` gated on the flag AND `canViewProcurement`, the Settings → Users grant dialog beside the HR toggle (SUPER_ADMIN only, the four grants with the two impossible pairs greyed at the source and refused again by the PUT), and the event Settings code input disabled with a note while a budget references it. **Verified in a browser on the local standalone with the flag on:** the entry appears for the super admin, the list renders, a draft is created from the Hybrid template and lands on its page with fifteen lines, the grant dialog saves a 250,000 AED ceiling on a team member (row and audit confirmed), and the sandbox event's code field is disabled with the hint. The browser pass caught what the tests could not: JSX trims the leading space of a text node that follows an interpolation and runs to the end of the line ("Dev Adminmay"), so those sentences are single template expressions now. **Not built, on purpose, pending the owner's call on layout (the standing rule for UI structure):** the editor's controls (lines, header, submit, reallocate, freeze), the version compare page, the close-out page (variance notes per line, sign-off, reopen) and the approvals inbox, which is why the list page carries no Approvals link yet.

**Slice 3b record (Monday 14 September 2026, late evening): the four workflow pages, held from push.** The owner accepted the proposed shape ("one editor page per budget with an inline lines table, a right-hand action bar keyed on status, and a separate close-out page for the per-line variance notes; the approvals inbox as a list with approve or reject and a note per row; version compare as a side-by-side by line key with deltas") and said "lets do 3b too". Built: the **editor** (`/procurement/budgets/[budgetId]`: on a draft the lines edit inline as a form row with category, description, quantity, unit cost, currency and its rate, tax; lines are added and removed; the category chips mark not-applicable through the header write with the version lock; submit shows the completeness list from the same `missingForSubmission` the service runs and the server's 422 list after; the action bar is keyed on status: submit / edit details / discard on a draft, approve-or-reject for a ceiling holder and withdraw for the author under review, move an amount / freeze / new version / close out on active, unfreeze for an admin on frozen, sign off for the settle grant and reopen for an admin on closed; forecast overrides edit on an active or frozen version), the **compare page** (`.../compare`: two versions of the event paired by `lineKey` through the pure `version-compare.ts`, totals and per-line deltas, added / removed / changed / renamed), the **close-out page** (`.../close-out`: planned, actual and variance per line, the lines the rule flags highlighted through the pure `close-out.ts`, which calls the service's own `varianceRequiresNote` at the AED-5,000 floor converted at the one rate, so the page and the 422 agree by construction; notes save on their own or ride with the close; the closed view shows the summary, sign-off and reopen), and the **approvals inbox** (`/procurement/approvals`: waiting-on-me and my-requests, approve or reject with a note per row; a reallocation names its two lines because the inbox route now attaches the line descriptions to the move). The list page carries the Approvals link with the pending count. `StatusBadge` and the money display moved out of the list page into `src/procurement/components/budget-ui.tsx` so no page imports another page. **Verified in a browser on the local standalone with three throwaway accounts (an ORGANIZER author, an ADMIN with the unlimited ceiling, a MEMBER with the settle grant):** draft from the Hybrid template, a line edited (36,000 at 5% tax), a category marked not applicable and its blank line removed, a USD line added at 3.6725 (18,362.50), the header edited to 12%, submitted and approved from the inbox with a note, a 1,000 move within the owner's 10% applied at once (the USD line's unit cost rewritten in USD), a new version cloned and one line changed, compare v1 against v2 (2 changed, net minus 5,000), a 5,000 move above the 10% routed and approved from the inbox with both line names on the card, freeze and unfreeze with a reason, the close refused with the two lines named, notes saved and the close accepted (archive row written), reopen with a reason and a second close that did not re-ask, sign-off by the settle grant, the draft discarded; every page opened by every role. **Two defects the browser found:** the 3a line-edit hook sent PUT to a route that exports PATCH, so every inline edit was a 405 (fixed, and pinned by `hooks-route-methods.test.ts`, which maps every `send(url, method)` in the hooks to the handlers its route file exports); and the close-out actions card rendered empty for a settle holder after sign-off (a sentence now). **The help chat answers the module's questions** (owner, mid-build: "non technical people work on this... they should reach out to help chat and get all their answers"): user-guide chapter 22, Budgets & Procurement, explains the lifecycle, filling a draft, the inbox, the 10% rule, versions and compare, freeze and unfreeze, forecasts, close-out, sign-off and reopen, with a glossary table; the help chat reads the guide at start, and a live question ("what is a budget close-out, what does unfreeze mean, what are versions and compare versions, what is moving an amount between lines") came back answered from the chapter with a role note; a flag-gated starter chip offers the question to the roles that can read budgets. +25 tests (compare, close-out rows, the inbox route, the hook-to-route guard): 7,267. Not built: the decide dialog's success path was not exercised live (the only ceiling holder was the requester, refused as designed: NO_APPROVER on submit and REQUESTER_CANNOT_DECIDE at decision); it shares the primitive the inbox path used.

**Deploy and slice 3c record (Monday 14 September 2026, midday and afternoon).** The owner pushed the six held commits at 08:26 UTC; run 34822747103 passed all nine jobs and production runs 461289e7 (0.4.32) with migration `20260914100000` applied and the flag unset, verified from outside (an anonymous `/procurement` renders the not-found page inside the dashboard shell, as `/hr` does with its flag off, and the API answers 401 and logs it). The same afternoon, on the owner's asks, three additions landed on top, each built dark and verified in a browser on the local standalone: (1) the **budget activity log**, `GET /api/procurement/budgets/[budgetId]/activity` reading the AuditLog rows for the budget, its lines (by `changes.budgetId`) and its approval routing (the requested and cancelled rows only; granted and rejected duplicate the budget's own APPROVE and REJECT rows), newest first, capped at 200, each turned into a sentence by the pure describer in `src/procurement/lib/budget-activity.ts` (line keys resolve to descriptions, assignee ids to names) and rendered by a card at the foot of the budget page; (2) the **product catalogue**: `BudgetProduct` (SKU unique per organisation, name, category, active flag) and a nullable `BudgetLine.productId`, migration `20260914130000`, RLS policy, harness fixture and gate entry in the same change; seeded once per organisation from the owner's "MME - Products.csv" (203 QuickBooks-style cost items, no prices, mapped to the categories by SKU group with named exceptions, the two discount contra items seeded archived); a Products page under Budgets for admins (add, rename, re-categorise, archive, restore, never delete) and a "Catalogue item" picker on the line editor that fills the description and the category, keeps free text, and leaves the SKU on the line for the Phase 3 accounting mapping; (3) the sidebar's User Guide entry removed at the owner's request. Every failure path logs; no MCP schema changed. The VAT rule was confirmed live for the owner: a blank tax rate is zero VAT, a rate gives a tax amount recorded and shown beside the ex-VAT figure, never folded into a gross total (§7). Phase 2 planning started from a distilled brief of §6 and the spec; slice 1 waits on the owner's numbering format for `requestNo` and `commitmentNo`, which neither document fixes.

**Exit gate.** A budget goes template → lines → submit → approve → active → revised → frozen → closed on the local prod copy in a browser, with every screen the diff touched opened; tsc, lint, vitest, build and the eleven check scripts green; adversarial review before merge, findings surfaced before patching; deployed dark behind the flag.

---

## 6. Phase 2: purchasing (weeks 6 to 9)

**Tables:** `Supplier`, `SupplierProduct`, `SpendRequest`, `SpendRequestQuote`, `Commitment`, `CommitmentLine`, `PaymentRecord`, and the two counter tables.

**Files.** Services: supplier-service (proposed-supplier queue, approval by the settle grant, `awaiting_supplier`), spend-request-service (budget check against stored line figures, routing on the AED matrix, over-budget exception routing, delta re-approval on the new total), commitment-service (create on approval, PO PDF, receiving with the second-person rule above AED 50,000, cancel as close-and-release). Approvals primitive completed: bands, delegation, escalation, notifications. Routes under `src/app/api/procurement/{suppliers,requests,commitments,approvals}/*` (about 18 files). Pages: request form with the live side panel, Approvals page, commitment list, supplier master (4 pages). Agent tools: `list_spend_requests`, `create_spend_request`, `list_commitments`. Worker: `approval-escalation`.

**Tests.** Routing matrix (within budget under and over the ceiling, over budget, own request, frozen budget), the second-person receipt rule, the PDF renders on a sample commitment, escalation claims are idempotent under a retried tick, a real-Postgres test in `tests/crm-db/` for the counter under twenty concurrent creates.

**Slice 1 record (Monday 14 September 2026, evening): the tables and the supplier master, dark.** Numbering decided by the owner first: `PR-2026-0001` / `PO-2026-0001`, the year in the number (Asia/Dubai), the sequence restarting each January, one organisation-wide counter per type keyed on (organizationId, year); `src/procurement/lib/document-numbers.ts` carries the format and the upsert, with a real-Postgres case in `tests/crm-db/document-numbers.db.test.ts` (twenty concurrent creates, two sequences, two organisations, two years, a failed create rolls its number back). Migration `20260914140000` adds ten enums, the seven purchasing tables (`Supplier`, `SupplierProduct`, `SpendRequest`, `SpendRequestQuote`, `Commitment`, `CommitmentLine`, `PaymentRecord`), the two counters and a nullable `BudgetLine.supplierId`, additive and idempotent (applied twice locally; the read-only diff against the schema shows only the documented pre-existing certificate drift); nine RLS blocks, harness fixtures with a shared supplier code, request number and order number in both organisations, and the tenancy gate entries ship in the same change. Enum values the spec leaves unnamed were chosen and are easy to widen: risk NONE/WATCH/BLOCKED, sourcing SINGLE_QUOTE/COMPETITIVE_QUOTES/EXISTING_CONTRACT/SOLE_SOURCE, priority LOW/NORMAL/HIGH/URGENT, budget check NOT_CHECKED/WITHIN_BUDGET/OVER_BUDGET/FROZEN; `pending_post` from this plan's exit gate is the enum's existing `PENDING`. The supplier service owns propose (request grant, or created approved by the settle grant through a new `propose` need), decide (a conditional claim on PROPOSED, so two settle holders commit once), update under an optimistic lock, and deactivate; `canViewSupplierFinancials` (SUPER_ADMIN, ADMIN, ORGANIZER, plus the settle grant) is the §2.9 boundary, every read passes through `redactSupplier`, and the audit helper drops the two classified fields by construction (the tests assert no tax number or IBAN string appears in any audit payload). Three routes under `src/app/api/procurement/suppliers`, hooks, a Suppliers page linked from Budgets (search, status, deactivated toggle; propose, decide with a note, edit with bank details for the settle holder), and a guide paragraph. Verified in a browser on the local standalone with a request-grant MEMBER and a settle-grant MEMBER: the proposal lands in the queue with the tax number shown as "redacted" to the proposer and in clear to the settle holder, the approval records its note, the bank details save, and the database holds no classified value in any audit row. Not in this slice: the supplier picker on the budget line (the column exists), `SupplierProduct` writes, and everything from slice 2 onward. Open owner questions carried from the brief: the AED 50,000 receipt threshold's home and scope, delegation storage, the delta re-approval rule, the FX source before the connector, and whether an admin may approve a supplier when the settle holder is away (today: settle only, per §4.3). Deployed 10:32 UTC the same day (run 34832759868, prod on 2fc3c018). The two migrations had been applied to the production database at push time by the connected Vercel project, whose build command runs `prisma migrate deploy` (since 3 March), so the box's own pass found nothing pending. The owner had switched the flag on in production at about 08:50 UTC and created the first budget (HM2026) at 08:57, so from this deploy the suppliers page, the catalogue and the activity log are live for org staff.

**Exit gate.** Request to PO to receipt end to end with QuickBooks absent (the outbox is not built yet, the commitment records `pending_post`); the load baseline repeated (§1.5).

---

## 7. Phase 3: connector (weeks 10 to 12)

**Tables:** `Outbox`, `SyncLog`, `FxRate`, `AccountMapping`, `SupplierInvoice`, `SupplierInvoiceLine`.

**Files.** `src/lib/outbox/` (core), `src/procurement/integrations/quickbooks/` (`AccountingProvider` interface, `QuickBooksProvider`, OAuth token lifecycle, vendor, chart of accounts, tax code and Class pulls, PO create and close, read-back of POs, bills, vendor credits and payments since a cursor), `src/procurement/integrations/fx/` (`FxRateProvider`, the Central Bank adapter), the mapping admin and Integration Monitor pages, the unallocated-bills page with link-or-write-off. Worker: `outbox-drain` (every minute), `qbo-readback` (nightly plus an on-demand route that enqueues one run), `fx-rates` (daily). The `WORKER_JOBS` allow-list (§1.4) lands with the first of these.

**Tests.** Outbox claim under concurrency and backoff schedule (real Postgres), producer-and-state in one transaction (a failed commit leaves no outbox row), dead-letter alerts, adapter tests against recorded QuickBooks responses (fixtures, no network), read-back matching (from-PO bill matched, standalone bill unallocated, credit note reduces the line), FX applied at the bill's rate for actual and the payment's rate for paid.

**Exit gate.** A sandbox realm receives POs from the outbox; a forced adapter failure shows on the Integration Monitor and recovers when the failure is removed; a bill entered from the PO in the sandbox lands on the right line item within one read-back.

---

## 8. Phase 4: migration and pilot (weeks 13 to 16)

**Tables:** the archive tables for `EventFinancialSummary` are already present; this phase adds the import bookkeeping only.

**Files.** `scripts/import-procurementexpress.ts` (declared CSV format from Phase 0, dry-run default, `--write`, idempotent by external id, open POs linked as `linked_external` and never re-pushed), `scripts/load-event-archive.ts` (QuickBooks profit-and-loss by Class per past event plus the ProcurementExpress planned figures plus EventsAir attendance and revenue, one row per event, source tagged), both run through `docker exec ea-sys-worker npx tsx`. The pilot: one live event, flag on for the pilot group, parallel run against ProcurementExpress through one month-end close.

**Exit gate.** The close-out summary for the pilot event reconciles to QuickBooks within the AED 100 tolerance; the load run repeated with the authenticated scenario; every deferred review finding either fixed or in ROADMAP with an owner.

---

## 9. Phases 5 and 6

Phase 5 adds `BudgetRevenueLine` and the P&L fields on `EventBudget`, the registration and sponsorship revenue readers (registrations from the ticket types and pricing tiers, sponsorship from the CRM's won deals), the Event P&L and cross-event pages. Phase 6 adds the benchmark picker, the similar-event ranking, the benchmark column and the approver's delta line, all reading the foundations laid in Phase 1. Neither adds a worker job.

---

## 10. Verification, per phase and for the whole

- The standing gate before every push: the eleven check scripts derived from `deploy.yml`, `npm run lint`, `npx tsc --noEmit`, the full vitest suite, `npm run build`; watch the run after.
- The tenancy harness (`npm run test:tenancy`) from Phase 1 on, since every table is policied.
- Real-Postgres tests in `tests/crm-db/` for anything that is a race: counters, outbox claims, approval decisions.
- A browser pass on the local prod copy for every screen a phase's diff touches, not only the new ones (the Setup-hub lesson of Aug 25).
- An adversarial review (three lenses: money and concurrency, RBAC and tenancy, drift and logging) at the end of each phase, findings surfaced before patching.
- Every failure path logs; business rejections at warn, errors at error; no silent catches. The outbox dead-letter and the read-back divergence are the two places a silent failure would cost money, and both alert.
- Package version bump with each phase that changes MCP tools, lockfile with it.

---

## 11. Rollback

Each phase is one or more additive migrations and one image. Rolling the image back is the drilled 22-second path (`IMAGE_TAG=<sha> bash scripts/deploy.sh`); the schema stays ahead, which every migration here tolerates because nothing is renamed or dropped and every new column is nullable or defaulted. The flag is the softer lever: `PROCUREMENT_MODULE_ENABLED` unset hides the module entirely without a redeploy of anything but the env file, which is the owner's manual step followed by `deploy.sh`.

The one thing that cannot be rolled back by either lever is a PO already posted to QuickBooks. That is why posting goes through the outbox with an idempotency key and why Phase 3 tests against a sandbox realm first.

---

## 12. Deliberately not in v1

From the spec's Part 2: a standby for Medhat, a second independent approval, the matching-rules exception queue for unallocated bills, intraday FX, Arabic, a second QuickBooks realm, approvals for HR leave (the primitive is built for it, the consumer is not), and any automatic write of bills into QuickBooks (v1 reads them back; Muthu enters them). Recorded here so none of it is built opportunistically inside a phase.

---

## 13. Open risks

| Risk | Why it matters | Mitigation in this plan |
|---|---|---|
| QuickBooks limits (about 500 requests a minute per realm, 10 concurrent) | A nightly read-back over years of history could hit them | Cursor-based, batch-bounded, backoff on 429; the first load runs once, by hand, off-hours |
| Refresh-token expiry (100 days idle) | A quiet realm loses its connection silently | `healthCheck` daily from the FX job's tick; Integration Monitor shows days since last success; re-auth is a settle-grant button |
| `Event.code` backfill | Free strings today; uniqueness will collide on real data | Phase 0 count on prod, migration written against the real duplicates |
| Load ceiling unknown | Never measured | §1.5, three runs |
| Migration across a rollback | Undrilled | Additive only, nullable or defaulted, the flag as the softer lever |
| Worker image growth | `src/` copied wholesale | Measured at each phase's deploy; the `WORKER_JOBS` switch if a split is ever needed |
| Decimal discipline | One float in a money path and the reconciliation fails by a fil | Money math in one lib with a table of cases; `Decimal` on every column; review lens |
