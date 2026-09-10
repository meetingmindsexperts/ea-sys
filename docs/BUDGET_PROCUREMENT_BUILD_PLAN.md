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

**Exit gate.** A budget goes template → lines → submit → approve → active → revised → frozen → closed on the local prod copy in a browser, with every screen the diff touched opened; tsc, lint, vitest, build and the eleven check scripts green; adversarial review before merge, findings surfaced before patching; deployed dark behind the flag.

---

## 6. Phase 2: purchasing (weeks 6 to 9)

**Tables:** `Supplier`, `SupplierProduct`, `SpendRequest`, `SpendRequestQuote`, `Commitment`, `CommitmentLine`, `PaymentRecord`, and the two counter tables.

**Files.** Services: supplier-service (proposed-supplier queue, approval by the settle grant, `awaiting_supplier`), spend-request-service (budget check against stored line figures, routing on the AED matrix, over-budget exception routing, delta re-approval on the new total), commitment-service (create on approval, PO PDF, receiving with the second-person rule above AED 50,000, cancel as close-and-release). Approvals primitive completed: bands, delegation, escalation, notifications. Routes under `src/app/api/procurement/{suppliers,requests,commitments,approvals}/*` (about 18 files). Pages: request form with the live side panel, Approvals page, commitment list, supplier master (4 pages). Agent tools: `list_spend_requests`, `create_spend_request`, `list_commitments`. Worker: `approval-escalation`.

**Tests.** Routing matrix (within budget under and over the ceiling, over budget, own request, frozen budget), the second-person receipt rule, the PDF renders on a sample commitment, escalation claims are idempotent under a retried tick, a real-Postgres test in `tests/crm-db/` for the counter under twenty concurrent creates.

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
