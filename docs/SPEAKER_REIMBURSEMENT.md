# Speaker Reimbursements

Web replacement for the paper **"Speaker / Faculty Reimbursement Form"** (bank
wire transfer request, Meeting Minds FZ LLC). Shipped July 20, 2026.

Speakers claim their **speaker fee / flight / hotel / ground transport / other
expenses** through a personalized token link — no login. Receipts and bank
details are collected online; finance pulls a CSV and processes the wires
outside the system.

**v1 is submission-only** (owner decision): the lifecycle is
`PENDING → SUBMITTED` with an organizer **"Reopen for edits"** back to
PENDING. Approval / mark-paid tracking is deliberately NOT built (the enum
leaves room to grow `APPROVED` / `PAID` later).

---

## 1. The model

| Model | What it is |
|---|---|
| `SpeakerReimbursement` | One per speaker per event (`speakerId @unique`; Speaker is already event-scoped). Carries the unguessable plaintext `token` (RsvpInvite pattern — the dashboard re-displays the copyable link, so no one-way hash), the Section-B snapshot fields (fullName/nationality/passportNumber/…), `claimLines` JSON (`[{item, currency, amount}]`), `bankDetails` JSON (beneficiary/bank/IBAN/SWIFT/…), and the declaration trail (`signedName`, `submittedAt`, `submittedIp`). |
| `SpeakerReimbursementDocument` | Uploaded files. `kind` is a **string** (PASSPORT / FLIGHT_RECEIPT / HOTEL_INVOICE / TRANSPORT_RECEIPT / OTHER) so adding a kind never needs a migration. |
| `Speaker.honorariumAmount` + `honorariumCurrency` | The organiser-agreed honorarium / speaker fee (Sep 3, 2026). On **Speaker**, not on the reimbursement row, because `{{honorarium}}` must resolve in an invitation sent before any link exists. Null = not agreed, rendered as 0. See §4c. Migration `20260903100000_add_speaker_honorarium` (two nullable columns, additive + idempotent). |

Migration `20260720120500_add_speaker_reimbursement` — additive + idempotent,
blue-green safe. Snapshot semantics: the speaker's answers live on the
reimbursement row, so a later Speaker edit never rewrites what was signed.

Shared logic lives in `src/lib/reimbursement/`:

- **`constants.ts`** — client-safe (NO Node imports; imported by the public
  form page). Currencies (`USD/AED/SAR` — owner decision, matches the paper
  form), claim items with their required receipt kind, document kinds, the
  Zod submit schema, `computeClaimTotals` (**per-currency — never summed
  across currencies**), `requiredDocumentKinds` / `missingDocumentKinds`
  (the receipt rule), and `canManageReimbursements()`.
