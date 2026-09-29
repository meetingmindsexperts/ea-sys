# Shared registration views: named, read-only links to a filtered list of registrations

Status: BUILT (Sep 29, 2026), not yet deployed. Follows the abstracts and session proposals
share page (`docs/SUBMISSION_SHARE_PLAN.md`, shipped `7f319d28`) and reuses its machinery.

Owner request: "can we do the same for registration?" Viewers are internal staff: "some
staff see only numbers and names, some see promo codes and companies with name and
organisation, some see email, phone, country but not amounts; fully customizable, 3 to 4
links controlled by the organiser."

## 1. Owner decisions (Sep 29, 2026)

| # | Question | Ruling |
|---|---|---|
| R1 | Who opens a link? | Internal staff, with different views for different people. The organiser makes several named links per event. |
| R2 | Which fields may ever be shown? | The **safe set** only. Name, organisation, job title, country, specialty, registration type, status, checked in, promo code, sponsor; contact details (email, additional email, phone) off by default behind the same confirmation as abstracts. **Never:** amounts, payment status, billing, invoices, discounts, documents, barcodes, notes, dietary, custom fields, UTM or referrer. |
| R3 | Do these staff have accounts? | **Mixed.** Links serve the staff without accounts. For account holders a link is a focused view, not a restriction (a MEMBER already sees every registration in the dashboard). Restricting what a signed-in person sees is the Custom Roles plan, which stays a separate, later job. |

## 2. Should we build it? The manual alternative

- **Manual path:** export the registrations CSV, delete the columns, send one file per team.
  That is fine for a one-off hand-over. It is stale at once, it carries every column until
  someone deletes them correctly, and it cannot be withdrawn.
- **Why build:** the teams described need a current list for weeks before the event, each
  with a different cut of it, and the cut is enforced by the server.
- **Performance cost:** one indexed query per page view (registrations by event and status
  are already indexed), capped at 5,000 rows of short text (about 1.5 MB at the cap),
  polling every 60 seconds per open tab, rate-limited per IP. No email, no worker job.

## 3. What gets built

### 3.1 Data: a new table, not more rows in the shipped one

```prisma
model RegistrationShareLink {
  id             String    @id @default(cuid())
  eventId        String
  organizationId String?   // stamped from Event; RLS policied
  label          String    // "Front desk", "Sponsorship team"; unique per event
  token          String    @unique
  enabled        Boolean   @default(true)
  expiresAt      DateTime? // optional; after it the link answers like a switched-off one
  statuses       String[]  // registration statuses shown
  fields         String[]  // optional fields shown
  ticketTypeIds  String[]  // empty = every registration type
  sponsorIds     String[]  // empty = no sponsor filter
  promoCodeIds   String[]  // empty = no promo code filter
  includeFaculty Boolean   @default(false)
  createdById    String
  updatedById    String
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  event Event @relation(fields: [eventId], references: [id], onDelete: Cascade)

  @@unique([eventId, label])
  @@index([eventId])
  @@index([organizationId])
}
```

- **Why a new table, not a third kind in `SubmissionShareLink`:**
  - That table allows one link per kind per event (`@@unique([eventId, kind])`), and
    registrations need several.
  - Changing that unique index, or adding an enum value, while the old slot is still
    serving is a blue/green hazard. An old Prisma client that reads a row with an unknown
    enum value throws.
  - Registrations also need row filters (type, sponsor, promo code) that abstracts do not.
  - A second table is additive and touches nothing that shipped.
- **Shared, not duplicated:**
  - Both tables use the same public URL shape `/e/<slug>/shared/<token>`. The public route
    looks the token up in both.
  - The token minting, the "same 404 for every refusal" rule and the audit helper move into
    one module that both callers use.
- Migration: `CREATE TABLE IF NOT EXISTS`, idempotent. RLS: add the flat policy to
  `prisma/rls/submissionshare.sql`.
- **As built:** the write side is a service (`src/services/registration-share-service.ts`);
  the shared event lookup and token minting are `src/lib/share-link-access.ts` and
  `src/lib/share-token.ts`; the public page is split into a shell and one view per kind
  under `src/components/public/shared-view/`. Totals are computed over the rows returned
  (up to the 5,000 cap), so on a truncated list they cover the first 5,000.

### 3.2 The field catalogue: `src/lib/registration-share.ts`

**Always shown:** registration number (001) and name. A list of nameless numbers is what the
counts strip below is for.

**Summary strip (always):** totals of the rows the link can see, by registration type and by
status, and how many are checked in. This is the "numbers" view: a link with no optional
field switched on reads as a headcount plus a name list.

| Field | Group | Default |
|---|---|---|
| Organisation | People | on |
| Job title | People | off |
| Country | People | on |
| Specialty | People | off |
| Registration type | Registration | on |
| Attendance (in person / virtual; hybrid events) | Registration | off |
| Status | Registration | off |
| Checked in (and when) | Registration | off |
| Registered date | Registration | off |
| Promo code used | Registration | off |
| Sponsor | Registration | off |
| **Email** | Contact | **off** |
| **Additional email** | Contact | **off** |
| **Phone** | Contact | **off** |

