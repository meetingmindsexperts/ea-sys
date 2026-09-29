# Shared submission views: a public, read-only page of abstracts and session proposals

Status: BUILT (Sep 29, 2026), not yet deployed. Owner request: "a live, publicly shareable
interface for abstract submissions and session proposal submissions; the organiser controls
what is shown. The CSV export shows everything, but viewers of the shared page must not see
email, phone, additional email and so on. They can see the title, content, theme and so on."

## 1. Owner decisions (Sep 29, 2026)

| # | Question | Ruling |
|---|---|---|
| D1 | How do viewers get in? | A secret link. Anyone who has it can view. The organiser can switch it off or regenerate it, which kills the old link at once. No passcode, no login. |
| D2 | Which submissions appear? | The organiser ticks statuses. Drafts and withdrawn submissions never appear, whatever is ticked. |
| D3 | Contact details (email, additional email, phone) | Off by default. The organiser may switch them on per link, behind an explicit warning. |
| D4 | Reviewer scores and comments | Never shown. They are not in the field list at all. |

## 2. Should we build it? The manual alternative

- **Manual path:** export the CSV, delete the contact columns, send the file. It works once,
  and is stale the moment someone submits, edits or changes status. It also relies on the
  organiser deleting the right columns every time. One slip sends everyone's email address.
- **Why build:** the page stays current, the contact rule is enforced by the server rather
  than by care, and a link can be withdrawn. A forwarded spreadsheet cannot.
- **Performance cost:** small. One indexed lookup plus one query per page view (capped at
  1,000 rows), rate-limited per IP. No email, no worker job, no change to any existing route.

## 3. What gets built

### 3.1 Data: one new table (additive migration)

```prisma
enum SubmissionShareKind {
  ABSTRACTS
  SESSION_PROPOSALS
}

model SubmissionShareLink {
  id             String              @id @default(cuid())
  eventId        String
  organizationId String?             // tenant key, stamped from Event at create; RLS policied
  kind           SubmissionShareKind
  token          String              @unique  // 32 random bytes, base64url
  enabled        Boolean             @default(true)
  statuses       String[]            // which submission statuses appear
  fields         String[]            // which optional fields appear
  createdById    String
  updatedById    String
  createdAt      DateTime            @default(now())
  updatedAt      DateTime            @updatedAt

  event Event @relation(fields: [eventId], references: [id], onDelete: Cascade)

  @@unique([eventId, kind])    // one link per event per kind
  @@index([organizationId])
}
```

- **Why a table and not `Event.settings`:** several public routes select `Event.settings`
  whole (the public agenda route does). A token in that blob is one careless `return` away
  from being published. A table also gives a unique index for the lookup and its own RLS
  policy.
- **Why the token is stored readable, not hashed:** the organiser must be able to copy the
  link again later. It grants view access only, and can be withdrawn. This is the same
  trade-off as `RsvpInvite.token`.
- **Migration:** `CREATE TYPE` inside a `DO` block and `CREATE TABLE IF NOT EXISTS`,
  idempotent. Nothing existing is touched, so it is blue/green safe.
- **RLS:** a new `prisma/rls/submissionshare.sql` with the flat `organizationId` policy.

### 3.2 The field catalogue: one pure module, `src/lib/submission-share.ts`

This module is the single source of the rules. The settings card, the save route and the
public route all read it.

**Always shown:** number (A-001 / S-001) and title. A page without those is useless.

**Abstracts, optional fields:**

| Field | Default |
|---|---|
| Abstract text | on |
| Theme and sub-theme | on |
| Track | on |
| Presentation type | on |
| Specialty | on |
| Presenting author name | on |
| Author organisation and job title | on |
| Author country | on |
| Co-authors (names and affiliations; they carry no contact data) | on |
| Status | off |
| Submitted date | off |
| **Author email** (contact) | **off** |
| **Author additional email** (contact) | **off** |
| **Author phone** (contact) | **off** |

**Session proposals, optional fields:** description, theme, proposed format, duration,
proposer name, organisation and job title, country (on); status, submitted date (off); proposer
email, additional email, phone (contact, off).

