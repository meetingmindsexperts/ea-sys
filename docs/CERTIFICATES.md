# Certificates — Architecture + Operational Reference

**Last updated:** 2026-06-02

The certificate system in EA-SYS is built around the **v3 PDF-overlay
model**: organizers upload a finished cert PDF (or PNG/JPG that gets
server-converted), drag positioned text boxes onto it via a canvas
editor, and at issue time the renderer paints per-recipient token-
substituted text on top. Replaced the v2 compose-from-assets model in
the 2026-06-02 architecture flip — organizer feedback was that
designers want to own the entire cert visual, not have us assemble
banners + signatures + footer logos from individual pieces.

The user-facing guide for this system is in
[`public/user-guide.html` §18 Certificates](../public/user-guide.html#s18).
This doc is the dev/ops reference.

## Models

```
Event ──┬─── CertificateTemplate (N per category)
        │      ├─ name, category (ATTENDANCE | APPRECIATION)
        │      ├─ backgroundPdfUrl, textBoxes: Json
        │      ├─ emailSubject, emailBody (cover email defaults)
        │      └─ sortOrder
        │
        ├─── CertificateIssueRun (1 per Issue click)
        │      ├─ certificateTemplateId (FK, SetNull on template delete)
        │      ├─ status: PENDING|RENDERING|AWAITING_REVIEW|SENDING|COMPLETED|FAILED|CANCELLED
        │      ├─ emailSubject, emailBody (snapshot at Issue time)
        │      ├─ rendererStartedAt/FinishedAt, emailerStartedAt/FinishedAt
        │      ├─ lastTickAt (stall detector heartbeat)
        │      └─ totalCount, renderedCount, emailedCount, failedCount
        │
        ├─── CertificateIssueRunItem (1 per recipient per run)
        │      ├─ runId FK
        │      ├─ registrationId XOR speakerId
        │      ├─ recipientName, recipientEmail (snapshot)
        │      ├─ renderedAt, issuedCertificateId, emailedAt
        │      └─ errorPhase, errorMessage
        │
        ├─── IssuedCertificate (immutable audit row)
        │      ├─ type (ATTENDANCE | APPRECIATION)
        │      ├─ certificateTemplateId (FK, SetNull on template delete)
        │      ├─ serial (unique), pdfUrl
        │      ├─ recipientSnapshot Json (frozen at issue)
        │      ├─ cmeHoursSnapshot
        │      └─ @@unique([eventId, type, registrationId])
        │      └─ @@unique([eventId, type, speakerId])
        │
        └─── CertificateSerialCounter (atomic counter per category)
               └─ @@id([eventId, type])
```

### Why `@@unique([eventId, type, registrationId])` rather than per-template

The invariant is **one cert per recipient per category per event** —
regardless of which template variant fired. A person can hold at most
one Attendance cert + one Appreciation cert per event. The dual unique
constraints on IssuedCertificate (registration AND speaker variants)
enforce this at the database level, catching concurrent operator
clicks + MCP retries that race past the application-level eligibility
exclusion.

### Why `SetNull` on template delete

Deleting a template doesn't orphan IssuedCertificate rows — the FK is
nullable + SetNull on delete. The DELETE API still **blocks** with 409
when issued history exists (audit-trail integrity), but the FK is a
belt-and-braces fallback in case the API guard is ever bypassed.

## File layout

```
src/
├── lib/certificates/
│   ├── types.ts                  # CertificateTextBox, CertificateData, etc.
│   ├── render.ts                 # pdf-lib overlay renderer
│   ├── template.ts               # mergeBody() + token resolver for IN-PDF text
│   ├── eligibility.ts            # eligibleForType(type, eventId, tag) — tag-driven
│   ├── issue-worker.ts           # cron-driven RENDER → SEND state machine
│   ├── email-tokens.ts           # CLIENT-SAFE constants + COVER_EMAIL_TOKENS spec
│   ├── email-tokens-resolver.ts  # SERVER-ONLY resolveCoverEmailTokens()
│   └── sample-data.ts            # synthetic recipient for Preview
├── app/api/events/[eventId]/certificates/
│   ├── settings/route.ts         # GET/PATCH CME hours + accreditations
│   ├── templates/route.ts        # GET (list) + POST (create)
│   ├── templates/[templateId]/route.ts  # PATCH + DELETE
│   ├── eligible/route.ts         # GET availableTags (no tag) + filtered (with tag)
│   ├── preview/route.ts          # GET ?templateId=X (synthetic recipient)
│   ├── issue/route.ts            # POST {templateId, tag, emailSubject, emailBody}
│   └── runs/[runId]/{,/send,/cancel}/route.ts  # run status + state transitions
├── app/api/upload/pdf/route.ts   # multipart upload, PDF/JPG/PNG, image→PDF
├── app/api/cron/certificate-issues/route.ts  # Bearer-auth cron entrypoint
├── app/(dashboard)/events/[eventId]/certificates/page.tsx  # Templates/CME/Preview/Issue tabs
├── components/certificates/
│   ├── certificate-canvas-editor.tsx  # pdfjs-dist rasterize + react-rnd drag/resize
│   └── cert-email-editor-dialog.tsx   # Tiptap dialog for cover email
└── lib/agent/tools/certificates.ts    # MCP tools (list/create/update/delete templates + CME)
```

## Issue lifecycle (state machine)

```
              POST /issue
                  │
                  ▼
          PENDING (run + items created in one tx)
                  │
                  │  cron tick (every 60s)
                  │  /api/cron/certificate-issues
                  ▼
          ┌─ RENDERING ─┐
          │    ↻ 50 items/tick
          │    │ per item:
          │    │   - load recipient via FK
          │    │   - allocate serial via SerialCounter upsert
          │    │   - render PDF via pdf-lib (loadBg + textBoxes overlay)
          │    │   - store PDF to disk/Supabase
          │    │   - INSERT IssuedCertificate (catches P2002 → reuse existing)
          │    │   - UPDATE item.renderedAt + issuedCertificateId
          │    │   - INCR run.renderedCount
          │    │   - heartbeat lastTickAt
          └────┘
                  │
                  │  all items renderedAt != null
                  ▼
          AWAITING_REVIEW ── operator spot-checks PDFs ── click "Send emails"
                  │
                  ▼
          ┌─ SENDING ─┐
          │    ↻ 25 items/tick  (AWS SES sustained 14/sec; 25/tick = ~25/min safe)
          │    │ per item:
          │    │   - load IssuedCertificate pdfUrl
          │    │   - resolve cover email tokens
          │    │   - HTML-escape user-controlled values
          │    │   - wrapWithBranding + inlineCss (per-event branding pipeline)
          │    │   - sendEmail with PDF attachment
          │    │   - log to EmailLog (entityType: REGISTRATION|SPEAKER)
          │    │   - UPDATE item.emailedAt
          │    │   - INCR run.emailedCount
          └────┘
                  │
                  │  all items emailedAt != null
                  ▼
          COMPLETED
```

### Stall detector

Cron tick has a `lastTickAt` heartbeat. The orchestrator at the top of
`tickAllRuns()` reclaims any non-terminal run whose lastTickAt is older
than 10 minutes back to its prior state (PENDING for RENDERING,
AWAITING_REVIEW for SENDING). Protects against crashed workers leaving
runs stuck.

### Failure isolation

Per-item failures (render error / email-send error) mark the item
`errorPhase` + `errorMessage` and increment `run.failedCount`. The run
**continues** — one bad recipient doesn't kill the batch. Run-level
failures (template deleted mid-run, event not found, etc.) call
`failRun()` which flips status to FAILED with the reason.

## Token systems

There are **two separate token resolvers** with overlapping but
distinct token sets:

### In-PDF tokens (`mergeBody` in template.ts)

Used for text boxes painted onto the cert visual.

| Token | Meaning |
|---|---|
| `{{recipientName}}` | "Dr. Sample Attendee" |
| `{{eventName}}` | event.name |
| `{{eventDateRange}}` | "5th - 7th December 2025" |
| `{{venueLine}}` | "at Conrad Dubai, UAE" |
| `{{accreditationBody}}` | "Dubai Health Authority (DHA)" |
| `{{accreditationReference}}` | "DHA-CPD-2026-0142" |
| `{{cmeHours}}` | "18.0" |

### Cover-email tokens (`resolveCoverEmailTokens` in email-tokens-resolver.ts)

Used for the cover email subject + body. Additional tokens beyond the
in-PDF set:

| Extra token | Meaning |
|---|---|
| `{{organizationName}}` | org.name |
| `{{certificateType}}` | "Certificate of Attendance" / "Certificate of Appreciation" |
| `{{certificateSerial}}` | The cert's unique serial number |
| `{{abstractTitle}}` | APPRECIATION-only: speaker's accepted abstract title (POSTER preferred) |

Unknown tokens render as empty string + log warn (`cert-template:unknown-token`
or `cert-email-token:unknown`). Typo'd tokens never print literally
on a delivered cert — they degrade gracefully.

## Eligibility (tag-driven)

Per 2026-06-02 evening organizer decision: **no auto-eligibility**.
Eligibility is operator-controlled via tags:

```
ATTENDANCE template + tag X
  → registrations in event WHERE Attendee.tags HAS X
                          AND status != CANCELLED
                          AND not already holding an ATTENDANCE cert

APPRECIATION template + tag X
  → speakers in event WHERE Speaker.tags HAS X
                      AND not already holding an APPRECIATION cert
```

Tags live on `Attendee.tags` (Registration → Attendee FK) and
`Speaker.tags`. Abstract submitters are stored as Speaker rows (Abstract
has a required `speakerId` FK), so submitters inherit `Speaker.tags`.

The `/eligible` endpoint has two modes:
- `?templateId=X` (no tag) → returns `availableTags: [{ tag, count }]`
  for the picker UI
- `?templateId=X&tag=Y` → returns the filtered recipient list + the
  same `availableTags` overview

## Upload route

`POST /api/upload/pdf` accepts PDF/JPG/PNG. Magic-byte detection:

| Format | Magic |
|---|---|
| PDF | `%PDF-` = `25 50 44 46 2D` |
| PNG | `89 50 4E 47 0D 0A 1A 0A` |
| JPEG | `FF D8 FF` |

Images get wrapped in a single-page PDF via `pdf-lib`'s `embedPng` /
`embedJpg` — page dimensions = image's intrinsic pixel dimensions
interpreted as PDF points, image fills page edge-to-edge. The
canvas editor + renderer downstream only ever see PDFs.

Security guards:
- `eventId` is validated against a cuid regex BEFORE touching the
  filesystem (defense against `../../media` traversal)
- `eventId` is verified against the user's organization via
  `db.event.findFirst` — cross-tenant write is structurally impossible
- File size cap: 10 MB
- Rate limit: 50/hr per user
- denyReviewer guard

## MCP tools

| Tool | Purpose |
|---|---|
| `list_certificate_templates` | List all templates + CME settings |
| `create_certificate_template` | Create template (name, category, optional bg + boxes + email defaults) |
| `update_certificate_template` | Patch template fields by id (incl. cover-email defaults) |
| `delete_certificate_template` | Delete template (blocked if issued certs reference it) |
| `update_cme_settings` | Patch event cmeHours + accreditations |

The Issue flow itself is NOT exposed via MCP — operator-only, requires
the cover-email confirmation step. If we ever expose it, it'd need a
sane default for the email subject/body params since MCP callers can't
launch a dialog.

## Performance characteristics

| Metric | Value | Notes |
|---|---|---|
| Render rate | ~50 certs/min | RENDER_BATCH_SIZE × 1 tick/min |
| Email rate | ~25 emails/min | SES sustained 14/sec; 25/min stays comfortably under |
| 300-attendee event | ~6 min render + ~12 min email | ~18 min total |
| 5000-attendee event | ~1.5 hr render + ~3.3 hr email | ~5 hr total |
| Token resolution | 1 DB query per recipient (only when `{{abstractTitle}}` is in the template) | Otherwise pure in-memory |
| Preview endpoint | 30/hr/user rate limit | Allows ~30 design-iteration cycles |

For higher throughput (100k+ certs), the constraints are:
1. AWS SES rate (provision higher quota with AWS)
2. Cron tick frequency (currently 60s; could go to 30s)
3. RENDER_BATCH_SIZE (currently 50; can go higher if EC2 has CPU
   headroom — pdf-lib rendering is CPU-bound)

## Per-recipient resend (June 3, 2026)

Operator feedback drove four additions on top of the issue-run flow:

### Resend route + tracking

`POST /api/events/[eventId]/certificates/issued/[certificateId]/resend`
re-fires the delivery email for one already-issued certificate. Uses
the EXISTING `pdfUrl` (no re-render) and the cover-email snapshot from
the original `CertificateIssueRun` row (no template re-fetch) so the
resend is a faithful **replay** of what the recipient would have seen
the first time. Legacy certs (no run row, or null snapshot) fall back
to the system defaults the cron worker uses.

Two new columns on `IssuedCertificate` (migration
`20260603120000_add_certificate_resend_tracking`, additive only):

- `lastResentAt: DateTime?` — most recent resend timestamp; null until first resend
- `resendCount: Int @default(0)` — `0` means "sent once via original run, never resent"

These are **distinct from `lastReprintedAt` / `reprintCount`** —
reprint re-renders the PDF, resend re-fires the email reusing the
existing PDF.

The route:

1. `denyReviewer` + 30/hr/user rate limit
2. Primary `where: { id, eventId, event: { organizationId } }` —
   single atomic binding for all three; no secondary JS check
3. Refuses revoked (409 `CERT_REVOKED`), unrendered (409 `PDF_NOT_RENDERED`),
   and missing-PDF (409 `PDF_MISSING`) cases
4. Loads PDF via `loadPdfBytes()` with **path-traversal + SSRF guards**:
   local paths must resolve under `public/uploads/certificates/`;
   remote URLs must be `https://` + hostname matches the
   `REMOTE_PDF_HOST_ALLOWLIST` (today: `*.supabase.co`). Each rejection
   logs distinctly (`pdf-path-traversal` / `pdf-invalid-url` /
   `pdf-non-https` / `pdf-host-disallowed` / `pdf-fetch-failed`)
5. Resolves cover-email tokens via shared `resolveCoverEmailTokens()` —
   recipient-specific values are `escapeHtml()`-sanitized
6. Sends via `sendEmail()` with the per-event branding pipeline applied
7. **Bumps `resendCount++` and `lastResentAt = now()` ATOMICALLY AFTER
   the SES send succeeds** — failed sends do NOT poison the counter
8. Writes an `EmailLog` row via the `logContext` chain with
   `templateSlug: "certificate-delivery"` so the EmailLogCard pill
   renders on the same detail sheet

### Listing route

`GET /api/events/[eventId]/certificates/issued?registrationId=…` or
`?speakerId=…` — XOR (exactly one id required). Returns per-recipient
cert rows with template name, serial, issued/sent/resent timestamps,
resendCount, and any revocation metadata. Used by the
`IssuedCertificatesCard` component which mounts above `EmailLogCard`
on both the registration detail sheet (Activity tab) AND the speaker
detail page.

### EmailLog discriminator

Both the cron worker and the new resend route now thread
`templateSlug: "certificate-delivery"` through `logContext`, so the
`EmailLogCard` renders a small amber `<Award>` "Cert" pill next to any
cert-delivery row. Cron and resend rows are visually identical — the
distinction is the row's `triggeredByUserId` and timing.

### Canvas-editor UX

`certificate-canvas-editor.tsx` gained:

- **Undo / Redo** with commit-point granularity (one step per drag-end,
  resize-end, add, delete, duplicate, textarea-focus, font/align
  change). Stack depth 30 per-side. Toolbar buttons + Cmd/Ctrl+Z /
  Cmd/Ctrl+Shift+Z / Cmd/Ctrl+Y. Shortcuts only fire when focus is on
  the editor wrapper (tabIndex=0) — textarea Cmd+Z stays the
  browser's built-in.
- **Y-axis arrow nudge** on the selected box: Up/Down = 1pt,
  Shift+Up/Down = 10pt, bounds-clamped. Y-axis only by explicit
  organizer request (X/W/H are direct-input via the side panel).
  Consecutive presses within 500ms coalesce into one undo step so
  holding the key doesn't fill the stack.

### Deferred review-pass findings

The independent review-agent pass on commit `0c56c9a` surfaced 4 HIGHs
(all fixed in `58168b4`), 7 MEDIUMs, and 7 LOWs. The MEDIUM/LOW items
were consciously deferred — see [ROADMAP.md](ROADMAP.md)
§"Certificates — operator-feedback round, deferred review findings
(June 3, 2026)" for the trigger-driven backlog.

## On-demand delivery + bulk reissue (July 9, 2026)

The June-3 resend **replays the frozen original** (old PDF + old cover-email
snapshot). A later round added the ability to **re-render from the *current*
template** (so a corrected greeting / design propagates), to do it in **bulk**,
and to **issue on demand to one person**. Shared core:
`src/lib/certificates/deliver.ts`.

### Shared service — `deliver.ts`
- `issueSingleCertificate(ctx, { templateId, registrationId|speakerId })` —
  issue ONE template to ONE recipient on demand (render → create cert → email).
  **Tag-independent** — a deliberate operator override; the tag gate only governs
  auto/bulk *selection*. Returns 409 `ALREADY_ISSUED` when they already hold the
  template's cert (per-template `@@unique`).
- `reRenderAndResendCert(ctx, certificateId)` — re-render an EXISTING cert from
  the CURRENT template, update `pdfUrl`, resend with the **current** cover email.
  Bumps `reprintCount` (render attempts) + `resendCount` + the new
  `reissueCount` / `lastReissuedAt` (delivered refreshes). Org-scoped lookup;
  logs every rejection.
- The render/recipient helpers (`loadEventContext`, `loadRecipient`,
  `allocateSerial`, `loadPosterAbstractTitle`, `formatRecipientName`,
  `EventContext`) were extracted from `issue-worker.ts` into `cert-context.ts`
  so the worker can call `reRenderAndResendCert` without a circular import
  (worker → deliver → cert-context; deliver does **not** import the worker).

### Routes
- `POST .../certificates/issue-single` — single issue (synchronous). 30/hr/user.
- `POST .../issued/[certId]/reissue` — single re-render + resend (synchronous);
  shares the 30/hr `cert-resend` bucket. **The IssuedCertificatesCard "Resend"
  button now calls THIS** (re-render latest), not the frozen `/resend` route.
- `POST .../certificates/bulk-reissue` `{ templateId, tag? }` — bulk re-render +
  resend to every already-issued cert for a template (optional attendee/speaker
  tag filter). 10/hr/user; guarded against a concurrent reissue run for the same
  template.

### Reissue runs (worker)
`CertificateIssueRun.reissue Boolean` (migration `20260709100000`, additive).
A reissue run **skips the render + AWAITING_REVIEW gates**: `processRun` routes
`run.reissue` to `processReissuePhase`, which drains each item
(`issuedCertificateId` set → the existing cert) via `reRenderAndResendCert`
(EMAIL_BATCH_SIZE/tick, SES-safe). Per-item failure isolation via
`markItemFailed`; re-entrant (re-drains only `emailedAt: null`).
`reclaimStalledRuns` keeps a stalled reissue run **in SENDING** (refresh
`lastTickAt`) rather than bouncing it to AWAITING_REVIEW (which has no reissue
handler). **All reissue logic sits behind `if (run.reissue)` — the existing
issue / auto-issue path is byte-for-byte unchanged.**

### UI (IssuedCertificatesCard)
- **Issue certificate** — template picker → single issue.
- **Resend latest version** (per row) — re-render + resend from the current template.
- **Resend all (N)** — re-render + resend every non-revoked cert the person holds,
  one email each, partial-failure safe with a live progress counter.
- Each row shows "Reissued N times (latest template)" from `reissueCount`.

Independent adversarial review (July 9): **SAFE TO SHIP, 0 blocker / 0 high**.
The `CertificateIssueRunItem` uniqueness is enforced as **partial unique indexes**
(`WHERE speakerId IS NOT NULL`), so a bulk `createMany` of N items sharing a NULL
facet cannot collide. Deferred MEDIUM/LOW → see
[ROADMAP.md](ROADMAP.md) §"Certificate rework — deferred review findings (July 9, 2026)".

## Bulk-email certificate send — audience is ALL registrations (July 10, 2026)

The Communications → **Send Certificates** tile used to pre-filter the
audience to `status = CHECKED_IN`, so CONFIRMED (never-scanned) registrants
were invisible to the send — organizer-reported bug. Per the organizer's
decision (2026-07-10): **check-in status does NOT gate certificates; the
template tag is the only routing rule** ("no tag, no certificate").

Behavior after the fix:

- The **Send Certificates tile** ([communications/page.tsx](../src/app/(dashboard)/events/[eventId]/communications/page.tsx))
  targets **all registrations** — no status pre-filter. The organizer can
  still narrow via the dialog's "Filter recipients" section (an explicit
  status filter is respected as-is).
