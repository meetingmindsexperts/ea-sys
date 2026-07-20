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

**Public** (token-gated, rate-limited per IP + per token, every rejection logs):

| Route | What |
|---|---|
| `GET /api/public/events/[slug]/reimbursement/[token]` | Event branding + prefill (saved snapshot wins, else the Speaker record) + docs + status. |
| `POST` same | The submission. Enforces the **receipt rule** (400 `MISSING_DOCUMENTS` naming the uncovered kinds), then a **conditional claim on PENDING** (`updateMany` — a double-submit race commits exactly once, loser gets 409 `ALREADY_SUBMITTED`). On success: audit with IP (agreement-acceptance shape), `notifyEventAdmins`, and the automated confirmation email — both failure-isolated. |
| `POST .../documents` / `DELETE .../documents/[docId]` | Receipt upload/remove while PENDING. PDF/JPG/PNG **magic-byte validated**, 10MB, max 15 per form. |

## 4. The receipt rule

The paper form's "Expenses without receipts cannot be processed" is enforced
server-side at submit (and mirrored client-side for inline feedback):

- **PASSPORT** — always required.
- Each claimed item requires its receipt kind: FLIGHT → FLIGHT_RECEIPT,
  HOTEL → HOTEL_INVOICE, TRANSPORT → TRANSPORT_RECEIPT, OTHER → OTHER.
- **SPEAKER_FEE is the one item that needs no receipt.**

Source of truth: `CLAIM_ITEMS[].receiptKind` + `requiredDocumentKinds()` in
`src/lib/reimbursement/constants.ts`.

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

Both send dialogs (console + speaker-profile card) offer **Preview** via the
shared `/email-preview` route (template auto-selected, typed subject/message
merged) and a deep link to the template editor.

## 6. Organizer UI

- **Console** `/events/[eventId]/reimbursements` (Setup-hub card): add
  speakers, email links (all/pending/single, with preview), copy links,
  review submissions, CSV export, reopen, delete.
- **Speaker profile card** (`speaker-reimbursement-card.tsx`): status +
  claimed totals, *Create & email link* (create → send dialog with preview),
  resend, copy link, open console. Self-hides outside the boundary.
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
  never fails a committed submission, and the `/uploads/reimbursements/`
  public-serve block.

## 8. Deferred (deliberately not built)

- Approval / mark-paid workflow (v1 is submission-only; finance uses the CSV).
- A `speaker-reimbursement` emailType in the **bulk-email pipeline** — the
  dedicated send route is the one sender (owner: "no need", July 20 2026).
- MCP/agent tools.