**Statuses:**
- Abstracts may show Submitted, Under review, Accepted, Revision requested, Rejected. The
  default is everything except Rejected.
- Proposals may show Submitted (the only non-draft, non-withdrawn status today). The list
  grows automatically when a review workflow adds statuses.
- DRAFT and WITHDRAWN are never selectable, and the server drops them if sent.

**The projection:** `projectAbstract(row, fields)` and `projectProposal(row, fields)` build
the public object ONLY from the enabled keys, and the contact columns are selected from the
database only when enabled. A hidden field is absent from the response, not blanked, so it cannot show up in the page source or the network tab.

### 3.3 Organiser API: `/api/events/[eventId]/submission-shares`

- `GET`: both links for the event, each with kind, enabled, statuses, fields, URL, and last
  changed by and when.
- `PUT {kind, enabled, statuses, fields}`: creates the link on first save (token minted),
  updates it after that. Zod-validated against the catalogue. An unknown field or status is
  a 400, never ignored.
- `POST {kind, action: "regenerate"}`: a new token. The old link 404s immediately.
- **Who:** the same boundary as the CSV export (admins and organisers; `denyReviewer` with
  its route label), with the event resolved through `buildEventAccessWhere`, inside
  `runWithTenant`.
- **Audit:** every save and regenerate writes an AuditLog row (`SUBMISSION_SHARE_UPDATED`
  / `SUBMISSION_SHARE_REGENERATED`) with the before and after field lists. **Switching a
  contact field on is logged at `warn`**, so there is a trail of who published contact
  details.

### 3.4 Public API: `GET /api/public/events/[slug]/shared/[token]`

1. Rate limit per IP (120 per minute, like the public agenda).
2. Resolve the event by slug through `publicEventWhere`. This works for any event status:
   sharing is an explicit organiser act, and abstracts are often reviewed before an event
   is published.
3. Inside `runWithTenant`, load the link by token and assert it belongs to that event. It
   must be enabled.
4. Query with the built `select`, filtered to the link's statuses, ordered by number. Cap
   at 1,000 rows, and say so on the page if the cap is hit.
5. Return the event branding (name, dates, banner, logo), the kind, the visible field keys
   and the projected rows. `Cache-Control: no-store` and `X-Robots-Tag: noindex`.
6. Every refusal is logged (invalid token, disabled, wrong event, rate limited). A disabled
   link and an unknown token return the same 404 "This link is no longer active", so the
   response does not reveal which it was.

### 3.5 Public page: `/e/[slug]/shared/[token]`