- **CANCELLED registrations are always excluded** when no explicit status
  filter is set — enforced server-side in `executeBulkEmail`'s registration
  `where` ([bulk-email.ts](../src/lib/bulk-email.ts)), mirroring the
  Issue-tab eligibility rule above. The client-side recipient counters
  (Communications page + registrations list) mirror the same rule via a new
  `emailType` field on `BulkEmailEffectiveFilters`, so count == send.
- **Recipients holding none of the selected templates' tags are SKIPPED,
  not failed** ([bulk-issue.ts](../src/lib/certificates/bulk-issue.ts)):
  they get no email, land in a new `skippedCount` (returned through
  `BulkEmailResult`, surfaced in the worker's `scheduled-email:sent` log +
  admin notification), and are warn-logged per recipient
  (`cert-bulk:no-applicable-certs`) so the routing stays auditable. Before
  this, an all-registrations send with 50 tagged people out of 300 would
  have reported 250 "failures".

The manual **Issue tab** flow was already correct (tag-scoped pool over all
non-CANCELLED registrations, no check-in gate) and is unchanged.

**Preview from the send dialog (July 10, 2026 follow-up):** the bulk-email
dialog's footer **Preview** button used to toast "Preview isn't available for
this email type" for certificate sends (`emailTypeToSlug` returned null — the
cert cover email isn't an `EmailTemplate` slug). Now:

