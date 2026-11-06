# External audit (Nov 2026): verification and action plan

> Written Nov 5, 2026. Each of the ten findings was checked against the code at
> `0aa7b114`. A verdict here says what the code does today, with file and line
> evidence; the plan below re-ranks the work by what actually threatens the live
> master silo versus what gates the platform instance's tenant #2. Status words
> describe this document as written; check `src/` before relying on them.

## 1. Verdicts at a glance

| # | Audit priority | Finding | Verdict | Real priority | Why it moved |
|---|---|---|---|---|---|
| 1 | Blocker | Event table lacks prod RLS | Partially true | P2 (platform gate) | Master runs zero RLS by design; Event is the one deliberate, documented hole on the platform instance |
| 2 | High | Stripe refund race double-counts | True, but not where the audit points | **P0** | Live money. Webhook retries are already idempotent; the bug is the dashboard refund path's write order |
| 3 | High | Web containers have Docker socket | True | **P0** | Any RCE in the web app is one command from host root. Small fix |
| 4 | High | No tenant onboarding/offboarding | True | P2 (platform gate) | No second tenant exists yet |
| 5 | High | Distributed bot protection incomplete | True | P1 (one P0 item) | No human check anywhere; abstract-start has no IP limit |
| 6 | Medium | Worker jobs lack per-tenant fairness | Partially true | P1 | Only the email queue is unfair, and it bites today between events of one org |
| 7 | Medium | E2E suite has recorded failures | True, partly stale | P1 | Down to 6 known failures; e2e has never run in CI |
| 8 | Medium | Registration dupes lack a DB invariant | True, risk narrower | P0 guards, P1 index | Creates are serialized since Oct 29; un-cancel and email change bypass the check |
| 9 | Medium | Audit reliability varies by module | True | P0 for keys, P1 rest | ~13% of audit writes are in-transaction; API key create/delete writes none |
| 10 | Medium | Privacy and erasure incomplete | True (self-documented) | P1 Phase 0, P2 rest | Backlog recorded Sep 28, not started |

## 2. Evidence per finding

### 2.1 Stripe refund double-count (P0)

What is already correct:
- `src/lib/stripe-webhook-handler.ts:706-716`: `charge.refunded` compares Stripe's cumulative `amount_refunded` with `Payment.refundedAmount` and skips at `delta <= 0`. Redeliveries are no-ops without an event-id table.
- `:729-761`: the delta is claimed optimistically on the Payment row, and the Registration roll-up commits in the same transaction.
- Concurrent dashboard refunds lose on the `Registration.refundedAmount` lock (`payment-service.ts:391`, `LOST_LOCK`).

The bug: the two counters are written at different moments.
- `src/services/payment-service.ts:390-397` raises `Registration.refundedAmount` in the booking transaction, **before** Stripe is called.
- `:567-577` raises `Payment.refundedAmount` only **after** Stripe succeeds, outside any transaction, with `.catch(log)`, as an absolute value from a snapshot taken at `:247`.
- The webhook decides "already counted" from `Payment.refundedAmount` alone and never reads `refund.metadata.refundAttemptId`.

Failure scenarios:
1. **Race.** Admin refunds 100 of 500. `charge.refunded` arrives before line 567 commits, so the webhook sees Payment at 0 and books delta 100 again. End state: Registration 200, Payment 100, Stripe 100, plus a second credit note and a false "issued from the Stripe Dashboard" notification.
2. **Certain double-count.** The line-568 update fails (only logged), or the process dies after Stripe succeeds. The next webhook books the refund again. The reconciliation sweep's `found` branch (`refund-reconciliation.ts:140-148`) marks the attempt SUCCEEDED but does not repair the Payment counter.
3. An inflated total can flip a partial refund to `REFUNDED` (`isFull`, `:757`), and revenue, exports and refund caps then read the wrong number.
4. A Stripe Dashboard refund that lands while a dashboard refund is in flight is overwritten by the route's absolute write, then counted again on the next event.
5. Asynchronous refund failures (`charge.refund.updated` with status `failed`) are not handled.