- The event banner band, the same as the agenda page. A heading ("Abstracts" or "Session
  proposals"), a count, and "Updated live".
- A search box (title, author, theme) and a theme filter, both in the browser.
- One card per submission: number, title, the enabled fields, and the text collapsed to
  four lines with "Read more". Text is plain and rendered with preserved line breaks, never
  as HTML.
- It refreshes every 60 seconds while the tab is visible. That is what makes it "live".
- `noindex` metadata, and a print-friendly layout.
- A switched-off or regenerated link shows one plain message, "This link is no longer
  active. Ask the organiser for a new one."

### 3.6 Organiser UI: a "Share" button on the Abstracts and Session proposals pages

It sits beside Export and opens a dialog:

- An on/off switch for the link, the URL with Copy and Open buttons, and Regenerate (with
  a confirm: "Anyone using the old link loses access").
- **Statuses:** checkboxes.
- **Fields:** checkboxes in two groups:
  - "Submission": the text, theme, type and so on;
  - "People": names and affiliations.
- A separate **"Contact details"** group, collapsed and marked in amber. Ticking one asks
  for confirmation: "Everyone with this link will see these email addresses or phone
  numbers."
- A live preview line: "Viewers will see N submissions with: Title, Abstract text, Theme..."
- Saves with a toast. Hidden from MEMBER, ONSITE and WEBINARS, like Export.

The CSV and Word exports are unchanged. They still carry every column.

## 4. Security notes

- The token is 256 bits of randomness. Guessing it is not a practical attack. Forwarding is
  the practical risk, and the answer to it is the switch and Regenerate.
- A hidden field is excluded at the query, so no client-side switch can reveal it.
- Reviewer data (scores, comments, reviewer names) is not in the catalogue. The public
  select cannot name it.
- An old link stops working the moment it is switched off or regenerated: responses are
  `no-store`, so no proxy can keep serving a withdrawn link.
- The page sets `referrer: no-referrer`, so the token never leaves in a Referer header.
- This is personal data published by the organiser's choice. The GDPR backlog item
  "privacy notice" should mention that submitted abstracts may be shared with committees.
  That is a note for the backlog, not a blocker.

## 5. Tests and checks

- **Unit (pure module):**
  - every catalogue default;
  - the projection returns no key that is not enabled (a table test over every field);
  - DRAFT and WITHDRAWN are dropped;
  - unknown keys are rejected.
- **Organiser route:**
  - role matrix (ADMIN and ORGANIZER yes; MEMBER, ONSITE, WEBINARS, REVIEWER no);
  - another organisation's event gives 404;
  - validation 400s;
  - Regenerate kills the old token;
  - audit rows written, and a contact field enabled logs at warn.
- **Public route:**
  - invalid, disabled and wrong-event tokens all give the same 404;
  - a contact field is absent from the JSON when off and present when on;
  - the status filter holds;
  - rate limit.
- **Mutation checks:** remove the projection filter, the status filter or the enabled check,
  and a test must fail each time.
- **Browser (headed, standalone :3199 on the test DB):** set up a link, open it in a private
  window, toggle fields and watch the page change, regenerate and watch the old link die,
  check the network response has no email.
- **Gates:** `tsc`, lint, full vitest, and the 13 CI guard scripts.

## 6. Files

- **New:**
  - migration `2026092912xxxx_add_submission_share_link`;
  - `prisma/rls/submissionshare.sql`;
  - `src/lib/submission-share.ts`;
  - `src/app/api/events/[eventId]/submission-shares/route.ts`;
  - `src/app/api/public/events/[slug]/shared/[token]/route.ts`;
  - `src/app/e/[slug]/shared/[token]/page.tsx` and its `layout.tsx`;
  - `src/components/submissions/share-dialog.tsx`;
  - tests.
- **Changed:**
  - `prisma/models/program.prisma` (model and enum) and `core.prisma` (the Event back-relation);
  - the two dashboard pages (the Share button);
  - `use-api.ts` (hooks);
  - the user guide;
  - CHANGELOG.

## 7. Effort and rollout

- About 1.5 to 2 days including verification.
- Ships dark in practice: nothing is shared until an organiser creates a link.
- Rollback: turn links off. The table can stay.

## 8. Plan review (Sep 29, 2026, before build)

- **Cache contradicted the kill switch.** The draft said `s-maxage=60`, which would let a
  proxy keep serving a withdrawn link for a minute. Changed to `no-store`; the rate limit
  carries the load.
- **Row cap too high.** 2,000 abstracts at ~3,000 characters is ~6 MB per refresh. Lowered
  to 1,000; pagination is the follow-up if an event ever exceeds it.
- **Token leakage by Referer.** Added `no-referrer` on the page.
- **"Select built from fields" simplified.** Prisma's typed select makes a fully dynamic
  select brittle. The contact columns (the only sensitive ones) are selected ONLY when
  enabled; the rest is a fixed non-sensitive select, then projected. Same guarantee for
  the data that matters, far less code to get wrong.
- **Theme filter follows the theme field.** If the organiser hides the theme, the filter
  is hidden too, or it would reveal the hidden value.

## 9. Left out on purpose (v1)

- A passcode or an expiry date. Can be added to the table later if a link gets forwarded
  too widely.
- A per-viewer analytics list, or who opened the link.
- Downloads from the shared page (CSV or Word). Viewers read; the export stays staff-only.
- Showing attached files or photos.