- **`server.ts`** — token generation (Node crypto) +
  `loadReimbursementForSlug()` (token lookup, then event-slug assert — a
  valid token pasted under another event's slug 404s).

## 2. Access boundary (read this before touching any route)

Passport numbers + bank accounts are **wire-transfer data — the most
sensitive fields in the system**, stricter than the finance boundary
(`FINANCE_ROLES` includes MEMBER + ONSITE; this must not).

- **Who may see/manage: SUPER_ADMIN / ADMIN / ORGANIZER only** (owner
  decision, July 20 2026). MEMBER, ONSITE, CRM_USER and every org-null role
  see nothing.
- Every dashboard route — **reads included** — is gated with
  `denyReviewer(session)` with no allow-list: its restricted set is *exactly*
  the excluded population, so no new guard was needed. The named UI predicate
  is `canManageReimbursements()` (fails closed) — the speaker-profile card
  and console self-hide with it.
- **Uploaded files are NOT publicly served.** They live under
  `public/uploads/reimbursements/{eventId}/` so they ride the persistent
  Docker volume + the hourly DR sync like every other upload — but the public
  `/uploads/[...path]` catch-all **blocks the `reimbursements/` prefix**
  (403). The only read path is the authed
  `GET /api/events/[eventId]/reimbursements/[id]/documents/[documentId]`,
  which binds document → reimbursement → event (via `buildEventAccessWhere`)
  and traversal-guards the on-disk path.
- The CSV export logs an audited PII-extraction line (who pulled it, when,
  row count) — same rule as the RSVP roster export.

## 3. Routes

**Organizer** (all `denyReviewer`-gated + `buildEventAccessWhere`):

| Route | What |
|---|---|
| `GET /api/events/[eventId]/reimbursements` | List (`?speakerId=` narrows to one — backs the profile card; `?export=csv` streams the finance CSV). |
| `POST /api/events/[eventId]/reimbursements` | Create invites for `speakerIds[]` — mints tokens, skips existing (speakerId unique), silently drops foreign speaker ids. |
| `GET/PATCH/DELETE .../reimbursements/[id]` | Detail · **reopen** (`{action:"reopen"}`, conditional `SUBMITTED→PENDING` claim, audited) · delete (+ best-effort file unlink). |
| `POST .../reimbursements/send` | Email links — `{reimbursementId}` (single, explicit resend) or `{target: "all"\|"pending"}` + optional `subject`/`message`. EmailLog-based 10-min batch retry-safety; logged against the **SPEAKER** entity so sends show on the speaker's Email History. 10/hr/event. |
| `GET .../reimbursements/[id]/documents/[docId]` | Authed file stream (see §2). |
| `GET/PATCH /api/events/[eventId]/speakers/[speakerId]/honorarium` | The organiser-agreed fee (§4c). `PATCH { amount, currency }`; amount 0 clears both columns. `denyReviewer(session)` with NO allow-list (the reimbursement boundary), `buildEventAccessWhere`, write bound to `{ id, eventId }`, 60/hr/user, audited `HONORARIUM_SET` with before/after. Deliberately not part of the speaker PUT, which admits WEBINARS. |

**Public** (token-gated, rate-limited per IP + per token, every rejection logs):

| Route | What |
|---|---|
| `GET /api/public/events/[slug]/reimbursement/[token]` | Event branding + prefill (saved snapshot wins, else the Speaker record; **`email` is always `Speaker.email`**, see below) + docs + status. |
| `POST` same | The submission. Enforces the **receipt rule** (400 `MISSING_DOCUMENTS` naming the uncovered kinds), then a **conditional claim on PENDING** (`updateMany` — a double-submit race commits exactly once, loser gets 409 `ALREADY_SUBMITTED`). On success: audit with IP (agreement-acceptance shape), `notifyEventAdmins`, and the automated confirmation email — both failure-isolated. |
| `POST .../documents` / `DELETE .../documents/[docId]` | Receipt upload / remove. Upload is allowed while PENDING **and after submission** (owner decision July 21, 2026 — append-only: a forgotten/illegible receipt can be added without a reopen; post-submission uploads write a `DOCUMENT_ADDED` audit that surfaces on the speaker's Activity timeline). DELETE stays **PENDING-only** — nothing attached to a signed form is speaker-removable. PDF/JPG/PNG **magic-byte validated**, 10MB, max 15 per form. |

## 4. The receipt rule

The paper form's "Expenses without receipts cannot be processed" is enforced
server-side at submit (and mirrored client-side for inline feedback):

- **PASSPORT** — always required.
- Each claimed item requires its receipt kind: FLIGHT → FLIGHT_RECEIPT,
  HOTEL → HOTEL_INVOICE, TRANSPORT → TRANSPORT_RECEIPT, OTHER → OTHER.
- **SPEAKER_FEE is the one item that needs no receipt.**

Source of truth: `CLAIM_ITEMS[].receiptKind` + `requiredDocumentKinds()` in
`src/lib/reimbursement/constants.ts`.

## 4b. The email is locked to the Speaker record (Sep 2, 2026)

Section B prefills from the Speaker row and the speaker may correct most of
it (name as on passport, designation, institution, phone). **`email` is the
exception.** It renders read-only on the form, is not part of
`reimbursementSubmitSchema`, and the POST writes `Speaker.email` regardless of
what the body carries. Two reasons, both about what the address IS here:

- It is the identity the private link was sent to. Letting the holder of a
  token retype it would let them redirect the confirmation email, which is the
  receipt for the declaration's "processed within 45 days" promise, to a
  mailbox the invite never went to.
- It is what finance sees. `SpeakerReimbursement.email` is exported in the
  CSV and shown in the console; a retyped value made it disagree with the
  speaker record with nothing flagging the divergence.

Changing a speaker's email goes through the organizer's Change Email flow
(`PATCH .../speakers/[id]/email`), the same rule every other surface follows
since April 24, 2026. The snapshot column stays: a later Change Email does not
rewrite what was signed, but what gets snapshotted is now the canonical
address, not user input. The GET prefill also reads `Speaker.email` rather
than the snapshot, so a form submitted before the lock with a retyped address
is corrected on its next submit instead of carried forward.

## 4c. The honorarium / speaker fee is organiser-set and locked (Sep 3, 2026)

Before this the "Speaker Fee" line was one more expense the speaker typed. It
is now the organiser's figure, and only theirs. Owner decisions, verbatim:
"locked", "if not set, show it as 0", "speaker cannot add it", "honorarium /
speaker fees, not just speaker fees".

- **Where it lives:** `Speaker.honorariumAmount` (Decimal 12,2) +
  `honorariumCurrency` (USD / AED / SAR, the reimbursement set). The single
  reader is `readHonorarium()` in `constants.ts`: null unless the amount is
  positive AND the currency is one the form pays in, so a figure in EUR reads
  as not set rather than rendering with a currency finance cannot wire.
- **Where it is set:** the reimbursement console (inline per row, plus a
  column in the CSV) and the Reimbursement card on the speaker page. Both call
  the honorarium route above. Not the speaker form, not the CSV importer, not
  MCP (see §8).
- **On the form:** Section C renders a locked "Honorarium / Speaker Fee" line
  showing the agreed figure, or `0.00` with "no honorarium has been agreed"
  when none is. There is no input. The expense items below it are the only
  drafts the speaker owns.
- **On submit:** the body carries expense lines only. The POST drops any
  `SPEAKER_FEE` line it receives (logged
  `reimbursement-public:speaker-fee-in-body-ignored`, since the form never
  sends one) and injects the organiser's figure through
  `effectiveClaimLines()`, the same helper the form uses for totals and the
  receipt rule, so the two cannot disagree. Zero effective lines (no fee
  agreed, no expenses ticked) is refused with 400 `NOTHING_TO_CLAIM`; the
  submit schema no longer carries `.min(1)` on `claimLines` because emptiness
  is only decidable after the injection.
- **Stored shape is unchanged:** the injected line lands in `claimLines` as
  `{ item: "SPEAKER_FEE", ... }`, so the console totals, the CSV, the
  confirmation email's claim table and every existing reader keep working. A
  snapshot saved before the lock is stripped of its speaker-typed fee on the
  GET prefill.
- **Visibility follows the reimbursement boundary, not finance.** The speaker
  list and detail GETs (and the PUT response) return whole rows via `include`,
  so `stripHonorariumFields()` removes the two columns for anyone outside
  `canManageReimbursements` (MEMBER, ONSITE and WEBINARS included; an API key
  keeps them, being admin-equivalent everywhere). The `HONORARIUM_SET` audit
  row is dropped from the Activity timeline for the same population, because
  its before/after IS the fee.
- **The variable:** `{{honorarium}}` ("USD 1,500.00", or "0.00"),
  `{{honorariumAmount}}`, `{{honorariumCurrency}}`. Added to
  `SpeakerEmailContext`, which every speaker send reads (bulk, single,
  per-speaker previews, the agreement HTML merge and the `{honorarium}` .docx
  field), and built directly in the two token-link senders (reimbursement +
  profile-form invitations) and the received receipt through one
  `honorariumVars()`.
- **What the default agreement says:** the MMG faculty agreement and its email
  state "no speaker fee or honorarium is provided" in five places. That text
  is deliberately untouched. An event that pays one edits its own copy and can
  state the amount with the variable.

## 5. Emails

Two system templates (both in `DEFAULT_TEMPLATES`, editable per-event under
Communications → Email Templates, covered by the preview-vars + slug-mirror +
organizerSignature drift tests):

- **`speaker-reimbursement-invitation`** — the link email. Human-triggered;
  carries `{{reimbursementLink}}` (per-recipient token link),
  `{{personalMessage}}`, `{{organizerSignature}}`.
- **`speaker-reimbursement-received`** — automated confirmation on submit
  (the speaker's timestamped receipt — the declaration promises wire payment
  within **45 days** of receipt). Carries `{{claimSummary}}` (HTML table) /
  `{{claimSummaryText}}`. Transactional → deliberately no organizerSignature.
- **`{{honorarium}}` / `{{honorariumAmount}}` / `{{honorariumCurrency}}`** on
  every speaker template (invitation, agreement, custom, both token-link
  requests, the received receipt): the organiser-agreed fee, `0.00` when none
  is agreed (§4c). Not in any default body; organisers add the token where an
  event pays a fee.

Both send dialogs (console + speaker-profile card) offer **Preview** via the
shared `/email-preview` route (template auto-selected, typed subject/message
merged) and a deep link to the template editor.

## 6. Organizer UI

- **Console** `/events/[eventId]/reimbursements` (Setup-hub card): add
  speakers, email links (all/pending/single, with preview), copy links,
  review submissions, CSV export, reopen, delete, and the **Honorarium**
  column (inline amount + currency; shown again on the submission detail as
  "set by you"; a column in the CSV).
- **Speaker profile card** (`speaker-reimbursement-card.tsx`): status +
  claimed totals, *Create & email link* (create → send dialog with preview),
  resend, copy link, open console, and the **Honorarium / speaker fee** row
  (settable before any form exists, since the email variable needs it).
  Self-hides outside the boundary.
- **Speaker Activity timeline**: reimbursement audits fold in via
  `activity-feed.ts` (actions remapped to `REIMBURSEMENT_SUBMITTED` /
  `REIMBURSEMENT_REOPENED` etc. so the card reads like a sentence); the
  invitation emails appear via their SPEAKER EmailLog rows.

## 7. Tests

- `__tests__/lib/reimbursement.test.ts` — totals (incl. never-sum-across-
  currencies), receipt rule, access predicate truth table, submit schema
  guardrails (declaration literal-true, bank account-or-IBAN refine, …).
- `__tests__/api/reimbursement-public-routes.test.ts` — conditional-claim
  submit, lock/404/race-lost, MISSING_DOCUMENTS naming kinds, mail-blip
  never fails a committed submission, the `/uploads/reimbursements/`
  public-serve block, and the honorarium lock (fee injected first, body fee
  ignored + logged, fee-only submission, NOTHING_TO_CLAIM, GET prefill
  stripped). Mutation-verified: removing the injection fails four tests.
- `__tests__/api/speaker-honorarium-route.test.ts` — the boundary through the
  real `denyReviewer` (MEMBER / ONSITE / WEBINARS / REVIEWER / SUBMITTER /
  REGISTRANT refused), the `{ id, eventId }` write, 0 clears both columns,
  the audit's before/after, unsupported currency reads as unset.
- `__tests__/lib/speaker-honorarium-context.test.ts` — the three variables in
  `buildSpeakerEmailContext` + `mergeAgreementHtml`.
- `__tests__/api/restricted-role-reads.test.ts` — the roster strips the fee
  for MEMBER / ONSITE / WEBINARS / org-null, keeps it for staff + API keys.
  Mutation-verified: removing the strip fails four tests.
- `__tests__/lib/activity-feed-honorarium-gate.test.ts` — the
  `HONORARIUM_SET` audit row is dropped from the timeline outside the
  boundary and defaults closed. Mutation-verified: removing the gate fails
  two tests.

## 8. Deferred (deliberately not built)

- Approval / mark-paid workflow (v1 is submission-only; finance uses the CSV).
- A `speaker-reimbursement` emailType in the **bulk-email pipeline** — the
  dedicated send route is the one sender (owner: "no need", July 20 2026).
- MCP/agent tools.
- **Honorarium via MCP or the speaker CSV import.** `create_speaker` /
  `update_speaker` / `list_speakers` do not carry it. Exposing it means
  deciding whether an org API key (admin-equivalent everywhere) may set a
  payment figure through an agent; it is set from the console or the speaker
  page only.