### 2.2 Docker socket in web containers (P0)

- `docker-compose.prod.yml:67` and `:121` mount `/var/run/docker.sock:ro` into both web slots. The comment at `:59-66` already says that `:ro` does not restrict the API.
- `Dockerfile:58` installs `docker-ce-cli`. `:82` adds `nextjs` to the docker group.
- The only consumer is `src/app/api/logs/route.ts`, which uses `docker inspect`, `docker ps` and `docker logs` for the `/logs` viewer's "Docker" source. That route is operator-only (`denyNonOperator`) and uses `execFile` against allow-lists, so the route itself is safe.
- The risk is any remote code execution elsewhere in the app or its dependencies. A single `docker run --privileged -v /:/host` then gives host root, every container's environment (`DATABASE_URL`, `NEXTAUTH_SECRET`), and the instance role.
- Nothing else depends on the socket: health checks use curl, and `deploy.sh` runs on the host.
- Side bug: the route labels are swapped (DELETE logs `logs:GET` at `:278`, GET logs `logs:DELETE` at `:319`).

### 2.3 Bot protection on public forms (P1, abstract-start is P0)

- `src/lib/security.ts:17-102`: `checkRateLimit` is an in-memory `Map` and **synchronous**. It resets on every deploy, and every push to main is a deploy. nginx sends traffic to one slot at a time, so "two containers, two counters" is not the real issue.
- There is no CAPTCHA, Turnstile, honeypot or minimum fill time anywhere in `src`.
- nginx has one global zone (100 r/s per IP). fail2ban bans only after 100 nginx 429s. There is no CDN or WAF (`docs/AWS_OPERATIONS.md:909-916`).
- Every control is keyed per IP or per email. Nothing caps per event or globally, so 1,000 IPs can squat seats, create junk accounts and use the confirmation email to bomb third-party addresses, which burns the SES quota and sender reputation.
- Gaps:
  - `src/app/api/public/events/[slug]/abstract-start/route.ts:140` limits per email only, on a route that checks passwords and creates accounts. One IP can password-spray across many emails.
  - `auth/mobile-login` has only the failure-based, in-memory login throttle.

### 2.4 Registration duplicates (P0 guards, P1 index)

- Email lives on `Attendee`, and its unique constraint was dropped in migration `20260330300000`. `Registration` has no email-keyed unique.
- `lockRegistrationEmails()` (`src/lib/registration-email-lock.ts`) takes an advisory lock and re-checks, and it guards all 8 `tx.registration.create` sites. Two concurrent registrations with the same email do not both succeed.
- Two paths bypass that check:
  1. **Un-cancel.** CANCELLED to CONFIRMED in `registration-service.ts:1577-1600` → `applyRegistrationTransition` checks seats only. If the person has re-registered since, this produces two live registrations, two badges and two seats.
  2. **Email change.** `PATCH .../registrations/[id]/email` checks User and Speaker collisions only.
- A plain unique cannot work. The key spans two tables and must exclude CANCELLED rows, so it needs a partial unique index, which Prisma cannot declare (the same situation as the `CertificateIssueRunItem` partial indexes).

### 2.5 Audit reliability (P0 for API keys, P1 for the rest)

- About 247 direct `auditLog.create` sites:
  - about 32 run inside the mutation's transaction (procurement, HR, users invite/accept, password reset);
  - about 165 are fire-and-forget;
  - about 49 are awaited after commit, 22 of them with the error swallowed.