Not in the catalogue, so no configuration can show them: every amount (price, discount,
refunded), payment status, billing fields, invoices, supporting documents, QR and DTCM
barcodes, notes, dietary requirements, custom fields, UTM and referrer, the linked account.

**Row filters (per link):**
- **Statuses:** Confirmed, Checked in, Pending, Waitlisted, Cancelled. The default is
  Confirmed and Checked in.
- **Registration types:** any subset; none means all.
- **Sponsors:** any subset. This is the "sponsorship team" cut. It uses the same
  three-way rule as the Registrations page's sponsor filter: tagged to the sponsor, used
  the sponsor's promo code, or belongs to a group that used it. (The first draft matched
  only the tag, which missed most of a sponsor's delegates; caught in review.)
- **Promo codes:** any subset, matched on the registration's own code or its group's.
- **Include faculty:** off by default. Speaker companion registrations are left out, as in
  every delegate count.

### 3.3 Organiser API: `/api/events/[eventId]/registration-shares`

- `GET`: every link for the event (label, settings, path, expiry, last changed by).
- `POST {label, …settings}`: create. Refused past **10 links** per event, which is ample for
  "3 to 4".
- `PUT /[linkId] {…settings}`: update.
- `POST /[linkId]/regenerate`: new token.
- `DELETE /[linkId]`: remove.
- The same boundary, logging and audit as the abstracts routes. Filters are validated
  against the event: an unknown type, sponsor or promo code id is a 400, never ignored.

### 3.4 Public side: the existing route and page, extended

- `GET /api/public/events/[slug]/shared/[token]` finds the token in either table.
- For a registration link it checks, in this order: same event, same tenant, enabled, not
  expired. It then queries with the link's filters, selects the contact columns only when
  they are switched on, projects each row, and returns the summary counts.
- The page gets a registrations layout, built for scanning many short rows (hundreds of
  them) rather than reading a few long ones:
  - the counts strip;
  - search;
  - a registration type filter (shown only when the type field is on);
  - a compact table on desktop that turns into cards on a phone;
  - print.
- An expired link shows the same "no longer active" message.

### 3.5 Organiser UI: "Shared views" on the Registrations page

- The Registrations page already has a **Share Link** button: it copies the public
  **registration form** address. A second "Share" would be confused with it, so this one is
  called **Shared views**. It is hidden from roles that cannot manage registrations.
- It opens a dialog listing the event's links:
  - each row shows the label, the status (on, off or expired), the row count, and Copy,
    Open and Edit;
  - a **New view** button.
- The editor has the same sections as the abstracts dialog: statuses, filters, fields, and
  the amber contact box with its confirmation. It adds a label field and an optional
  **Expires on** date.
- Presets to start from, which set the fields and can then be edited:
  - **Names and numbers:** name only, with the counts strip.
  - **Companies and promo codes:** organisation, sponsor, promo code, type.
  - **Contact list:** email, phone, country. This one asks for the confirmation.

## 4. Security notes

- The same guarantees as the abstracts page: 256-bit token, the server leaves out fields
  and rows the link does not allow, `no-store`, `noindex`, `no-referrer`, and identical 404s.
- Forwarding is the real risk, and it grows with contact details switched on. The answers
  to it:
  - the expiry date;
  - the switch and New view;
  - an audit row on every change, and a warning log whenever contact details are switched on.
- **Personal data:** attendees did not sign up to be listed. Internal use is the stated
  purpose. The GDPR backlog's privacy-notice item should say that registration details are
  shared with staff and partners involved in running the event. Noted there, not a blocker.
- A link is not access control for account holders (R3). The user guide says so plainly,
  so nobody reads a link as a restriction.

## 5. Tests and checks

- **Unit:**
  - the catalogue has no amount, payment, billing, document, barcode or dietary key;
  - each field writes only its own key;
  - every filter is honoured, and faculty is excluded by default;
  - expiry is enforced.
- **Routes:**
  - role matrix;
  - another organisation's event gives 404;
  - an unknown filter id gives 400;
  - the 10-link limit;
  - label is unique;
  - regenerate kills the old token, and delete removes the link;
  - every refusal gives the same 404, expired included;
  - a contact field gives a warning log and an audit row.
- **Mutation checks** on the field filter, the row filter, the expiry and the role guard.
- **Browser (headed, :3199 on the test DB):** create three views from the presets, open each
  in a private window, check the network response for the absent fields, let one expire,
  and check the layout at phone width.
- **Gates:** `tsc`, lint, full vitest, and the 13 guard scripts.

## 6. Effort and rollout

- About 1.5 days including verification. The public route, the page shell, the token and
  audit handling, and the dialog patterns already exist.
- Nothing is shared until an organiser creates a view.
- The table is additive. Rollback is switching views off.

## 7. Left out on purpose

- **Restricting what signed-in staff see** belongs to Custom Roles (`docs/CUSTOM_ROLES_PLAN.md`),
  planned separately.
- CSV download from a shared view. Viewers read; export stays staff-only.
- Payment status. It isn't an amount, but it is finance data under the owner's "not amounts"
  intent. It can be added later as an explicit ruling.
- Per-viewer tracking of who opened a link.
