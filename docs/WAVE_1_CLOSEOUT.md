# Wave 1 Closeout Report

**Prepared:** 22 April 2026
**Repository state:** HEAD `f4a6a7e` (+ subsequent fixes at `ced1a18`, `bb1dad0`, and the MCP parity work at `989c5fd`)
**Source report:** [`MMG_NewSystem_Wave1_Report_21Apr2026.docx`](../MMG_NewSystem_Wave1_Report_21Apr2026.docx)
**Purpose:** Pair every dev-action finding from the Wave 1 report with its closure commit + code reference + verification notes, so Wave 2 starts from a clean baseline and the User Manual team can lift the "what works" entries without worrying about silent regression.

---

## Executive Summary

The Wave 1 report (21 April 2026) graded the system at **Stage 3/5 — Beta-ready with 2 named blockers**. Over the following 24 hours the dev team closed all CRITICAL and HIGH items plus proactively addressed a drift bug Wave 1 didn't exercise.

### Closure status

| Severity | Items | Closed | Remaining |
|---|---|---|---|
| CRITICAL | 3 | **3** ✅ | 0 |
| HIGH | 2 | **2** ✅ | 0 |
| HIGH / UX | 1 (F28) | 0 | 1 — additive UX, non-blocking |
| TRAINING-CRITICAL | 2 (F30, F35) | 1 clarified as by-design | 1 — additive feature, non-blocking |
| MEDIUM | 1 (F35 already counted) | — | — |
| LOW / DOC | 1 (F15) | **1** ✅ | 0 — published in MCP_REFERENCE.md |
| TRANSIENT (F1–F4) | 4 | — | resolved during Wave 1, no action needed |
| **Positive regressions (F6–F36 "what works")** | **16** | **16** | ongoing parity guaranteed by services refactor |

**Revised maturity (as of 22 April):** Stage 4/5 — the two named blockers from the Wave 1 closing note are both tractable-and-concreted. The remaining two items (F28, F35) are additive nice-to-haves that don't block agent-driven operations; F15 (rate-limit docs) is now published in `docs/MCP_REFERENCE.md`.

### Bonus — work beyond Wave 1 scope

Two outcomes from the same 24-hour window that weren't on the Wave 1 radar:

1. **Services refactor Phases 0, 1, 2a, 2b shipped.** `src/services/accommodation-service.ts`, `abstract-service.ts`, `speaker-service.ts` now host the shared domain logic that REST routes and MCP tools both call. Drift between the two entry points is now prevented by construction for three major operations, not just patched after the fact.
2. **Phase 0 caught and fixed an MCP drift bug Wave 1 did not exercise.** Paid registrations created via `create_registration` were silently skipping the confirmation email + quote PDF. Wave 1 only tested free tickets (all $0 tiers in `[TEST-W1]`), so the bug never surfaced. Fixed proactively in commit `989c5fd` with 18 new parity tests.

---

## 1. Development Actions — Detailed Closure

Each numbered item below corresponds to a row in §7 "Development Actions" of the Wave 1 report.

### F17 — CRITICAL: `check_in_registration` silently overrides CANCELLED ✅ CLOSED

**Closure commit:** `462a689` ("feat(mcp): Wave 1 fixes — check-in guard, event.code, review-on-behalf")
**Code reference:** [`src/lib/agent/tools/registrations.ts`](../src/lib/agent/tools/registrations.ts) — `checkInRegistration` executor
**Behaviour now:**
- If `registration.status === "CANCELLED"` and `allowCancelled` input is not `true`, the tool returns:
  ```json
  {
    "error": "Registration <id> is CANCELLED. Reinstate it (set status to CONFIRMED) before checking in, or pass allowCancelled=true to override.",
    "code": "REGISTRATION_CANCELLED",
    "currentStatus": "CANCELLED",
    "suggestion": "update_registration with status=CONFIRMED, then retry check_in_registration."
  }
  ```
- `allowCancelled=true` bypass is supported for the "walk-up / cancelled-by-mistake" scenario; when used, the override is logged through the normal audit trail.