- Procurement is the model to follow: `spend-request-service.ts:192-204` writes `audit(tx, ...)` and rethrows on failure.
- Fire-and-forget on critical paths:
  - every money movement in `payment-service.ts` (lines 122, 624, 847, 1153);
  - invoice cancel (`invoice-service.ts:1826`);
  - out-of-band Stripe refunds (`stripe-webhook-handler.ts:787`);
  - event delete (`events/[eventId]/route.ts:1104-1122`), which deletes first and has no `eventId` on the row;
  - permission-set changes (`permission-set-service.ts:927-950`);
  - every credentials save.
- **No audit row at all:**
  - API key create and delete (`organization/api-keys/route.ts:136` writes only a pino line; I checked this one myself);
  - OAuth client tier PATCH;
  - invoice create;
  - Stripe payment capture.
- CRM uses `CrmActivity` with an owner-accepted "lost line is acceptable" ruling (`src/crm/lib/crm-activity.ts:14-25`).
- No CI gate checks audit writes.

### 2.6 Worker fairness (P1)

- Scheduled emails: `src/lib/scheduled-emails-worker.ts:411-414` takes 10 due rows in `scheduledFor` order, and each runs its whole audience (`bulk-email.ts:2485-2514`, batches of 25) inside one leased tick.
  - A 20k blast holds the lease for tens of minutes.
  - A webinar "starts in 1 hour" reminder that comes due meanwhile waits behind it. Nothing is lost, but it can arrive late.
- No SES rate limiter: up to 250 calls can be in flight at once, while the certificate code assumes a 14/s cap (`certificates/issue-worker.ts:62-64`).
- Certificates (50 renders and 25 emails per run per tick) and DTCM (an even time budget across runs) already share work between runs.
- Per-organisation round-robin matters only once the platform instance launches.

### 2.7 E2E suite (P1)

- e2e is not in `deploy.yml` at all.
- `playwright.config.ts` defaults to port 3000 while dev binds 3113.
- Commit `10a659c7` (Oct 30) cut failures from 23 to 6. The 6 left are certificate specs that still assert the deleted `denyReviewer` contract. No baseline has been recorded since.
- No skipped or fixme specs.
- Critical journeys with **no coverage**: paid registration through Stripe checkout, desk check-in and badge, abstract submission, the bulk-email worker send, and a certificate issue run.

### 2.8 Event RLS (P2, platform gate)

- Master has no RLS objects by design. `scripts/bootstrap-rls.ts:59-139` refuses master, and `RLS_SET_LOCAL` is unset there.
- `prisma/rls/` covers 132 tables. Event is the deliberate exception in `__tests__/lib/rls-coverage.test.ts:57`: there are 343 call sites in 201 files, and turning it on unswept would close off the whole dashboard.
- Child tables carry their own `organizationId` and are policied independently, so registrations and speakers stay isolated even without an Event policy.
- Also unbacked: six tables keyed only by `eventId` (EmailTemplate, EventBillingAccount, EventStats, ImportLog, InvoiceCounter, Notification). InvoiceCounter matters most.

### 2.9 Tenant lifecycle (P2, platform gate)

- What exists:
  - `TenantDomain` and the host resolver;
  - `scripts/add-tenant-domain.ts`;
  - seed scripts;
  - per-org Stripe, Zoom and AI credentials;
  - the `dbOperator` privileged lane.
- What is missing:
  - any way to create a tenant (`docs/PLATFORM_PROVISIONING.md:189-192`, ":388 Nothing exists");
  - `Organization.status`, so there is no suspend;
  - per-org export or archive;
  - per-org S3 cleanup;
  - per-tenant SES;
  - the NULL-org purge job.
- Deleting an Organization today cascades through 35 relations with no archive. It must stay unreachable until offboarding exists.

### 2.10 Privacy and erasure (P1 Phase 0, P2 rest)

- `docs/ROADMAP.md:334` records the backlog: "recorded, not started". There is no `/privacy` page, and only the reimbursement page links a privacy policy.
- Missing pieces:
  - per-person subject access export;
  - account deletion for REGISTRANT and SUBMITTER users;
  - erasure that keeps tax invoices.