- **Cover email** — `POST /email-preview` accepts `slug: "certificate"` +
  `certificateTemplateIds`, rendered by `buildCertCoverEmailPreview()`
  ([bundle.ts](../src/lib/certificates/bundle.ts)): same subject/body
  precedence as the real send (custom override → single template's saved
  cover → category/multi system default), sample recipient "Dr. Sample
  Attendee", PREVIEW-DRAFT serials, real event branding. No DB writes.
- **Certificate PDF** — each template row in the dialog's picker has a
  per-template **Preview** link opening the existing
  `GET /certificates/preview?templateId=…` sample PDF in a new tab
  (available for tagless templates too — design check is independent of
  routing).

**Cover-email source picker (same day):** instead of typing a subject/message
from scratch, the dialog's **Cover email** dropdown pre-fills the editable
Subject/Message fields from either (a) a selected certificate template's
**saved cover** (the one edited in the cert template editor — offered when it
has one), or (b) a **saved email template** from Communications → Email
Templates (active custom templates; `stripDocumentWrapper` applied so a
legacy full-document template doesn't nest inside the branding wrapper).
"Certificate default" clears the fields (per-template/bundle default applies,
as before). The FIELDS remain the source of truth for the send — the picker
is a copy action, so edits after picking just diverge. To make saved email
templates render correctly as covers, the cert token resolver
([email-tokens-resolver.ts](../src/lib/certificates/email-tokens-resolver.ts))
now also resolves **`{{firstName}}`/`{{lastName}}`** (threaded from the
bulk-send recipient; `{{firstName}}` falls back to the full `recipientName`
on the manual-Issue path, which snapshots only the full name) and
**`{{eventDate}}`/`{{eventVenue}}`** aliases. Unknown tokens still render
empty + warn (`cert-email-token:unknown`).

## Deferred / not implemented

- **Tag-scoped bulk reissue in the UI** — the certificates-page
  "Resend to everyone (N)" button (Issue tab, per template — SHIPPED July 9, 2026)
  resends to **everyone** who holds the cert; the endpoint's optional `tag`
  filter (resend only to recipients holding a tag) stays API/MCP-only for now.
- **MCP Issue tool** — operator must use the dashboard for issuing
  (email dialog is interactive)
- **Mid-run email edit** — once a run is created, the cover-email
  snapshot is frozen. To change, cancel + re-issue.
- **Test email to operator** — "send a test to me first" button on
  the Issue dialog. Useful, deferred.
- **Per-recipient template override** — multiple-template auto-routing
  via eligibility rules. Operator picks template per Issue run; if
  different cohorts need different designs, run Issue multiple times.

## See also

- [HANDOVER.md](HANDOVER.md) — operational handover for new engineers
- [MCP_REFERENCE.md](MCP_REFERENCE.md) — full MCP tool catalog
- [user-guide.html §18](../public/user-guide.html#s18) — operator-facing guide
- [CLAUDE.md](../CLAUDE.md) — codebase notes