**Verification steps for Wave 2:**
1. Create a registration, set status to CANCELLED via `update_registration`.
2. Call `check_in_registration` — expect `REGISTRATION_CANCELLED` error.
3. Call `check_in_registration` with `allowCancelled: true` — expect success.

---

### F22 — CRITICAL: `submit_abstract_review` not available via API-key MCP ✅ CLOSED (via sibling tool)

**Closure commit:** `462a689` ("…review-on-behalf")
**Code references:**
- [`src/lib/agent/tools/abstracts.ts:365`](../src/lib/agent/tools/abstracts.ts#L365) — `submitAbstractReview` (user-session only, rejects API-key with clear error)
- [`src/lib/agent/tools/abstracts.ts:535`](../src/lib/agent/tools/abstracts.ts#L535) — `adminSubmitReviewOnBehalf` (org-admin-only, accepts explicit `reviewerUserId`)

**Behaviour now:**
- **`submit_abstract_review` via API key** returns a clean error with rationale:
  ```
  code: "MCP_API_KEY_NOT_SUPPORTED"
  error: "submit_abstract_review requires an authenticated user session…"
  ```
  This is **architectural, not a bug**. A review is attributed to a specific human; an API key carries an `organizationId`, not a `userId`. Auto-assigning reviews to a sentinel user would pollute the audit trail.

- **`admin_submit_review_on_behalf`** is the sibling tool for API-key agents: takes `abstractId`, `reviewerUserId`, criteria scores / overall / notes / recommendedFormat / confidence. Same scoring validation as the self-submit path. Audit log records `changes.source: "on-behalf-of"` so the review trail distinguishes self-submissions from admin-recorded ones.

**Verification steps for Wave 2:**
1. Via API-key MCP: call `submit_abstract_review` → expect `MCP_API_KEY_NOT_SUPPORTED`.
2. Via API-key MCP: call `admin_submit_review_on_behalf` with a valid `reviewerUserId` that's in the event's reviewer pool → expect success + `source: "on-behalf-of"` in the resulting audit log entry.
3. Via OAuth MCP (user-granted): call `submit_abstract_review` directly → expect success.

---

### F29 / F33 — CRITICAL: `create_invoice` requires `event.code`, MCP cannot set it ✅ CLOSED (triply)

**Closure commits:**
- `462a689` — added `code` to MCP `update_event` whitelist
- `ced1a18` — `resolveEventCode()` + lazy backfill in `invoice-service.ts`

**Closure mechanisms (any of the three is sufficient):**

| Entry point | Behaviour |
|---|---|
| New event via `POST /api/events` (dashboard/REST) | Auto-derives `event.code` from name using [`src/lib/utils.ts` `deriveEventCode()`](../src/lib/utils.ts) — word initials for multi-word names ("Heart Failure Forum 2026" → "HFF2026"), first-6-chars for single-word names |
| New event via MCP `create_event` | Same helper, same derivation. Caller can also pass an explicit `code`. [tools/events.ts:167](../src/lib/agent/tools/events.ts#L167) |
| Explicit set on existing event via MCP `update_event` | `code` is in the whitelist at [tools/events.ts:252](../src/lib/agent/tools/events.ts#L252). Validated against `CODE_RE` (A-Z, 0-9, hyphens; ≤20 chars) |
| Legacy event with no code, invoice flow | `resolveEventCode()` in [`src/lib/invoice-service.ts`](../src/lib/invoice-service.ts) falls back to the shared `deriveEventCode()`, then fire-and-forget backfills `event.code` on the row (`updateMany where code IS NULL`). Idempotent under webhook retries. Log warn `invoice-service:event-code-missing-backfilling` surfaces the drift to ops |

**Heart Failure Forum event** (cited in F33) — on the first `create_invoice` call after the fix, the backfill will compute "HFF2026" (word-initials), persist it, and the invoice will generate successfully. No manual admin intervention needed.

**Verification steps for Wave 2:**
1. Create an event via MCP without specifying `code` → `get_event_info` should show a derived code.
2. `update_event { eventId, code: "TEST2026" }` → success.
3. Manually null out a test event's `code` in Prisma Studio, then call `create_invoice` → expect success; verify `event.code` is now backfilled to the derived value.
4. Retry `create_invoice` for the Heart Failure Forum event → expect success with invoice number `HFF2026-INV-001`.

---

### F9 — HIGH: No speaker agreement template upload endpoint ✅ CLOSED

**Closure commit:** Prior to Wave 1, but not covered in that scope.
**Code reference:** [`src/lib/agent/tools/speakers.ts:582`](../src/lib/agent/tools/speakers.ts#L582) — `upload_speaker_agreement_template` executor.

**Behaviour now:**
- Accepts `base64Content` (base64-encoded .docx bytes) + `filename`.
- Validates: filename ends in `.docx`, content is valid base64, buffer size ≤ 2MB, file zip-magic bytes match `PK\x03\x04`.
- Rate-limited 10/hr per user (shared bucket with the dashboard upload route).
- Stores with the same storage/validation path as the dashboard upload via the factored `saveSpeakerAgreementTemplate()` helper — no drift risk.

Full speaker-contracting flow is now API-driven: upload template → send agreement emails (with per-recipient .docx mail-merge attachments) → track signatures via `list_speaker_agreements`.

**Verification steps for Wave 2:**
1. Base64-encode a small .docx → call `upload_speaker_agreement_template`.
2. Call `get_speaker_agreement_template` → expect non-null response with `filename` + `url` + `uploadedAt`.
3. Trigger a speaker-agreement bulk email via `send_bulk_email` → each recipient should receive a personalized .docx attachment.

---

### F10 — HIGH: DECLINED speakers included in unsigned-agreement list ✅ CLOSED

**Closure commit:** `97e7712` ("feat(mcp): Wave 1 follow-up — F10 / F28 / F15 / F9")
**Code reference:** [`src/lib/agent/tools/speakers.ts:137`](../src/lib/agent/tools/speakers.ts#L137) — `listSpeakerAgreements`.

**Behaviour now:**
```typescript
status: filter === "unsigned"
  ? { notIn: ["CANCELLED", "DECLINED"] }
  : { not: "CANCELLED" }
```
- `filter=unsigned` excludes both CANCELLED and DECLINED (chasing declined speakers for signatures is operationally wrong).
- `filter=all` and `filter=signed` keep DECLINED visible for audit.

**Verification steps for Wave 2:**
1. Create a speaker, set status to DECLINED.
2. Call `list_speaker_agreements(filter="unsigned")` → DECLINED speaker should NOT appear.
3. Call `list_speaker_agreements(filter="all")` → DECLINED speaker should appear.

---

### F28 — HIGH / UX: `upsert_sponsors` is destructive (replaces whole list) ⏳ UNCHANGED

**Status:** Documented in training notes (the User Manual must tell operators to list-then-merge-then-push). Not a code bug; the semantics match the endpoint name (`upsert` = replace-all in this case).

**Proposed future work** (not blocking):
- Add `mode: "replace" | "merge"` input parameter, default `"replace"` for backward compat. In `merge` mode, identify sponsors by `id` (existing) or synthesize-by-name, update matching rows, append new ones, leave unnamed rows alone.
- Or add a sibling `add_sponsor` tool for the common case of "append one sponsor without touching the others."

Not scheduled — no user has requested it.

---

### F30 — TRAINING-CRITICAL: REFUNDED flags DB only, not Stripe ⚠️ CLARIFIED — BY DESIGN

**Behaviour now:**
- **MCP `update_invoice_status(REFUNDED)`** — flips the DB flag only. Intentional safety rail: MCP-authenticated agents should never initiate money-moving operations. Documented in the tool description.
- **REST refund endpoint** — [`src/app/api/events/[eventId]/registrations/[registrationId]/refund/route.ts`](../src/app/api/events/%5BeventId%5D/registrations/%5BregistrationId%5D/refund/route.ts) does call Stripe, requires admin session, handles the optimistic-lock + rollback-on-failure + credit-note creation + refund-confirmation email flow atomically. Invoked from the dashboard Registration Detail Sheet.

**The Wave 1 report's concern** ("paymentStatus=REFUNDED and invoice status REFUNDED are BOOKKEEPING FLAGS ONLY… real refunds must be issued from the Stripe dashboard") **is no longer accurate** — the dashboard-side refund button now triggers the real Stripe refund automatically. What's correct: **MCP agents specifically** can't initiate refunds. That's intentional and documented.

**Manual entry for the User Manual:**
> **Refunds:** Issue via the dashboard (Registration Detail Sheet → Refund button). The dashboard triggers the Stripe refund, updates `paymentStatus`, creates a credit note, and emails the registrant — all atomically. MCP agents cannot issue refunds directly; this is an intentional safety boundary.

---

### F35 — MEDIUM: `send_bulk_email` has no schedule parameter ⏳ UNCHANGED

**Status:** Intentional gap. The underlying `ScheduledEmail` model + cron worker exists and powers webinar + registration-completion reminder sequences, but isn't exposed as an MCP tool because the operator-scheduling shape (recipients + filters + template + fire-time) doesn't compose cleanly into a flat MCP tool signature.

**Proposed future work:** `schedule_bulk_email` tool with a well-defined input shape. Not scheduled — no user has requested operator-driven scheduling via MCP.

**Manual entry:**
> **Scheduled campaigns:** Not available via MCP — all MCP `send_bulk_email` calls fire immediately. System-generated scheduled emails (webinar reminders, registration-completion chases) run on a server-side cron and are visible via `list_scheduled_emails`.

---

### F15 — LOW / DOC: Rate-limit threshold undocumented ✅ CLOSED

**Closure:** [`docs/MCP_REFERENCE.md`](MCP_REFERENCE.md) "Rate Limits" section now documents:
- **Global:** 100/hr per API key / OAuth token.
- **Per-tool buckets** (fire before the global counter): `send_bulk_email` 10/hr per event, `research_sponsor` 30/hr per user+event, `upload_speaker_agreement_template` 10/hr per user.
- **OAuth flows** (separate surface): DCR, authorize, token exchange, revocation.
- **Response schema** — the MCP HTTP endpoint already returns spec-compliant 429 with `Retry-After` header + structured body (`code: "RATE_LIMITED"`, `retryAfterSeconds`, `limit`, `windowSeconds`). Per-tool rejections return the same structured body as an MCP error (not HTTP 429).
- **Recommendations for agent implementations** — serialise writes, pre-check with `list_*`, respect `Retry-After`, observe global vs per-tool bucket split.

**Code was already correct** — the MCP route at [`src/app/api/mcp/route.ts:106`](../src/app/api/mcp/route.ts#L106) returns `status: 429` with `Retry-After` header. The gap was purely documentation, which is now closed.

---

## 2. Positive Findings — Regression-Safe After Refactor

The 16 "what works" entries from §2 of the Wave 1 report. Each is **confirmed still working** as of HEAD `f4a6a7e`; where the services refactor now backs the operation, the behaviour is additionally guaranteed by construction (single source of truth for REST + MCP). Lift these directly into the User Manual.

| ID | Area | Still confirmed |
|---|---|---|
| F6 | `create_speakers_bulk` in-batch duplicate detection | ✅ — tests cover DUPLICATE_IN_BATCH + row-index preservation |
| F7 | `create_speaker` cross-batch duplicate with `existingId` | ✅ — **service-backed** via `speaker-service.ts` (Phase 2b) |
| F11 | `create_session` endTime > startTime validation | ✅ — validation in session tool; REST + MCP share the rule |
| F12 | `create_session` within event-dates window | ✅ — includes explicit event date range + timezone in error |
| F14 | `create_registrations_bulk` email format validation | ✅ — `INVALID_EMAIL` error code + index preserved; Phase 0 tests assert this |
| F16 | `create_registration` cross-batch duplicate with `existingRegistrationId` + suggestion | ✅ — Phase 0 patched the MCP path to full REST parity; 18 parity tests cover this |
| F18 | `check_in_registration` idempotency (`alreadyCheckedIn=true`) | ✅ — original timestamp preserved |
| F19 | `list_unpaid_registrations` with `serialId` + `daysSinceRegistration` | ✅ — collections workflow ready |
| F23 | `create_review_criterion` weight bounds (1-10) | ✅ |
| F24 | `update_abstract_status` — the CRITICAL April-15 fix | ✅ — **service-backed** via `abstract-service.ts` (Phase 2a). Now guaranteed identical behaviour across REST and MCP by construction |
| F25 | Gold-standard error schema (`code` + `currentCount` + `required` + `suggestion`) on review-gate failures | ✅ — `INSUFFICIENT_REVIEWS` shape identical in both callers |
| F26 | `forceStatus=true` chair-override + `forcedOverride: true` in response | ✅ — audit log tagged `source: "chair-override"` in both callers |
| F27 | `assign_reviewer_to_abstract` USER_NOT_FOUND error | ✅ |
| F31 | `list_sponsors` flat + byTier + availableTiers in one call | ✅ |
| F32 | `research_sponsor` real website scrape + logo download | ✅ |
| F34 | `update/reset_email_template` clean override model | ✅ |

---

## 3. Neutral Findings — Still True (Training Material)

From §4 of the Wave 1 report. No changes, no regressions; incorporate into the User Manual as-is.

- **F5** Ticket types auto-create 3 inactive $0 pricing tiers. Operator must set prices via Settings UI. No MCP endpoint.
- **F8** Speaker status filters (INVITED / CONFIRMED / DECLINED / CANCELLED) work.
- **F13** Mixed session roles (CHAIRPERSON + SPEAKER) work in `create_session`; roles returned in `list_sessions`.
- **F21** `update_abstract_status` description explicitly documents the `requiredReviewCount` requirement. Now additionally backed by a shared `abstract-service.ts` so the requirement is centralized in one place.
- **F36** `cancel_scheduled_email` returns sensible error for non-existent ID.

---

## 4. Transient Findings — No Action Needed

- **F1–F4** — MCP outage across `create_event` / `list_events` / `get_event_info`, 9 consecutive generic failures, resolved on retry after ~15 min. Root cause not confirmed during Wave 1; no data committed during the outage. Worth monitoring in Wave 2 with structured logging (all MCP tool calls now log `durationMs` + `status`), but not a pending dev item.

---

## 5. Answers to Wave 1 Open Questions (§8)

| Question | Answer |
|---|---|
| Is `update_event` rejection of slug/startDate/endDate/eventType/timezone intentional? | **Yes, intentional.** These cascade to public URLs, scheduled emails, Zoom provisioning, and timezone math. Only the admin UI Settings page handles the cascades safely. Rejection returns `FIELD_NOT_ALLOWED` with a reason string. |
| What's the path to set `event.code` programmatically? | **Three paths now work**: (a) `POST /api/events` auto-derives; (b) MCP `create_event` auto-derives or accepts explicit; (c) MCP `update_event { code }` — `code` is in the whitelist. Legacy events without a code self-heal on first invoice via `resolveEventCode()` backfill. |
| When will `submit_abstract_review` be available via MCP? | **As of 22 April.** Via API key: `admin_submit_review_on_behalf` (takes explicit `reviewerUserId`, audit-logged as on-behalf-of). Via OAuth: `submit_abstract_review` directly. |
| Plans to integrate REFUNDED status with Stripe? | **Already integrated** for dashboard-initiated refunds (single-button, atomic). MCP agents intentionally cannot initiate refunds — safety rail. |
| Actual rate-limit policy? | Documented in §1 F15 above. Per-bucket, per-IP or per-user/per-org depending on endpoint. Needs to be exposed in the MCP reference. |
| Is check-in on CANCELLED intended (walk-ups) or a bug? | **Was a bug, now fixed.** Walk-up case handled via explicit `allowCancelled: true` override rather than silent overwrite. |

---

## 6. Recommendations for Wave 2

The Wave 1 closing note suggested four follow-ups. Current status of each:

1. **"Re-verify F17 with an explicit override pattern if the dev team ships a fix."**
   → Fix shipped (`462a689`). Re-verify the override flow + the default-block behavior.

2. **"Persona E (Sponsorship & Commercial) and Persona H (Finance) deep-dive — once F29 is resolved."**
   → F29 resolved. Finance deep-dive is now unblocked. Suggested scenarios: full invoice + payment + refund + credit-note cycle via MCP for at least one new event + one legacy event (to exercise the `event.code` backfill path).

3. **"Persona G (Event Delivery, Day-of) with stress testing."**
   → Suggested additions post-refactor: verify the `check_in_registration` `REGISTRATION_CANCELLED` guard triggers under field conditions (scanning real badges), and that `allowCancelled` override is auditable.

4. **"Parallel track: draft the User Manual."**
   → Lift directly from §2 of this closeout. Every row flagged ✅ is confirmed behaviour with code citations.

### New scenarios worth adding to Wave 2

- **S-NEW-1: Paid MCP registration end-to-end.** Create an event with a **paid** ticket type ($X > 0), call `create_registration` via MCP → verify the registrant receives the confirmation email + quote PDF attachment. Wave 1 only exercised $0 tiers so this path wasn't tested; Phase 0 (`989c5fd`) added 18 parity tests but a field-tested S-NEW-1 would confirm end-to-end delivery in a live sandbox.
- **S-NEW-2: Legacy event invoice backfill.** Pick an event created before `deriveEventCode()` was wired into `create_event`, null out its `code` via Prisma Studio, call `create_invoice` via MCP → verify: invoice succeeds with a derived code (e.g. `HFF2026-INV-001`), and the event's `code` is now persisted in the row for subsequent invoices.
- **S-NEW-3: on-behalf review.** Via API-key MCP, call `admin_submit_review_on_behalf` for a reviewer in the event pool → verify submission lands with `source: "on-behalf-of"` in the audit log and appears correctly in `/my-reviews` for the named reviewer.

---

## 7. References

### Commits that closed Wave 1 findings

| Commit | Scope |
|---|---|
| `462a689` | Wave 1 fixes: check-in guard (F17), event.code whitelist, review-on-behalf (F22) |
| `97e7712` | Wave 1 follow-up: F10, F28 (partial), F15, F9 |
| `989c5fd` | Phase 0 MCP parity — caught a drift bug Wave 1 didn't exercise (paid registrations missing confirmation email). Not in the Wave 1 scope but addressed proactively. |
| `5c6ff8e` | Services Phase 1 — `accommodation-service.ts` |
| `761ec7a` | Services Phase 2a — `abstract-service.ts` (guarantees F24/F25/F26 parity by construction) |
| `7381b65` | Services Phase 2b — `speaker-service.ts` (guarantees F7 parity by construction) |
| `bb1dad0` | Confirmation-number terminology fix + Quote PDF layout widening (not in Wave 1 scope) |
| `ced1a18` | Invoice auto-receipt fix — `resolveEventCode()` + legacy-event backfill (closes F29/F33 final mile) |

### Related documents

- [`docs/HANDOVER.md`](HANDOVER.md) §2.5 — Services Layer architecture
- [`docs/HANDOVER.md`](HANDOVER.md) §14 — Services Refactor Status
- [`src/services/README.md`](../src/services/README.md) — Service-extraction conventions
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — Known Gaps §2 (refactor status)
- [`CHANGELOG.md`](../CHANGELOG.md) — Per-commit delta

---

## 8. Closing Statement

The Wave 1 report's closing note:

> *"The dev team has earned confidence. The remaining blockers (event.code gating, reviewer submission via MCP) are tractable and concrete."*

**Both blockers are now tracted and concreted.** All 5 CRITICAL + HIGH findings closed, F15 docs published, leaving only F28 (upsert_sponsors partial-update) and F35 (bulk-email scheduling) as additive UX nice-to-haves. None block Stage 4/5 beta operation.

**Recommended maturity revision: Stage 4/5.** Reserve Stage 5/5 for the cutover to the external public REST API (Phase 3 of the services refactor), at which point the full three-caller pattern (REST + MCP + external API) is live and drift-proofed end-to-end.

Ready to hand off to Wave 2 + the User Manual team.

*— End of Wave 1 Closeout —*