- What is kept indefinitely:
  - the audit snapshot keeps the full deleted registration with no prune job (`registrations/[registrationId]/route.ts:695`);
  - dietary data (a special category) is never cleared;
  - no retention rule for registrations, speakers, contacts or uploaded documents;
  - the DR uploads mirror never deletes.
- Data sent to external services has no DPAs or transfer agreements recorded. Mailchimp is fed with everyone marked subscribed (`project_mailchimp_n8n_from_central`).

## 3. Action plan

Effort: S is under a day, M is 1 to 3 days, L is a week or more. Every code change
goes through the full gate (lint, tsc, unit, e2e on standalone :3199) and the
commit-then-adversarial-review rule. AWS and Docker steps are handed to the owner, never run by us.

### Wave 0: this week (live-system risk, small changes)

| ID | Action | Effort | Owner step |
|---|---|---|---|
| W0-1 | **Refund write order.** In the booking tx (`payment-service.ts:390`), `increment` each Stripe slice's `Payment.refundedAmount` beside the Registration counter; delete the post-Stripe absolute write at `:567-577`; make `abortRemainder` and the sweep rollback (`refund-reconciliation.ts:155`) decrement both. Test: "webhook arrives between Stripe success and counter write", "counter write fails", "process dies after Stripe". **Done Nov 6** (not yet deployed): booking raises both counters in one transaction, optimistic on each payment's read value (a counter moved by a Dashboard refund aborts with LOST_LOCK instead of being overwritten); the post-Stripe writes are gone; the inline rollback and the sweep bring both down together or not at all. Pinned by unit tests (mutation-checked) and `tests/integration-db/refund-counters.db.test.ts` on real Postgres. **Follow-up Nov 6** (review of `acc31bff`, 0 BLOCKER / 0 HIGH / 2 MED / 3 LOW, all fixed): every rollback now goes through `src/services/refund-unbook.ts`, which sets a Stripe payment's counter from Stripe's own refunded figure plus our in-flight attempts, so a Dashboard refund that landed while ours was booked (and that its webhook skipped) is kept, credited and notified instead of erased (MED-1); a rollback that cannot apply leaves every remaining attempt UNKNOWN for the sweep, and the sweep rolls back manual UNKNOWN attempts (MED-2); one attempt per payment plus one for residue; `RefundAttempt.paymentBooked` (additive migration `20261106150000`) so attempts written by the previous image are never un-booked twice (LOW-1); a failed or canceled Stripe refund no longer counts as found. Simulated on real Postgres with the real service, sweep and webhook handler (`refund-counters.db.test.ts`, 11 scenarios, each ending with the books equal to Stripe's ledger) and against Stripe test mode (`refund-stripe-testmode.db.test.ts`, opt-in). Known and accepted: the found refund's credit note is refused when the notes for the failed refund already fill the paid total (the webhook's same cap); the organisers are notified to settle it. | M | None |
| W0-2 | **Refund repair query (read-only)** on prod: registrations where `Registration.refundedAmount` exceeds the sum of `Payment.refundedAmount` plus manual RefundAttempts, and attempts with more than one credit note. Fix any rows by captured id. **Done Nov 6**: [scripts/sql/refund-reconcile-check.sql](../scripts/sql/refund-reconcile-check.sql). Prod has **no double-count** (no registration above its payments plus manual refunds, no payment refunded past its charge, nothing in flight). Two July rows predate the RefundAttempt table: `cmr32zhyh000tlr01qk8l1luf` (hemnet2026, REFUNDED, Payment counter 2.50, Registration counter 0) and `cmr976syj0008sa01k7991zcz` (gcc-hh26, a 65.00 credit note with no refund, still PAID). Neither is this bug; the first one's Registration counter is the owner's call to correct. | S | Run `npm run prod:psql`; approve each fix |
| W0-3 | **Remove the Docker socket.** Drop both mounts, `docker-ce-cli` and the docker group from the image; delete the `docker` log source; fix the swapped route labels. Collect container stdout on the host with the CloudWatch agent (`/var/lib/docker/containers/*/*-json.log`, new `ea-sys/docker` group). | S | Re-apply CloudWatch agent config; deploy recreates both slots |
| W0-4 | **abstract-start IP limit** plus route its failures through `login-throttle`. Add `checkRateLimit` to `auth/mobile-login`. | S | None |
| W0-5 | **Dup-reg guards** on un-cancel and email change: `lockRegistrationEmails` + active-duplicate check, 409 `ALREADY_REGISTERED`, logged. | S | None |
| W0-6 | **Audit rows for API key create/delete and OAuth client tier change**, written in a transaction with the mutation. | S | None |

### Wave 1: next 2 to 4 weeks (hardening)

| ID | Action | Effort | Depends on |
|---|---|---|---|
| W1-1 | **Refund ledger keyed by Stripe refund id.** Webhook lists the charge's refunds and books only unknown ids (`RefundAttempt.stripeRefundId` unique). Handle `charge.refund.updated` failed; add the event to the webhook setup text. Optional `StripeWebhookEvent(id)` table as hygiene. | M | W0-1 |
| W1-2 | **E2E re-baseline and CI.** Set config default port 3113; run on :3199; record the baseline; fix the 6 certificate specs against `requirePermission`. Then add `@critical` specs (paid checkout with Stripe test mode, desk check-in and undo, abstract submit, bulk email to EmailLog with SES stubbed, certificate run) and a non-gating `e2e-critical` CI job; make it gating after 5 greens. Assert the test DB host in `global-setup.ts`. | S then M | Before W1-4 and W1-5 land |
| W1-3 | **Audit helper and gate.** `src/lib/audit.ts` `writeAudit(tx, entry)` that rethrows, plus `recordAuditBestEffort()`. Define `CRITICAL_AUDIT_ACTIONS`; move payment-service, invoice-service, event delete (audit before delete, same tx), users and permission sets, credentials onto it. Add `scripts/check-audit-writes.sh` with a shrinking allow-list and an atomicity test per critical action (HR pattern). Add the missing invoice-create and payment-capture rows. | M | W0-1 (same file) |
| W1-4 | **Bot protection.** Shared `requireHuman(req)`: Cloudflare Turnstile `siteverify` + honeypot + minimum fill time on register, group-register, submitter, abstract-start, complete-registration, survey, rsvp, speaker-form, public forgot-password. Exempt kiosk and desk-tablet flows. CSP update. | M | W1-2 (register path is live payments) |
| W1-5 | **Shared limiter for the public tier only.** Async `checkRateLimitShared()` on Postgres (`RateLimitBucket`, `INSERT ... ON CONFLICT ... RETURNING count`, worker prune). Add per-event and global ceilings on registrations. Leave the 225 authenticated routes on the in-memory limiter. | M | Additive migration |
| W1-6 | **nginx per-path zone** for public POSTs so fail2ban sees form abuse; tune for venue NAT crowds before conferences. | S | Edit on box, `npm run nginx:drift`, copy in |
| W1-7 | **Email queue slicing.** Cap work per row per tick (N batches or ~40 s), resume from `emailedKeys` next tick; order due rows by priority (webinar sequence first) then round-robin by event; queue-lag metric on `tick-complete`. Kill-mid-slice test. | S to M | None |
| W1-8 | **SES token bucket** in the bulk stream at ~80% of the account's MaxSendRate; reduce the 10 x 25 fan-out to match. | S | Owner confirms MaxSendRate |
| W1-9 | **Privacy Phase 0 (documents).** Privacy policy and `/privacy` route, footer link on every public form, reworded default terms, vendor DPAs and transfer clauses, written subject-request (30-day) and breach procedures. | S (ours) | Owner and legal write the text |

### Wave 2: before the platform instance takes tenant #2

| ID | Action | Effort | Depends on |
|---|---|---|---|
| W2-1 | **Registration partial unique index.** Run the duplicate query first; clean up by captured id. Then add `Registration.emailKey` (nullable, trigger-maintained from Attendee), backfill, `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ... ("eventId","emailKey") WHERE status <> 'CANCELLED'` in a non-transactional, hand-authored migration; check `indisvalid`; map P2002 to `ALREADY_REGISTERED`; per-row handling in bulk imports. | M to L | W0-5; zero prod duplicates |
| W2-2 | **Event RLS sweep.** Broken down in section 3.1 below. Preparation steps 1, 3 and 4 shipped Nov 5, 2026. | M (was L) | None |
| W2-3 | **Org column on the six eventId-only tables**, InvoiceCounter first, additive backfill, then policies. | M | W2-2 |
| W2-4 | **Tenant lifecycle.** `Organization.status` (ACTIVE/SUSPENDED/OFFBOARDED); operator console `/admin/tenants` (create org, first admin, domain with DNS verification, audited); onboarding checklist gated on an SES test send; suspend in the resolver, auth and worker; NULL-org purge job. | M to L | W1-3 (audit), owner SES-per-tenant decision |
| W2-5 | **Offboarding.** Per-org archive to S3 with a lifecycle rule, reviewed per-table removal, per-org S3 key deletion. Org delete stays unreachable until this ships. | L | W2-3 |
| W2-6 | **Per-org fairness** in the email and certificate workers: round-robin by `organizationId`, per-org in-flight caps and SES shares; remove the certificate `take: 20` ceiling. | M | W1-7, W1-8 |

### 3.1 Event RLS (W2-2), broken down

**Why it is not one big sweep.** Event is how many requests find their tenant, the same job `TenantDomain` does for a host. The blocker is a single shape: read the Event outside any lane, then `runWithTenant(event.organizationId, ...)`. Under a policy that first read returns null, so the route answers 404 with nothing logged. Measured on Nov 5, 2026: 126 such wraps in 85 files, plus 61 files that read Event and never enter a lane (many of them libraries that inherit their caller's lane, which is fine). The other ~217 files that touch Event already run inside a lane.

| Step | What | Status |
|---|---|---|
| 1 | One sanctioned pre-lane read: `resolveEventTenant(where)` and `resolvePublicEventOrg(req, slug)` in `src/lib/tenant/event-tenant.ts`, returning only `{ id, organizationId }`. Replaced four byte-identical copies (reimbursement, travel grant, speaker profile form, RSVP). It reads through `db` today; switching it to `dbOperator` is one line, made in the same change that promotes the policy. | **Done** Nov 5 |
| 2 | Staff routes enter the session's lane first (`runWithTenantLane(session.user.organizationId, ...)`), then read the event inside it. Org-null roles (reviewer, submitter, registrant) and public routes use step 1. Do it opportunistically when a route is touched anyway, then finish what remains in one push before the platform launch. | Open |
| 3 | Shadow detector: `RLS_SHADOW=1` makes the tenant query extension log `tenant:event-query-no-lane` once per operation per route, naming the route from Next's request store (the caller's stack is lost across Prisma's promise hop, so a stack trace cannot). Off by default, never throws, sanctioned discovery reads excluded. | **Done** Nov 5 |
| 4 | Ratchet: `__tests__/lib/event-lane-ratchet.test.ts` pins both counts exactly. Adding a wrap or an unlaned file fails with what to do instead; removing one fails with the new number to write down. | **Done** Nov 5 |
| 5 | Organisation column on the six event-only tables (W2-3). | Open |
| 6 | Switch on: move `discovery` to `dbOperator`, promote `tests/tenancy/policies/10-event-rls.sql` into `prisma/rls/`, remove Event from `DELIBERATELY_UNPOLICIED`, rehearse in the sandbox with `RLS_SHADOW=1`. | Open |

**First shadow inventory (local production build, Nov 5).** A public, dashboard and API pass reported 26 surfaces, all matching the static count: the public event page, register page, catalogue, sitemap and llms.txt; `/dashboard`, `/events`, the event overview and setup pages; and 12 per-event API routes (event detail, abstracts, analytics, email templates, import logs, onsite staff, sessions, speakers, sponsors, surveys, tags, zoom settings). Registrations and tickets did not appear: their handlers already enter the lane first. A second pass in a real browser added five the curl pass never reached: the server-rendered token pages (`/e/[slug]/rsvp/[token]`, `/reimbursement/[token]`, `/travel-grant/[token]`, `/speaker-form/[token]`; separate from their API routes, which step 1 already moved onto the shared discovery), `/e/[slug]/login`, `/api/public/track` (visitor analytics) and `/api/events/[eventId]/activity`. All five belong to step 2. **Next:** set `RLS_SHADOW=1` on production for a week to see the paths a local pass does not reach (worker jobs log with `route: null` and a call site).

### Wave 3: privacy build (after the owner sets retention periods)

| ID | Action | Effort |
|---|---|---|
| W3-1 | **Subject access export.** Operator "find person by email" page assembling User, Registration/Attendee, Speaker, Contact, CRM contact, RSVP, surveys, certificates, EmailLog, AuditLog mentions and file keys into a ZIP; the export is audited. | M |
| W3-2 | **Erasure service** `eraseSubject(email, { dryRun })`: anonymise rather than delete, keep invoices for the UAE VAT period with a legal-hold reason, files through `deletePhotoIfUnreferenced`, scrub personal keys in `AuditLog.changes` (keep action rows), push a delete to the central copy, write an `ERASURE` row with a hashed email. Dry run first. | L |
| W3-3 | **Retention jobs** in the `*-prune` pattern: event-end anonymisation, dietary cleared after the event, audit snapshot scrub after N years, S3 lifecycle on DR uploads and log archive. | M |
| W3-4 | **Hygiene.** Logger redaction of email, phone, body and IP; nginx log format without query strings; versioned terms acceptance. | S |

## 4. Decisions needed from the owner

1. **Refund fix scope.** Ship W0-1 alone first, or together with W1-1 (the ledger)? Recommendation: W0-1 alone, then W1-1. A smaller diff on money code is easier to review.
2. **Docker logs.** Is losing the `/logs` "Docker" source acceptable (use CloudWatch and `docker logs` over SSM), or should the viewer get a CloudWatch-backed source (M)? Recommendation: drop it now and add CloudWatch later if it is missed.
3. **Turnstile** puts a Cloudflare script on public forms, without moving DNS. Acceptable? A standing Cloudflare proxy in front of the site is a separate, larger infrastructure decision.
4. **Audit atomicity trade-off.** Moving critical audits into the transaction means a failed audit write fails the user's action. Recommendation: yes for the critical list, best-effort for everything else.
5. **CRM's accepted-loss ruling.** Keep `CrmActivity` as it is, but also write deal close and value changes to `AuditLog` in the transaction?
6. **Retention periods and the privacy text.** Owner and legal. W3 waits on these.
7. **Per-tenant SES** (one AWS account per tenant, already decided) is the owner's AWS work and gates W2-4.

## 5. Not doing, and why

- **A webhook event-id table as "the" refund fix.** Redelivery is already idempotent. The double-count comes from the dashboard refund's write order, and a dedupe table does not touch it.
- **Making all 225 rate-limited routes shared.** Authenticated routes do not face distributed abuse, and an async limiter would change every call site.
- **RLS on master.** It is single-org by design and the bootstrap script refuses it. The platform instance is where RLS matters.
- **Docker socket proxy.** `CONTAINERS=1` still serves `GET /containers/{id}/json`, which includes every container's env. That trades host root for secret disclosure. Removal is cleaner.
