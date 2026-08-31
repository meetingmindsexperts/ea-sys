# EA-SYS — Product Roadmap & Project Status

**Project:** EA-SYS (Event Administration System)
**Owner:** MeetingMinds Group
**Last Updated:** August 21, 2026
**Platform URL:** events.meetingmindsgroup.com

---

## ~~nginx maintenance page~~ ✅ SHIPPED Aug 21 2026 — [deploy/maintenance/](../deploy/maintenance/)

When the app upstream is unreachable, nginx returns its own bare
`502 Bad Gateway / nginx/1.24.0 (Ubuntu)`. Every visitor saw that for ~90 seconds
during the EBS encryption window, and it is what a crash or a failed deploy shows
too.

Two problems: it reads as **broken** rather than "briefly down", and it discloses
the server and version.

**Shape of the fix.** A static page served by nginx via `error_page 502 503 504`,
returned as **`503` with `Retry-After`**, not `200`. The status code is the part
worth getting right: a `200` would tell crawlers the page is genuinely that
content, and would make Uptime Robot believe the site is healthy while it is
down. It must need no application to render — that is the entire point.

**Note before editing.** The live nginx config on the box has diverged from
`deploy/nginx.conf` (Certbot rewrote it), so **the box is the source of truth**
and `deploy/nginx.live-snapshot.conf` must be refreshed alongside any change, or
FROM_SCRATCH_REBUILD loses it. Done for this change — the snapshot was refreshed
**from** the box after the reload, not before.

**Residual, deliberately accepted:** the server-level `error_page` also covers
`location /stream/`, so a MediaMTX outage shows the maintenance page for HLS
segments rather than a raw 502. Better for a viewer, and the player's failover
keys on the request failing rather than on a specific status.

---

## Executive Summary

EA-SYS is a purpose-built, full-stack event management platform developed in-house for MeetingMinds Group. It replaces fragmented third-party tools (EventsAir, spreadsheets, manual email workflows) with a single, integrated system that the organization fully owns and controls.

The platform handles the entire event lifecycle — from public registration and payment collection through speaker management, abstract peer review, accommodation booking, on-site check-in, and post-event communications — all under one roof with a consistent, branded experience.

**Built with:** Next.js 16, TypeScript, PostgreSQL, Prisma ORM, Stripe, Claude AI (Anthropic)
**Deployed on:** AWS EC2 (t3.large) via Docker with zero-downtime blue-green deployments

---

## Platform Highlights

| Capability | Description |
|---|---|
| **Self-Service Registration** | Attendees register, pay, and manage their own details online — no manual data entry for staff |
| **Stripe Payment Processing** | Secure online payments with tax calculation, PDF invoices, and refund management |
| **Abstract Submission & Peer Review** | Full academic paper submission workflow with weighted scoring, reviewer portal, and automated notifications |
| **AI Event Assistant** | Natural language commands ("add Dr. Smith as a speaker for the morning session") handled automatically by Claude AI |
| **On-Site Operations** | Mobile QR/barcode check-in scanner, badge PDF printing, real-time attendance tracking |
| **Organization CRM** | 100,000-contact store with event history, CSV import/export, and one-click import into events |

---

## Completed Features by Phase

### Phase 1 — Foundation
*Delivered: January 2026*

- PostgreSQL database with Prisma ORM
- Secure JWT-based authentication (NextAuth.js)
- Role-based access control (7 roles: Super Admin, Admin, Organizer, Member, Reviewer, Submitter, Registrant)
- Multi-tenant organization support
- Collapsible dashboard sidebar with persistent state
- Structured logging system (Pino) with log viewer at `/logs`
- Audit logging for all admin actions

---

### Phase 2 — Event Core
*Delivered: January–February 2026*

**Event Management**
- Create, edit, publish, and manage events (Conference / Webinar / Hybrid)
- Event status lifecycle: Draft → Published → Live → Completed → Cancelled
- Per-event settings: branding, email sender, tax rates, badge layout

**Ticketing**
- Multiple registration types per event (e.g. Early Bird, Standard, Presenter, Student)
- Pricing tiers with date-based activation (Early Bird cutoffs)
- Sold count tracking and capacity limits

**Registrations**
- Admin-side registration management with search, filter, and CSV export
- Bulk registration type changes
- Registration detail slide-out with full edit capability
- Delete registration with attendee cleanup

**Check-In & Badges**
- Mobile QR code scanner (camera-based, web app — no app install required)
- Hardware barcode scanner support (auto-focused input)
- DTCM barcode import via CSV
- Badge PDF generation (server-side, Code128 barcodes, per-event vertical offset)
- Real-time attendance counter and recent scan log

---

### Phase 3 — Speaker & Program Management
*Delivered: February 2026*

**Speakers**
- Speaker profiles with photo, bio, social links, specialty, and status tracking
- Import speakers from event registrations or organization contact store
- Speaker status workflow: Invited → Confirmed → Declined → Cancelled
- Full speaker detail page with sessions and abstracts list

**Schedule**
- Color-coded track management
- Session scheduling with date validation against event dates
- Session roles: Speaker, Moderator, Chairperson, Panelist
- Per-topic speaker assignment within sessions
- Calendar view and date-grouped schedule view

**Abstract Submission & Review**
- Public submitter registration with event-scoped account creation
- Full-page abstract submission form (title, content, theme, presentation type, specialty)
- Presentation types: Oral, Poster, Video, Workshop
- Abstract status workflow: Draft → Submitted → Under Review → Accepted / Rejected / Revision Requested / Withdrawn
- Event-specific abstract themes (organizer-configured)
- Weighted review criteria per event (weights must sum to 100%)
- Reviewer portal: score, comment, recommend format, accept/reject
- Automated email notifications on status change and reviewer feedback
- Bulk email to abstract submitters (accepted, rejected, revision, reminder, custom)

---

### Phase 4 — Accommodation Management
*Delivered: February 2026*

- Hotel management with star rating and contact details
- Room type configuration with pricing and amenities
- Accommodation bookings linked to registrations
- Booking status: Pending → Confirmed → Checked In → Checked Out → Cancelled

---

### Phase 5 — Payments
*Delivered: March 2026*

- Stripe Checkout integration for paid ticket types
- Per-event tax rate and label configuration (e.g. "VAT 5%")
- Base price + tax as separate Stripe line items
- PDF invoice / proforma quote attached to confirmation email and downloadable from registrant portal
- Payment webhook handling: `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`, `payment_intent.payment_failed`
- Full refund processing (admin-initiated via Stripe API; refund confirmation email)
- Complimentary registration status (admin-set; bypasses payment gate at check-in)
- Zero-decimal currency support (JPY, KRW, etc.)
- Payment status: Unpaid, Pending, Paid, Complimentary, Refunded, Failed

---

### Phase 6 — Email & Communications
*Delivered: February–March 2026*

- Dual email provider support: Brevo and SendGrid (switch via environment variable, no code change)
- Per-event sender email address and display name
- WYSIWYG email template editor (Tiptap v2) with toolbar, layout blocks (2-col, 3-col, CTA, divider), and HTML source toggle
- Email branding: per-event header image and footer HTML
- CSS inlining for email client compatibility
- Desktop/mobile preview for all templates
- Centralized Communications page consolidating all event email types in one place
- Bulk email to selected or all registrations / abstract submitters
- Automated emails: registration confirmation, payment confirmation, refund confirmation, abstract status changes, reviewer invitations, team member invitations

---

### Phase 7 — Public-Facing Pages
*Delivered: February–March 2026*

- **Public registration form** at `/e/[slug]` — smart redirect to first active pricing tier
- 2-step registration flow: account creation (email + password) → personal details + T&C
- Customizable welcome HTML and terms & conditions per event (WYSIWYG)
- Terms accepted timestamp recorded on submission
- Conditional fields: member ID required for member ticket types, student ID + expiry for student types
- **Registrant self-service portal** at `/my-registration` — view registrations, edit personal details, pay online, download invoice
- **Event-scoped login** at `/e/[slug]/login` with event branding
- **Abstract submitter registration** at `/e/[slug]/abstract/register` (separate from attendee registration)
- **Registration completion form** at `/e/[slug]/complete-registration` — token-gated form for CSV-imported registrants
- **Confirmation page** with payment status polling and Pay Now button

---

### Phase 8 — Contact Store (Organization CRM)
*Delivered: February 2026*

- Organization-wide contact database supporting up to 100,000 contacts
- Searchable by name, email, and organization
- Tag-based filtering with colored tag pills
- CSV bulk import (RFC 4180 compliant, skip duplicates, up to 5,000 rows per file)
- CSV export for all organization contacts
- Contact detail page with full event history (appearances as speaker or attendee)
- One-click import of contacts into event registrations or speakers
- Auto-sync: attendee and speaker data automatically synced back to the contact store after registration and speaker import
- Contact fields: title, photo, organization, job title, phone, city, state, zip, country, specialty, registration type, member ID, student ID, notes, tags

---

### Phase 9 — Media & Content
*Delivered: March–April 2026*

- **Organization media library** — upload JPEG/PNG/WebP images (2MB limit, magic-byte validated) for use in email templates
- **Event-scoped media library** — per-event image management with drag-and-drop upload and URL copy
- Local filesystem storage (default) with Supabase Storage as drop-in alternative
- Standalone content editor page for registration welcome HTML and abstract welcome HTML
- WYSIWYG editors throughout: email templates, event footers, registration terms, welcome messages

---

### Phase 10 — AI Event Assistant
*Delivered: April 2026*

- Natural language event management at `/events/[eventId]/agent`
- Powered by Anthropic Claude API with tool-use (agentic loop)
- Supported actions: list event info, manage tracks, manage speakers, view registrations, manage sessions, manage ticket types, send bulk email
- AI output rendered as formatted HTML with markdown support
- Streams progress to browser in real time via Server-Sent Events
- Rate limited: 20 requests/hour per user, 10 bulk emails/hour per event
- Access restricted to Admin and Organizer roles
- `paymentStatus` filter available: query "show me all paid registrations"

---

## Feature Timeline

| Month | Key Milestones |
|---|---|
| **January 2026** | Platform foundation, authentication, RBAC, dashboard UI, event management, ticket types |
| **February 2026** | Registration management, check-in scanner, badge printing, speaker management, schedule/calendar, abstract submission and review, accommodation management, contact store (CRM), photo uploads, country/city fields, reviewer portal, reviewer invitation system |
| **March 2026** | Stripe payments, tax configuration, PDF invoices, public registration (2-step), registrant self-service portal, event-scoped login, WYSIWYG email editor, email branding, centralized communications page, bulk email, SendGrid integration, session topics with per-topic speakers, session roles, org primary color theming, complimentary payment status, barcode system overhaul, badge type support, payment-gated check-in, signup notifications, state/zip fields, terms acceptance timestamp, CSV import → registration completion flow |
| **April 2026** | AI event assistant (Claude), event-scoped media library, Stripe refunds, abstract expansion (Video/Workshop types, Withdrawn status, recommended format), weighted review criteria, abstract themes, MEMBER role (read-only), sidebar reorganization, markdown rendering for AI output |

---

## Deferred review findings

### HR module review (Aug 31, 2026): highs shipped as batch 1, the rest recorded here

First adversarial review of the HR module (security/tenancy/privacy · correctness/maths/concurrency ·
UI/drift/tests): **0 BLOCKER / 6 HIGH / 14 MED / 13 LOW**. Full report, with the reproduced numbers and a
"what to learn" box per finding: [docs/CODE_REVIEW_HR.html](CODE_REVIEW_HR.html).

**Shipped, batch 1 (same day):**
- **✅ H1**: a year the person was not employed in summed their ENTIRE history against a fresh 30 (a 2025 leaver
  showed entitlement 30, taken 5, balance 29 on the 2026 "Show leavers" view). The engine now returns
  `employedInYear: false` with zeros, and the summary says "Not employed in {year}".
- **✅ H2**: the first-year gate was judged at today, so an 11-month leaver flipped from 0 to 30 the day the
  calendar passed the anniversary they never reached. Now judged at the earlier of today and the exit date.
- **✅ H4**: the grid's key handler ignored modifiers, so Cmd+C wrote comp-off, Cmd+A annual leave, Cmd+S sick
  leave, Cmd+W work-from-home as the tab closed. Modifiers and key repeat are refused; `apply()` is single-flight.
- **✅ H5**: clearing was an unbounded, unthrottled hard delete audited by count; an overwrite recorded only the
  new code and wiped the remark. Clear now has the 366-day cap and the write rate bucket; both write and clear
  snapshot the previous code of every affected day onto the audit row; remarks are touched only when supplied.
- **✅ H3**: an explicit AL range charged every calendar day while a Company-day RULE carrying AL charged
  working days only, so a two-week shutdown cost 12 from the grid and 10 as a rule. Owner ruling: calendar days
  everywhere. A rule whose code covers calendar days now beats the holiday and the weekend in the resolver (a WFH
  rule still stops at working days); the docs, dialog copy and user guide say so.

**Needs an owner ruling before code (M9):**

| # | Sev | Finding |
|---|-----|---------|
| M9 | MED | **Rule precedence.** An EMPLOYEE standing WFH rule exempts that person from an ORG AL shutdown (pinned by test); defensible if a shutdown means "the office is unavailable", not if it means "the company is on leave". Within one scope the comment says "most recent decision wins" but the code compares start dates, so an older WFH rule beats a newer AL rule on their overlap, and overlaps are never surfaced at create. |

- **✅ H6**: 1 January 2027 was a cliff: `LeaveGrant` was never read or written and the go-live seeds applied to
  every year. Owner decision: the seed year lives on the row (`Employee.seedLeaveYear`, additive migration,
  backfilled from `createdAt`). The seeds now count in that year only; `leave-year-roll-service.ts` writes one
  grant per employee from `planYearRoll`; both balance paths read the grant; the `hr-year-roll` worker job (1018)
  runs it nightly through January; `POST /api/hr/leave-year/roll` + a summary-page button re-run it later.

**Deferred MEDs:**

| # | Sev | Finding |
|---|-----|---------|
| M1 | MED | Leavers vanish from the attendance grid (`useHrEmployees()` defaults to active only), so notice-period leave cannot be entered and past months cannot be corrected; the "records" tile still counts their entries. Fix: fetch leavers and filter rows to those whose employment overlaps the visible month. |
| M2 | MED | `status` and `exitDate` are independently editable and the two halves read different fields: RESIGNED with no date is employed forever for the balance engine and hidden from every list; POST accepts `status` and drops it. Enforce the pair in `updateEmployee`; drop `status` from the create schema. |
| M3 | MED | Moving `joiningDate` later or `exitDate` earlier strands recorded leave: hidden in the grid (NOT_EMPLOYED beats an explicit entry), excluded from the balance, rows still in the table, no warning. Count entries outside the resulting window and refuse, or require an explicit force recorded in the audit. |
| M4 | MED | `?year=` on the summary and balance APIs returns figures labelled with a year they were not computed for (`asOf` is always today). The UI never sends it. Clamp `asOf` to the year end and refuse years with no grant once H6 ships. |
| M5 | MED | `POST /api/hr/employees` links any `userId` with no org or existence check (global unique: a cross-tenant squat and an existence oracle on the platform; P2003 becomes a paging 500), cannot be unlinked (no `userId` on PATCH), and nothing reads the column. Verify the user is in the org; allow null on PATCH. |
| M6 | MED | `updateEmployee` writes by bare id; its own comment claims the org binding is "part of the write". Not exploitable today; the harness has no defence-#1-in-isolation assertion for it. `updateMany({ where: { id, organizationId } })` plus the assertion. |
| M7 | MED | Employee edits persist the full before/after view, free-text `notes` included, into `AuditLog` (no prune) on every save; rule creation audits the free-text label; rule deletion audits nothing about the rule. Field-level diff with `notes`/`label` redacted; snapshot the rule inside the delete transaction. |
| M8 | MED | Public holidays: POST has no audit and no rate limit, there is no DELETE or edit route, no UI calls the POST, 2027 is unseeded. Audit + limit the POST, add DELETE (refused while referenced), a settings screen. |
| M10 | MED | `apply()` partial failure loses the selection with no summary and no employee name; each of N mutations invalidates every HR query (a 23-row drag is ~69 refetches). Warn with counts, keep the selection, invalidate once. |
| M11 | MED | Comp-off is bounded by `asOf` while annual is not, so a comp-off booked for next week is invisible until then. Bound by the employment window only. |
| M12 | MED | A full-year range is up to 366 sequential upserts in one interactive transaction with Prisma's default 5 s timeout; the largest legitimate range is the one most likely to fail as `UNKNOWN`. Longer timeout or one `deleteMany` + `createMany`; map P2028 to its own code. |
| M13 | MED | The code popover is `absolute` in an unpositioned tree with a dead `window.scrollY` term: correct at open, pinned while `<main>` scrolls under it, can overflow at the bottom. Worth a browser check; `position: fixed` with a clamped `top`. |
| M14 | MED | No route-level test for any HR route; the source-grep adoption guards pass an `explicitDates: new Set()` mutation; the flag-off 404 is not pinned for a non-HR role; no e2e spec. |

**Deferred LOWs (L1–L13, detail in the report):** the `module-flags.ts` proxy-redirect claim is false and `/hr` is not in the matcher (no server page gate); the grid's UTC "today", hardcoded Sat/Sun header and duplicated date helpers; an impossible-but-well-formed date on the attendance GET 500s and pages; `check-tenant-als.sh` `SWEPT_MODELS` lacks the six HR models; uneven rate limits and log fields; `openingSickUsed` above 15 has no waterfall and no warnings exist; OD on a public holiday earns no comp-off despite the seeded label; row-index selection and mouse-only drag; accessibility of the cells and dark-mode variants on the error cards; the sidebar's duplicated `HR_ROLES`; pre-existing org-level reads (`GET /api/organization` returns the raw org row including the settings blob, `GET /api/organization/users` gates only on org membership, `POST /api/upload/photo` has no role guard); `Number(x) || 0` zeroing cleared fields; `HTTP_STATUS_FOR_EMPLOYEE_ERROR` exported from a `route.ts`.

### DTCM spare pool — deferred findings (Aug 26, 2026)

The pool is complete end to end: codes can be imported, are claimed
automatically on every ordinary create path, the level is visible above the
registrations list, and an empty pool warns at the counter. These are the
findings from the build review that were recorded rather than fixed. **None
blocks a Dubai event**, and each is independently shippable.

| # | Sev | Finding |
|---|-----|---------|
| D-1 | HIGH | **Three create paths never ask for a code.** `claimSpareDtcmCode` is wired into `registration-service` (REST + MCP single-create) and the public register route. It is NOT wired into **group registration**, **MCP `create_registrations_bulk`**, or the **speaker-companion** helper. So a company registering 12 people on a Dubai event, an agent-driven bulk import, and every faculty member get no compliance code and their badges print without a QR — silently, because the walk-up warning only fires on the two paths that were wired. The claim is one awaited call that never throws, so each is a small edit; the reason to think before doing all three at once is that bulk paths want ONE pool read for N registrations rather than N reads, which is the same work as D-3. |
| D-2 | MED | **Only the first 10 spares are attempted, and every caller starts at `spares[0]`.** `MAX_CLAIM_ATTEMPTS = 10` bounds the P2002 retry loop, but the candidate list is ordered deterministically (oldest import, then code) and every concurrent claimant walks it from the same end — so under real desk contention several stations collide on the same first codes rather than spreading out. Two stations is fine; four at 8am on day one would start burning attempts. Cheapest fix is to start each caller at a random offset into the spare list, which costs nothing and makes collisions rare instead of systematic. |
| D-3 | MED | **The availability read is two full scans, on the public register hot path.** Deriving availability is the right call (see the module docblock for why a stored flag is worse), but the implementation reads EVERY pool row and EVERY coded registration on the event, twice per claim, and the public register route is one of the callers. At current scale — a few thousand codes, a handful of registrations a minute — this is comfortably cheap and measurably so. It stops being cheap at a scale this feature does not have. The fix when it matters is a covering index plus a windowed read (`take` a page of candidates rather than the whole set), **not** a stored flag. |
| D-4 | MED | **A cancelled registration holds its code forever.** Cancelling releases the seat and the promo usage; it does not release the DTCM code, so the pool counts it as assigned permanently. On an event with heavy churn that quietly shrinks the spare pool with no way to reclaim. Deliberately not automatic: the code may already be printed on a badge in someone's pocket, and reclaiming it would hand a live credential to a second person. The right shape is an organiser-visible "N codes held by cancelled registrations — release them?" action, not a cascade. |
| D-5 | LOW | **The pool-empty warn is unlatched.** Every walk-up against an empty pool logs `dtcm-pool:empty` at warn, so a busy morning with no codes left writes one line per registration into `SystemLog` and feeds the SES alert path. Same class as the analytics no-secret alarm latched on Aug 20: the thousandth copy of a sentence adds nothing and buries `/logs`. Latch it per event per container. |
| D-6 | LOW | **Nothing surfaces the pool outside the registrations page.** The check-in page and the kiosk both consume codes indirectly and show nothing; an organiser looking at the event dashboard cannot see the level at all. Low value while the desk lives on the registrations page, worth revisiting if the check-in page becomes the day-one home screen. |

### Session revocation — deliberate carry-overs (Aug 25, 2026)

Web and mobile session revocation both work now (see SESSION_ARCHITECTURE §6).
These are the two things sized and deliberately not built.

| # | Sev | Finding |
|---|-----|---------|
| S-1 | MED | **Rotating `NEXTAUTH_SECRET` irreversibly breaks every outstanding hashed token.** `hashVerificationToken` peppers with that secret and the resulting hashes are **stored**, so a rotation invalidates every live password-reset, email-verification, team-invitation, survey, RSVP, speaker-agreement, presenter-agreement and reimbursement link with no way to re-derive them. `NEXTAUTH_SECRET_FALLBACK` exists but is only honoured by `eventsair-client.ts` for credential *decryption*, not here. **Sized and declined:** the fix is a `verificationTokenHashCandidates(raw): string[]` helper returning `[primary]` or `[primary, fallback]`, consumed as `{ tokenHash: { in: candidates } }` so it stays one query — but that is ~13 call sites across 8 files, for a once-ever break-glass action whose consequence is "everyone with a live link needs a new one", which is recoverable and arguably expected after a master-secret rotation. **Build it only if a zero-disruption rotation is ever a requirement.** Until then the consequence belongs in the rotation runbook, not in code. |
| S-2 | LOW | **A stolen mobile ACCESS token stays usable for its full 24h.** `api-auth.ts` verifies it by signature alone with no database read, so deactivation and revocation do not reach it. Accepted deliberately and marked with a `ponytail:` comment naming the ceiling: it runs on every mobile API call, and a per-request user lookup to shorten a bounded window is the wrong trade. The window is bounded because both doors that could *extend* it now check. Upgrade paths, in order of cheapness: shorten `ACCESS_TOKEN_MAX_AGE` (one constant, more refresh traffic, but it would break a client that assumes 24h), or put the lookup behind a short in-process cache (the `lobby-status` 3s pattern). Zero mobile logins on prod ever, so there is no live exposure today. |
| S-3 | LOW | **Token theft leaves no trace in Sign-in Activity.** `LoginEvent` records sign-in *attempts*; a stolen token skips login entirely, so the one view built for "is someone in my account" cannot show it. What would show it is `lastSeenAt` activity at implausible hours and the audit trail of actions taken. Worth a line in the incident runbook; a real fix means recording token *use*, not just token issue, which is a different and much noisier dataset. |

### Contacts inbound import — deferred review findings (Aug 18, 2026)

Three-lens adversarial review of the inbound `contacts_centralv1` import, the
do-not-import blocklist, and the tag-filter rework. 0 BLOCKER. Everything HIGH
was fixed in-band (see the CLAUDE.md entry). These are the deliberate carry-overs.

| # | Sev | Finding |
|---|-----|---------|
| C1 | MED | **`GET /api/contacts/tags` is the first `$queryRaw` on a tenant-scoped table.** [db.ts](../src/lib/db.ts) states raw client ops are deliberately NOT wrapped by the tenant extension, so under `RLS_SET_LOCAL=1` the statement runs with no `app.current_org`, the Contact policy fails closed, and the tag filter silently returns `{tags: [], usage: []}` — no error, no log. Not a leak (the explicit `WHERE "organizationId"` holds). Fix: issue it inside `tenantTransaction()`, which does the `SET LOCAL` on the tx backend. **Platform precondition — must be closed before RLS is enabled anywhere real.** |
| C2 | MED | **`check-tenant-als.sh` now passes vacuously on `src/app/api/contacts`.** The gate counts `runWithTenant(` against handler count and separately checks read placement on `SWEPT_MODELS` (`.contact.findMany` etc). Converting that route's only swept model read into `$queryRaw` removed the thing the gate inspects, while the textual `runWithTenant` wrap remains. Fix: extend the gate to flag `$queryRaw`/`$executeRaw` inside swept route dirs. Pairs with C1. |
| C3 | MED | **`getTagColor` is now a 5th copy, and one existing copy already diverges.** Verified: `contacts/[contactId]/page.tsx`, `bulk-tag-dialog.tsx`, `contact-detail-sheet.tsx`, `import-contacts-dialog.tsx` (a 4-colour `bg-blue-100` palette, so the same tag renders a different colour there today), plus `tag-filter-popover.tsx`. The rework relocated the page's copy rather than consolidating. Fix: one `src/lib/tag-colors.ts`, point all five at it. |
| C4 | MED | **Imported tags bypass `normalizeTag`.** Nine in-app write paths Title-Case tags; the import deliberately does not, because the n8n/Webflow tag filter matches case-sensitively. Consequence now visible in the new popover: `"MASH in Focus"` and `"Mash In Focus"` are two rows with two counts filtering to disjoint sets, while `TagInput` hides one as a duplicate. Fix: normalize on import and fix the n8n matcher, or state the split in both the script header and the tags route so nobody "fixes" it by adding `normalizeTag`. |
| C5 | MED | **The documented undo decays with use.** "Delete every Contact tagged `central-import`" is safe at t=0. Once an imported contact registers for an event, `syncToContact` updates that same row with real `eventIds` and history while the tag remains. Fix: state the undo as tagged **AND** `eventIds = []` **AND** `createdAt <= <run time>`, or have the script print its run timestamp. |
| C6 | MED | **No test executes the tags route's SQL output mapping.** `mockDb.$queryRaw` is stubbed to `[]`, so `rows.map`, the `localeCompare` sort and the `Number(r.count)` BigInt conversion never run with data. Fix: stub a two-row result. Related: nothing pins `title: true` in `buildCentralRows`' Prisma select — dropping it silently stops sending titles with no test failing. |
| C7 | LOW | **`NAME_IS_EMAIL` deletes people whose surname field holds their email.** 85 of the 304 had a plausible real given name (e.g. `acweyand@med.umich.edu`, U. Michigan Medicine). Bounded: 0 of the deleted rows had any `eventIds`. The correct action is repairing `lastName`, not deleting. |
| C8 | LOW | **The import cannot carry `title` inbound.** `SELECT_COLS`/`mapRow` in the script omit it while the same change adds it outbound. Harmless today (mirror has 0 non-null titles) but lossy once the reconcile populates them and someone re-runs with `--include-synced`. |
| C9 | LOW | **Offset pagination on a collation-ordered key with no tiebreaker.** `order=email.asc` + `offset` across 57 pages. Postgres guarantees no stable order for collation-equal keys. Fix: keyset-paginate (`email=gt.<last>`). |
| C10 | LOW | **`created` counts rows `skipDuplicates` may have dropped**, so the reported figure can exceed the actual insert count. The `before → after` line is the honest number. |
| C11 | LOW | **The blocklist is not wired into the public registration form**, which the module header names as the door the spam walked in. Only the local script consumes it. Fix: call `screenContact` in the public register + contacts import routes with a logged `warn` on refusal, or soften the header. |
| C12 | LOW | **`emailDomain` is duplicated** between `contact-import-blocklist.ts` and the private one in `internal-domains.ts` (already a documented dependency-free leaf module — the natural home). |
| C13 | LOW | **`sanitizeImportedTag` is exported from a self-executing script**, so it is untestable (importing it runs `main()`) and untested, despite carrying the JSON-blob unwrapping and machine-id rejection logic. Fix: move it beside `screenContact`. |

### Public agenda — the rest of the multi-track proposal (Aug 17, 2026)

Items 1 and 2 of the agenda UX proposal shipped (parallel blocks keyed by hall,
and the day/track tab hierarchy). The remainder was ranked with the owner and
deferred. Grounded in what the real agendas contain, read off production on
2026-08-17: EHSMHC2026 is 2 days / 12 sessions / 3 halls with a clean three-way
parallel block, BHS2026 is 1 day / 15 sessions with a workshop straddling two
consecutive plenary sessions.

**Speaker de-duplication (highest value of what is left).** On BHS, a session
lists five or six speaker chips and then repeats the same people underneath
their own topics. Session V shows Dr Khaled Al Qawasmeh, Dr Mohamed Abuhaleeqa
and Dr Somaya Alnuaimi twice each. The rule: chairs and moderators stay at
session level always; a plain speaker who appears on a topic renders only
against that topic. Session V's chip row drops from five to two and the card
becomes a run-sheet you read down. Small change, entirely in the public agenda
card, no data or API work.

**Add to calendar, per session.** [calendar-links.ts](../src/lib/calendar-links.ts)
already builds Google, Outlook and RFC 5545 ICS links and was written for the
webinar confirmation email, where it encodes everything in UTC so it is
timezone-proof by construction. Reusing it per session on a multi-day
conference is close to free. A whole-day or whole-event `.ics` is the same
work again.

**Live-now marker and auto-scroll on the event day.** High value on site, low
cost. Nothing exists for this today.

**Sticky day and track bar.** On BHS the filters scroll out of view within one
screen and there is no way back without scrolling to the top. On mobile the
same applies to the hall label inside a stacked parallel block: once you scroll
past "WORKSHOP ROOM" there is nothing telling you which column you are in.

**Per-session anchor links** (`#session-<id>`) so an organizer can link one
session from an email. Currently impossible.

**Find a speaker.** A text filter over the day. Dr Maryam Darwish appears in
three sessions on BHS across both halls, and there is no way to answer "where
am I speaking" without reading the whole programme.

**Print the parallel block as a grid.** Print currently stacks the columns
(`print:grid-cols-1`), which is safe but loses the structure at exactly the
moment it matters most, since a printed programme is the artifact people carry
around the venue. A4 portrait with three columns of long titles is the reason
it was not done first.

**Star sessions into a personal agenda**, browser-storage only, no login. The
classic conference-app feature and the largest piece here.

**Two data observations, not code.** All three EHSMHC tracks are the same blue
(`#3B82F6`), so track colour carries no information on that event and the
design deliberately does not depend on it. And `location` duplicates the hall:
it is empty on 11 of 12 EHSMHC sessions, set only on Opening Ceremony, which is
also the one session with no track. Either set the track there and clear the
location, or decide `location` means something finer (a floor, a room number)
and render both.

### ~~Public agenda is 404 for attendees on every event~~ — RESOLVED, deliberate (owner, Aug 18, 2026)

**Owner: "agenda will be open later, nothing for now."** The unpublished state is
intentional while programmes are still being built. Do not re-raise it. The
mechanism below is left recorded because it is the switch to flip when they do
open, and because "the page 404s" reads as a bug to anyone who finds it cold.

Found while setting up the local preview. `GET /api/public/events/[slug]/agenda`
returns 404 `Agenda not published yet` unless `settings.agendaPublished` or
`settings.programmePublished` is true, and neither is set on any of the seven
published events. So `/e/<slug>/agenda` is currently unreachable for the
public everywhere, including EHSMHC2026 and BHS2026.

This may be deliberate (agendas still being built, nothing is missing yet), but
it is worth confirming rather than discovering on the morning of an event. Two
of the seven are inside two months.


### Presenter registration: the sign-in door still sends the delegate email (Aug 11, 2026, DEFERRED by owner)

Recorded when the presenter feature shipped. Deliberately left as-is; not a
defect, an inconsistency worth closing when someone hits it.

**What happens.** There are two abstract doors. `/submitter` creates a new
account and sends a welcome email, so the presenter fee and the quote PDF fold
into that one email (owner decision D7: one email, not two). `/abstract-start`
is the door a returning submitter uses when they already have an account. It
sends no welcome, so `callerSendsFeeEmail` is left unset there and the person
receives the ordinary delegate registration confirmation instead, subject line
`Your registration for X`.

**Why it was not simply suppressed too.** Suppression with nothing behind it
silently drops the quote, which is worse than wrong wording. The flag is
documented on
[registration-service.ts](../src/services/registration-service.ts) as usable
ONLY where the caller sends a replacement.

**Why the wording still grates.** At that moment nothing has been accepted, so
"Your registration for X" reads as a settled place at the event, which is the
same objection that produced D7 for the other door.

**The fix when it is wanted.** Either (a) a dedicated
`presenter-registration-confirmation` system template with presenter wording,
which also gives organizers a fee email they can edit independently, or (b)
a small "here is your presenter fee" send on the sign-in door reusing
`buildPresenterFeeEmailExtras`, which already returns the block, the text
mirror and the attachment. Option (b) is roughly an hour; option (a) adds an
editable template and its preview sample.

**Note the volume is low.** This path only fires for someone who already has an
account on this event AND signs in through the abstract link AND the event has
presenter rates configured.

### Cloning a WEBINAR event produces a broken webinar (Aug 10, 2026, NOT FIXED)

Found while triaging `zoom:webinar-non-anchor-create-refused` in prod. Not
picked for the fix round; recorded here because it sits on a workflow we will
hit.

**The defect.** [clone/route.ts](../src/app/api/events/%5BeventId%5D/clone/route.ts)
copies `settings` wholesale, resetting exactly one key:

```ts
const settings = { ...(source.settings as Record<string, unknown>), reviewerUserIds: [] };
```

`settings.webinar.sessionId` is a **foreign key into the source event's
sessions**, so the clone inherits a pointer to a session belonging to a
different event. Prod showed it directly: event `cmsn5lhjk…` carrying
`anchorSessionId: cmsmykig…`, the anchor of the *other* event in the same log
window.

**Consequences** (all verified against source):
- `webinarSecondRoomViolation` compares each session against the foreign anchor
  id, never matches, and refuses with 409 `WEBINAR_ANCHOR_ONLY` naming a session
  that does not exist on that event. **You cannot attach Zoom to any session on
  the clone.** The organizer hit this twice, then abandoned the clone and built
  a fresh event 11 minutes later.
- The console shows "Configure Zoom" (the anchor lookup correctly returns null).
- Attendees on a non-anchor session get `session-detail:webinar-anchor-dangling`
  instead of the redirect.

**Not a security issue**, and not by luck: every anchor lookup binds `eventId`
from the July 28 sweep, so the foreign id resolves to null rather than reaching
another event's row.

**Recovery exists but is poor.** The banner's "Run provisioner" heals a
dangling pointer, but then creates a *second* anchor session alongside the one
clone already copied.

**The fix.** Rewrite the clone's settings handling as an **allow-list**:
config keys copy (`viewingMode`, `lobbyVideoUrl`, `lobbyImageUrl`,
`lobbyMessage`, `autoProvisionZoom`, `defaultPasscode`, `waitingRoom`,
`autoRecording`, `automationEnabled`), identity/state keys are dropped
(`sessionId`, `autoCreated`, `provisioningAt`).

An allow-list, not a deny-list: a deny-list goes stale the next time someone
adds a key, which is exactly what happened here. `reviewerUserIds` proves it:
somebody reasoned about this once and the reasoning did not survive the next
key that needed it.

**Same edit should reset `onsiteUserIds`**, which sits in the same blob, holds
the same kind of thing (per-event staff assignment), and currently carries last
event's desk temps onto the clone.

**Live state at time of writing: no event is broken.** All 4 webinar events have
anchor pointers resolving to their own sessions. But
`hemophilia-awareness-series-2026-july-10` is a *series*, and cloning is how you
build the next instalment.

### Webinar duration has no input anywhere (Aug 10, 2026, organizer-reported as "calendar says 1 hr not 1.30")

Investigated and **the software is correct**: `test-webinar` is 12:00–13:00 UTC,
and the event row, anchor session and Zoom meeting all agree; feeding a
90-minute window through the encoder produces
`dates=…T120000Z/…T133000Z`. Nothing dropped 30 minutes; the 90 minutes never
reached the database.

The real gap is product, not code: **there is no duration field for a webinar
anywhere in the UI.** The console *displays* `zoom.duration` read-only and the
Zoom form has no duration input. A webinar's length is implied entirely by the
event's start/end datetime (create form or Settings → General). An organizer
thinking "this webinar is 1.5 hours" has no field that says so.

Compounding it: we push session times **to** Zoom (the Aug 4 retime cascade) but
never read Zoom's duration **back**, so changing the length in Zoom's own UI is
silently lost.

**Open question for the owner before building:** where was 1.30 entered? If it
was the event end time in Settings, that is a save bug to chase. If it was
Zoom's own UI, or no field could be found, the fix is a duration control in the
Webinar Console that writes the anchor session's `endTime` (and cascades to Zoom
through the existing `session-service` path).

**Adjacent latent bug found while checking**, not fixed: `fromDatetimeLocal` in
[events/new/page.tsx](../src/app/%28dashboard%29/events/new/page.tsx) **hardcodes
a Dubai offset** (`4 * 60 * 60 * 1000`) while the form also collects a
`timezone`. Inert today because every event is Dubai; wrong the moment one
is not, and a hard blocker for the platform instance.

**Aug 11 update, still open:** the same hardcoded-Dubai pair also backs the
event **Start / End** fields in Settings -> General
([settings/page.tsx](../src/app/%28dashboard%29/events/%5BeventId%5D/settings/page.tsx)
`toDatetimeLocal` / `fromDatetimeLocal`). Unlike the deadline bug fixed that
day it is **symmetric, so it does not drift** on re-save; it is simply wrong
for the 2 live `Asia/Muscat` events, which are edited 4 hours out. Deliberately
left out of the deadline fix to keep the blast radius small: event dates gate
session validation, agenda day-bucketing and the M9 out-of-range guard, so
moving them onto `wallTimeInTzToIso` deserves its own pass with those three
re-checked. The settings page is the one entry on the
[check-datetime-local.sh](../scripts/check-datetime-local.sh) allow-list, and
that entry disappears when this is done.

### Public banner container widths have drifted (Aug 10, 2026)

Found while fixing the confirmation page's squeezed banner. **Four different
widths across the 19 public pages**: `max-w-[1400px]` (9 pages: sign-in,
my-registration, password, survey, agreements, submitter-register,
complete-registration), `max-w-[1120px]` (4, the register family),
`max-w-5xl` (2, agenda and group register), and unset (4: my-group, rsvp,
session, and confirmation until it was fixed).

Not swept: fixing one reported page is not the moment to restyle eighteen
others. Worth one deliberate pass to pick a convention, ideally by extracting
the banner *frame* (not just the `<img>`) into a shared component so the width
is decided once.

### Saved email templates drift behind the built-in defaults (Aug 10, 2026, owner: "add to backlog")

Surfaced while fixing the session-proposal confirmation email. Three related
items, one root cause, none urgent.

**The root cause.** `EmailTemplate` rows are **snapshots** of the built-in
defaults, seeded automatically the first time anyone opens Communications →
Email Templates for an event, edited or not. `getEventTemplate`
([email.ts:3197](../src/lib/email.ts#L3197)) then resolves **saved-always-wins**:

```ts
if (dbTemplate?.isActive) return { ...dbTemplate, branding };
```

No date and no version comparison, so a row saved eighteen months ago beats a
default improved this morning. That is correct for genuine customization and
wrong for a row nobody ever touched, and the system cannot tell the two apart.

**1. Clone propagates staleness (the item the owner backlogged).**
[clone/route.ts:330](../src/app/api/events/%5BeventId%5D/clone/route.ts#L330)
copies every row verbatim. An event created from scratch has no rows and so
uses the current default; a **cloned** event inherits the source's frozen
copies and is born behind. It compounds across generations of clones.

Owner decision Aug 10: **option 1 for now** (leave it: ten events, low clone
volume, and the fallback means nothing looks broken), revisit at option 2 when
clone volume justifies it.

- *Option 2, when it does:* on clone, skip rows whose content is **identical to
  the current built-in** (a pure seed) and copy the rest. The new event then
  falls back to the current default for the untouched ones. Same
  content-comparison discriminator the Aug 10 migration used to decide which
  saved rows were safe to rewrite, so it is consistent with what already ships.
  Caveat: the comparison is against *today's* built-in, so a row seeded in
  January and untouched will not match and still reads as "edited". It helps
  future clones more than it repairs past ones. Contained to the clone route,
  plus a test, plus a line of UI copy so a skipped template is not a surprise.
- *Option 3, the real fix:* version the copies (store which default version each
  came from) and surface "update available", the way a package manager does.
  **This belongs to the platform instance, not to MM Group.** At ten events the
  debt is trivial; at five hundred, "improve one email" means five hundred
  frozen copies and a migration every time. Cross-reference
  [PLATFORM_DECISIONS.md](PLATFORM_DECISIONS.md).

**2. Seven events silently omit the proposal number.** Verified Aug 10 against a
full copy of prod: 7 of 10 saved `session-proposal-confirmation` rows predate the
Aug 4 serial-number feature, so those events' proposal emails **never render
`{{proposalNumber}}`** even though the default does and everyone assumes it does.
Live, cosmetic, unnoticed until now. Fixing it means deciding whether to inject a
row into templates an organizer may have customized, which is exactly the
judgement call option 3 exists to remove. Owner call.

**3. The Aug 10 legacy-key compatibility shim.** `session-proposal-notify.ts`
still emits `proposalTheme` and `proposalFormat` as empty strings so a template
the migration deliberately skipped degrades to a blank row instead of printing a
raw `{{proposalTheme}}` (renderTemplate prints unknown keys **literally**).
Standard expand/contract: added, migrated, and now awaiting the contract step.
Remove once no saved template references either key. Zero rows referenced them
after the Aug 10 migration, so this can go whenever someone is in the file.

### Guard warn lines: route context on the remaining call sites (Aug 10, 2026)

`requireOrgId`, `denyReviewer` and `denyFinance` log the refusal **inside the
guard** so no call site can forget it. The cost is that the line only knows what
the guard knows: role and userId, not what was refused.

Aug 10 triage: 51 warnings in 3 hours from one SUBMITTER took a five-step
deduction to place (group by `msg`, notice the exact 2:1 ratio, list the hooks the
shared abstracts page mounts, grep which of those routes carry which guard, match
the arithmetic). One field would have answered it outright.

**Shipped:** all three guards take `{ route, eventId }`, threaded at the three
routes that actually fire today (`tickets:list`, `tickets:create`,
`email-templates:list`, `email-templates:create`, `tags:list`). Keys are omitted
rather than logged as `undefined`, pinned by test, mutation-verified.

**Remaining:** ~142 `requireOrgId` and ~211 `denyReviewer` sites still pass none.
That is fine and deliberate, because **a route no restricted role can reach never
logs**, so this is opportunistic: add `route` when you touch a route a restricted
role can reach. A 356-site sweep is a merge conflict, not a fix.

**Negative result, recorded so nobody retries it.** Deriving the route inside the
guard from `new Error().stack` was evaluated and **rejected**: the production
build emits `.next/server/app/api/.../route.js` as a **764-byte re-export with
none of the handler logic** (verified: zero occurrences of `requireOrgId` in it),
so the handler runs from a shared chunk and stack frames name the chunk, not the
route. It would have looked correct in dev and produced nothing in prod. Same
verdict for `headers()`: it is async in Next 16 and these guards are sync, so
adopting it would mean making ~356 call sites await.

### `npm run db:migrate` has no target guard (Aug 10, 2026)

`db:push` is wrapped by [guard-db-target.sh](../scripts/guard-db-target.sh),
which refuses to run against anything but the local container. `db:migrate` is a
bare `prisma migrate deploy` that goes wherever `DATABASE_URL` points.

It **cannot** repeat INC-002 (migrate deploy is non-destructive and never
prompts), but it is the same shape of hazard: a command whose target you infer
rather than verify, in a repo where `.env` has pointed at prod before. Roughly a
five-line fix, with the wrinkle being a clean opt-out for the box and CI deploy
paths, which legitimately must run it against prod. Needs a moment's thought
about the opt-out mechanism rather than a reflexive guard.

### ~~Worker job locking — replace the session lock with an expiring lease~~ ✅ SHIPPED Aug 10, 2026

Deferred in the morning ("watch today's fix first"), then built the same day
because the watch answered in 30 minutes rather than 24 hours — and answered no.

Moving the worker to a session-mode connection narrowed the advisory-lock leak
but did not close it: prod went from 435 runs/day to **7 in 30 minutes**, with
three locks caught held by connections idle for minutes. The split happens
inside Prisma's own pool, below the pooler, so no connection *type* could fix it.

Replaced with `JobLease` (migration `20260810120000`, additive) +
`worker/lib/job-lease.ts`: claim is one atomic
`INSERT … ON CONFLICT DO UPDATE … WHERE free-or-expired`, so connection identity
cannot affect correctness; leases expire so a killed worker frees its job
instead of wedging it; every mutation is owner-conditional so an overrunning
tick cannot release its successor's lease. 14 real-Postgres tests including the
connection-split case — which a mocked Prisma cannot express, which is why the
original bug survived a year of green unit tests.

### Billing accounts — per-event vs org-shared payer records (Aug 6, 2026, owner: "will come back later")

Raised by the owner mid-Phase-2 as *"billing accounts is per event and not global please"*.
The codebase currently sits **between** the two readings, which is why this needs
an explicit ruling rather than a guess:

- **Availability IS already per event** — a `BillingAccount` is attached to
  specific events through the `EventBillingAccount` junction (June 29, 2026), so
  the payer picker on Event B only offers payers attached to Event B.
- **The RECORD is org-level** — `@@unique([organizationId, name])`, so
  "Cleveland Clinic" is one row shared by every event it's attached to.

The consequence that surfaces in the group flow: `findOrCreateBillingAccount`
does exact-name reuse at the org level, so when a coordinator types their
company's details and a payer with that name already exists, **the newly typed
address / contact / tax number are discarded** and Event B silently inherits
Event A's (possibly stale) details. The PO/`payerReference` is already
per-registration/per-group, so it is not affected.

**The two options put to the owner:**

1. **Separate payer record per event.** Matches the wording literally. Cost: no
   consolidated view of what one company owes across events; the `needsReview`
   duplicate-flagging + `mergeBillingAccounts` tooling loses its meaning; needs a
   schema change (drop the org-level unique, re-key to the event).
2. **Keep one record, fix the stale-details problem.** Payer stays one org row
   attached per event; coordinator-supplied details are captured against that
   event/group and flagged for finance instead of being silently dropped. No
   core schema change.

Deferred by the owner during group Phase 2 ("will come back later, proceed to
phase 2"). **Nothing was changed** — today's behavior is exactly as described
above. Pick this up before a second event reuses a payer with different billing
details, because that is when the silent inheritance produces a wrong invoice.

### Group registration — promo codes ✅ SHIPPED Aug 7, 2026 (`cf043e33`)

**Reverses** the v1 exclusion in GROUP_REGISTRATION_PLAN §8 ("promo codes on
groups"). Before this, the group path had zero promo handling — which is why
the Promo Code column on the sales export came out empty for every group
member.

**OWNER DECISION: the code applies to the FULL AND FINAL INVOICE**, as one
discount against the consolidated total — not per member, not on each
member's registration row.

**Most of the document side already exists.** `Invoice.discountCode` and
`Invoice.discountAmount` are already columns, and the PDF already renders a
`Discount (CODE)` line from them (invoice-pdf.ts). Card checkout already
charges the INVOICE total rather than recomputing, so a discounted group is
charged correctly with no change there. What is missing is upstream: entering
the code, validating it, and populating those two fields in
`createGroupInvoice`.

**To build:**
- A code field on the coordinator form + validation against the same rules the
  individual path uses (active, date window, applicability, caps).
- `createGroupInvoice` computes and stores `discountCode`/`discountAmount`, so
  the frozen total already includes the discount.
- Record the redemption (`PromoCodeRedemption`) — see the open question below
  on how many uses that is.

**BUILT.** Code held on `RegistrationGroup.promoCodeId` (the discount belongs
to the deal, so it carries onto a reissued invoice); the money freezes onto
`Invoice.discountCode`/`discountAmount`. Read-only promo rules extracted to
[src/lib/promo-validation.ts](src/lib/promo-validation.ts) — they had been
hand-rolled twice already and groups would have been a third copy.

Verified end to end: GROUP20 (20%) on a $350 group → $70 discount, $14 VAT (tax
follows the DISCOUNTED base), $294 total, usedCount 1, discount line rendered
on the PDF. Found and fixed in the same round: the group PDF builder hardcoded
the discount to zero, so a discounted invoice printed a subtotal and total that
did not reconcile — correct in the database, wrong on the document the company
receives. Pinned by a mutation-verified regression test.

**The three answers below were ASSUMPTIONS, not owner decisions — revisit if any
is wrong (each is a small change):**

1. **One code on a group = ONE redemption**, matching "against the full and
   final invoice". Claimed conditionally when a cap exists, so two groups
   racing for the last use can't both take it.
2. **The coordinator enters it on the public form**, parity with individual
   registration.
3. **A SUPPLEMENTARY invoice does not re-apply the discount** (people added
   after one was settled); a REISSUE does. Granting it again on each later
   top-up would be a second discount off one negotiation.

Also decided in passing: `maxUsesPerEmail` is deliberately NOT charged against
the coordinator — it exists to stop one PERSON reusing a code, and counting a
company's group against their personal allowance would block that company's
next delegation. And a type-restricted code discounts only the members on
those types (still one invoice line; it only sets the base).

**Still open:**

- **Applying a code to an ALREADY-ISSUED invoice** (your team negotiating a
  discount after the fact) is not built — today the code must be entered at
  registration. That would mean cancelling and reissuing the invoice.
- **Credit notes / refunds** on a discounted group — the credit note caps
   against the paid total, which is already net of the discount, so this is
   probably free; worth a test rather than an assumption.

### Billing account — per-event breakdown (Aug 6, 2026, owner request, NOT BUILT)

Owner's ask: under a payer, show **per event** — the registrations it covers
with their details, the invoices raised, and how much has been paid ("event 1,
2 registrations along with details, paid invoice 10,000 USD").

**What exists today** (so this isn't rebuilt from zero):

- `GET /api/billing-accounts/[billingAccountId]` ALREADY returns
  `registrations` (attendee name/email, event id+name, ticket type, status,
  amounts) + `registrationCount` + `attachedEvents`.
- **But the only UI consumer — the "Events using {payer}" dialog in
  [billing-accounts-card.tsx](src/components/settings/billing-accounts-card.tsx)
  — reads `attachedEvents` ONLY.** `detail.registrations` is fetched on every
  open and rendered nowhere. Half the data for this feature is already on the
  wire and thrown away.

**What is missing:**

- **Invoices are not in the payload at all.** Needs `Invoice` rows for the
  payer — which is NOT a simple `where: { billingAccountId }`, because an
  invoice links to a registration or a group, not to the payer directly. The
  join is via `registration.billingAccountId` OR
  `group.billingAccountId`, so both shapes must be covered or group invoices
  silently vanish from a payer's view.
- **Paid amounts.** Prefer the invoice's own `status`/`paidDate` plus the
  linked `Payment` over recomputing from registrations — a group is settled by
  ONE payment covering N members, so summing per-registration would
  under-report it.
- **Per-event grouping + a UI surface.** The current dialog is an
  attach/detach checkbox list; this wants a proper detail view (the CRM record
  pages are the closest house pattern).
- **Finance gating.** The existing billing routes are `denyFinance`-guarded;
  anything showing paid amounts must stay behind that boundary.

Related but distinct: §"Billing accounts — per-event vs org-shared payer
records" above (whether a payer's DETAILS should differ per event). This item
is read-only reporting and does not depend on that decision.

### Group Registration Phase 3b — edit a member (Aug 6, 2026, owner: "add to backlog")

**Add member SHIPPED** (`36467a7c` service + API, `448165fa` dialog). The
remaining half of Phase 3b — letting a coordinator CORRECT an existing
member's details — is deferred.

What it would be, so it can be picked up cold:

- `PATCH /api/registrant/my-group/[groupId]/members/[registrationId]`,
  ownership bound on `coordinatorUserId` like its siblings, 404 (not 403) on a
  group they don't coordinate.
- **Editable:** name, title, organization, job title, phone, city, state, zip,
  country, specialty, role, additionalEmail — i.e. the attendee-detail fields
  the group registration form collects.
- **Deliberately NOT editable, and why:**
  - **email** — that is member *substitution*, not a correction, and the plan
    (§8) assigns substitution to the organiser. It also runs straight into the
    email-immutability rule: `Attendee.email` may only change via the dedicated
    PATCH routes, which cascade to `User`/`Contact` and clone a shared Attendee
    row. Reproducing that here would be a fourth copy of that logic.
  - **ticket type** — that is re-pricing, which reopens the invoice question
    Phase 3b just settled. A type change after a settled invoice needs a credit
    note plus a supplementary, which is its own decision.
- Attendee rows for group members are created 1:1 in
  `claimSeatsAndCreateMembers`, so the sibling-count/clone problem the
  registration email PATCH solves does not arise here — but a defensive
  sibling check is cheap and worth keeping if this is built.
- No invoice consequence at all, which is what makes it small: none of the
  editable fields feed a line item (the line is name + type, and the NAME is
  rendered from the attendee at PDF time — so an edit correctly updates how an
  already-issued invoice renders, without changing a single amount).

### Group Registration Phase 1 review — deferred findings (Aug 6, 2026)

The pre-push adversarial review returned 1 BLOCKER / 4 HIGH / 9 MED / 10 LOW.
**Shipped in-band with Phase 1:** B1 (invoice export 500 on group invoices),
H1–H4 (coordinator double-pay gate `COVERED_BY_GROUP` on checkout + portal;
dunning exclusion via `excludesGroupMembers` incl. single-send `MEMBER_OF_GROUP`;
double-submit advisory lock `group-register:{eventId}:{coordinatorEmail}`;
member-cancel drift → admin notify at all 4 cancel/delete choke points + the
invoice PDF drift note), M1 (group send routing on the send route + MCP), M2
(event invoices tab payer bill-to + search), M3 (MIXED_CURRENCY reject), M5
(tx timeout 30s), M6 (`GroupMemberInvoiceError` on individual invoices for
members), M8 (150 members/hr/IP email-amplification budget), M9
(case-insensitive dup check), L1/L2/L3(DB XOR CHECK)/L5/L6/L7/L8/L9.
**Deferred:**

- **~~M4 — should public group registrations consume pricing-TIER
  inventory?~~ ✅ SHIPPED Aug 6, 2026 — owner ruled YES (option a).** A group
  member priced at the live tier now CLAIMS that tier's seat, exactly like an
  individual public registration: `seatCounter` routes
  `createdSource ∈ {PUBLIC_REGISTER, GROUP_REGISTER} && pricingTierId` to the
  tier counter (a named `TIER_CONSUMING_SOURCES` set — "public self-service
  doors"), so every release/reactivate/type-change/delete/reconcile path
  follows automatically (they all route through the same helper). The group
  service aggregates its all-or-nothing claim **per counter** via
  `seatCounter` rather than re-deriving it, and a tier sell-out names the tier
  in the SOLD_OUT message ("Physician — Early Bird sold out"), not just the
  type. Rationale: the group door is unauthenticated public self-service, so
  price must carry allocation — otherwise one 40-person group drains the
  discount budget invisibly and Early Bird never advances to Standard for
  individual registrants. The **admin courtesy-seat exemption is unchanged**
  (staff exercise judgment per person; a manually-recorded latecomer at the
  Early-Bird rate still doesn't burn a real Early-Bird seat).
- **~~M7 — group-register credential door bypasses login-throttle + Sign-in
  Activity.~~ ✅ SHIPPED Aug 6, 2026 — BOTH doors.** New shared
  [public-credential-door.ts](../src/lib/public-credential-door.ts)
  `verifyPublicCredentials()` is the ONE guard every public password check goes
  through (rather than the sequence being copy-pasted into each route): it
  throttle-checks BEFORE bcrypt — the compare lives *inside* the helper so that
  ordering is structural, not a rule each caller must remember — charges only
  failures, clears the email bucket on success, and writes the `LoginEvent`
  (`SUCCESS` / `FAILED_PASSWORD` / `FAILED_UNKNOWN_EMAIL` / `BLOCKED_RATE_LIMIT`,
  surface `EVENT_PAGE`). Both callers keep their existing `checkRateLimit`
  bucket — that bounds TOTAL requests, this bounds failed credential attempts;
  dropping either would quietly loosen a live control. **`recordSuccess` differs
  per door on purpose:** group-register never calls NextAuth `signIn()`, so its
  pass IS the auth event and is recorded; abstract-start hands off to `signIn()`
  immediately, whose `authorize()` writes the SUCCESS row — recording one there
  too would double every successful sign-in in Sign-in Activity. Failures are
  recorded on both, since a 401 stops the client before `signIn()` and nothing
  else would ever see them. On success the guard returns the caller's own
  (generic) row, so "a pass means there is an account" is a compiler-enforced
  fact instead of an `!` at each call site. +12 tests.
  - **Follow-up A — `authorize()` still implements the same sequence inline.**
    Deliberately not refactored in the same change as a security fix: it is the
    live login path for every staff account and its variant is interleaved with
    org attribution, a distinct `RateLimitedSignin` throw and per-branch log
    lines. The helper's shape is a superset so it can adopt it.
  - **Follow-up B (trap for whoever sweeps `LoginEvent` for tenancy).** Both new
    call sites write the `LoginEvent` INSIDE `runWithTenant(event.organizationId)`
    while the row's own `organizationId` is null (org-independent registrants /
    submitters). Harmless today — `LoginEvent` has no RLS policy — but a strict
    `USING` rejects `create()`'s INSERT..RETURNING for an org-null row on a
    tenant lane (the Domain-#18/#19 lesson). That sweep must use `createMany`
    for org-null rows, as `HelpChatQuery` does.
- **~~L4 — tenancy-harness assertions for RegistrationGroup.~~ ✅ SHIPPED
  Aug 6, 2026.** [registrationgroup-rls.test.ts](../tests/tenancy/registrationgroup-rls.test.ts)
  (9 assertions) + seed fixtures. `RegistrationGroup` has no per-org unique
  field, so lane-scoping is proven the Invoice/EmailLog way — BOTH orgs hold a
  group on the SAME coordinator email, so an unscoped `where:{coordinatorEmail}`
  (the shape a future "find my group" lookup takes) must return only the
  caller's. Plus fail-closed-with-no-store, WITH CHECK on create + org-re-home,
  cross-tenant read/DELETE misses, defence-#1-in-isolation via the owner
  connection, and one pin that a group's `invoices` relation still resolves on
  its own lane (a fail-closed join there would hide a company's consolidated
  invoice from them). Harness 304 → **313** across 26 files.
  - *Harness gotcha found while doing this:* the throwaway tenancy DB had gone
    stale (predating the Aug-4 `SessionProposal` unique), so `global-setup`'s
    `db push` failed. That is intended — `--accept-data-loss` is deliberately
    NOT hard-coded there. The reset command is now documented at the point of
    failure in global-setup.ts.
- **L10 — account-existence oracle in the 401 message** ("an account with this
  email already exists") — consistent with the existing check-email /
  abstract-start posture; revisit only if that posture changes globally.
- **Group deletion is unbuilt and must stay guarded:** the DB shape
  Cascade-deletes the consolidated invoice with the group while SetNull-ing
  members (they survive, still UNPAID). No UI/route deletes groups in Phase 1;
  before Phase 3 adds any, decide the delete semantics (likely: refuse while a
  non-cancelled invoice exists).

### Warning-triage follow-ups (Aug 6, 2026 — the requireOrgId GET regression round)

Context: the 48h warning triage found the July 24 `requireOrgId` sweep (`d4f31d42`)
had 403'd org-null roles (SUBMITTER/REVIEWER) on the event-detail GET + the
abstract-themes GET for 13 days. **The Option A fix shipped Aug 6** (guard removed
from the two READS only; `buildEventAccessWhere` + finance redaction are the
authorization; PUT/DELETE keep the guard; regression tests pin org-null access).
Deferred from that round:

- ~~**Option B — slim event payload for org-null readers.**~~ **✅ SHIPPED Aug 7,
  2026** (`05bdb8b9` + `5c9ba475`), as its own reviewed round, after the field
  census this entry asked for. It found MORE than the settings blob: the events
  LIST also shipped registration/speaker headcounts plus the whole Event row
  (`bankDetails`, tax config, sender) to submitters, and **`GET .../speakers`
  returned the ENTIRE faculty roster** — every speaker's email, phone, bio and
  abstract titles — to anyone with a self-service submitter account, when those
  pages only ever needed the caller's own speaker row. All three fetch a
  whitelist now (never filter-after-fetch), consolidated in
  `src/lib/event-visibility.ts` with the detail select DERIVED from the list
  select; `settings` is rebuilt from a 2-key whitelist so a key added later is
  invisible by default. Both gates mutation-verified.
- **Staff-only hooks fire for submitters** (~47 warns/48h of pure noise): the
  shared abstracts page mounts bulk-email-dialog data hooks (`useTickets`,
  `useEventTags`, `useEmailTemplates`) unconditionally; submitters get 403s on
  routes they never use. Fix: `enabled: isStaff` on the hooks (React Query),
  or mount the dialog lazily for staff only.
- **Stale n8n poll** (16 warns/48h): an API-key caller requests sessions+tracks for
  a DELETED event (`cmscu1epb0001p501vgh21jbb`) — almost certainly the n8n→Webflow
  people sync pointing at a dead event id. Fix lives in n8n (update/disable the
  workflow), not EA-SYS.
- **`ses:env-credentials-in-use`** advisory (7 warns/48h): `.env` on the box carries
  `AWS_ACCESS_KEY_ID`, shadowing the EC2 instance role for SES. Sends work today;
  the runbook (docs/runbook-ses.md) recommends removing the env key so the role
  takes over. Operator action.
- **Process lesson (adopted in the fix):** guard sweeps need "org-null role can
  read its surfaces" pins — the regression passed the full gate because nothing
  asserted submitter access to the event GET. The Aug 6 tests add that class for
  the two fixed routes; extend it when touching other submitter-reachable GETs.

### Restricted-role reads — remaining judgement calls (Aug 7, 2026)

Left deliberately unchanged during the org-null read sweep. Neither is a defect;
both are product decisions the owner should make rather than a developer.

- **Review is single-blind.** A reviewer sees the author's name and affiliation
  on an abstract (it rides in the abstracts list payload). Double-blind would
  mean withholding the speaker from the reviewer-facing shape, which changes the
  review workflow (a chair often needs to spot conflicts by name), so it is a
  decision, not a tightening. The reverse direction is already anonymised: the
  author's decision email and the submissions view do not attribute notes to a
  named reviewer.
- **A submitter sees the mean score on their own abstract** (`meanOverallScore`
  + `reviewCount` are folded into the abstracts list so the card can render
  without a second fetch). Some organisers want that transparency, some do not.
  Previously logged under the reviewer/submitter lifecycle audit; restated here
  because the Aug 7 sweep confirmed it is the last "more than they need" item
  on that surface.

Also still open from the Aug 6 warning triage and now more visible: the shared
abstracts page mounts staff-only data hooks (`useTickets`, `useEventTags`,
`useEmailTemplates`) unconditionally, so a submitter generates 403s on routes
they never use. Cosmetic in effect (React Query swallows them) but it is log
noise on every page view — fix with `enabled: isStaff`.

### Manual/CSV registration default status — CONFIRMED vs PENDING (Aug 6, 2026, organizer ask — DECISION PENDING)

Organizer asked that manually added / CSV-imported registrations should NOT
auto-confirm. Both sides argued (Aug 5–6 discussion); no change shipped —
recorded here for the owner decision.

| # | Organizer's case (for PENDING-by-default) | Counter-case (for keeping CONFIRMED) |
|---|---|---|
| 1 | **Adder ≠ approver** — imports/adds are often done by temp desk staff or whoever got handed the file; data entry and approval are different jobs (maker–checker). | A **manual single add** is usually the desk or an organizer deliberately registering one person — the adder IS the reviewer; add-then-confirm is pure friction (2 clicks × 500 at a live door). |
| 2 | **CONFIRMED leaks outward instantly** — confirmation email + quote fire, portal says "Confirmed", barcode minted, door admits. A sponsor file of 200 names against 150 seats has already promised 200 people. | "Confirmed" ≠ "paid" and ≠ "details complete" — money is chased via UNASSIGNED/UNPAID (desk blocks unpaid without an override) and incomplete CSV rows go through the Send Registration Forms completion flow. |
| 3 | **House history** — the July-27 incident put 502 delegates on a type named "Faculty" via import. PENDING imports would contain a bad file to a review queue instead of 502 live badges. | Approval semantics already exist opt-in: `TicketType.requiresApproval` → PENDING on every entry path. |
| 4 | **Consent** — a CSV-imported person never asked to register; honest lifecycle is provisional → completes the registration form → confirmed. | CSV already accepts an explicit `registrationStatus` column — a file can import as PENDING today; bulk status change exists to flip later. |
| 5 | **The existing levers answer the wrong question** — `requiresApproval` is per ticket TYPE (category), not per ENTRY PATH; the CSV column requires the file author to know it exists. Defaults are what actually happens. | Never silently flip a global default on the LIVE system — existing events' workflows (desk flow, kiosk, completion emails, webinar sequences) assume today's behavior. |

**Middle-ground proposal (recommended if the organizer insists):**

| Entry path | Proposal |
|---|---|
| CSV / import-contacts / EventsAir imports | An **"Import as Pending"** choice in the import dialog (visible per-import decision, no file editing) — optionally an event-level setting defaulting imports to PENDING. This is where the risk genuinely lives. |
| Manual single add (dashboard/desk) | Keep auto-CONFIRMED (desk reality); optionally a status picker on the full-page Add form for the rare deliberate pending add. |
| Public self-register | Unchanged — `requiresApproval` already covers the unvetted-person case. |

Cost to state if the global default flips anyway: two-step desk registration,
a confirm pass after every import, and a decision about when the
confirmation-email/quote fires for staff-added paid registrants.

### Webinar retime / anchor round — deferred LOWs (Aug 4, 2026)

Adversarial review (two lenses) of the webinar retime cascade + email-sequence
reschedule + second-webinar guard/auto-heal + mobile-banner round: 0 BLOCKER /
2 HIGH / 8 MED / 10 LOW. **Both HIGHs, all 8 MEDs and 4 quick LOWs shipped
same day in-band** (shared `webinarSecondRoomViolation` guard for REST + MCP;
per-event `pg_advisory_xact_lock` around the clear+create reschedule; clear
scoped to sequence-minted phase rows only with CANCELLED respected +
partial-FAILED resume state preserved; anchor window pre-validated before the
event save (`ANCHOR_OUTSIDE_NEW_DATES`) + cascade/`sequenceSync` failure
toasts on Settings + Agenda; cascade tenant-wrapped; re-attach P2002
discrimination + provisioning sentinel; org-staff exempt from the anchor
redirect; cancelled-event + log-spam gates; banner gates widened on 9 pages).
Remaining LOWs, none email-affecting:

- **WEBINAR_SERIES retime doesn't move occurrences** — the Zoom PATCH carries
  no `recurrence`/`occurrence_id`; a warn logs on every series sync. Fix when
  a recurring series is actually used (none live today).
- Public session redirect drops query params (utm only; the page reads none)
  and burns one zoom-join rate unit per stale-link visit (double fetch before
  the replace).
- Provisioner re-attach enqueues the sequence NON-force, so legacy stale
  PENDING rows survive a re-attach (every retime path now reschedules, so
  only pre-Aug-4 rows are exposed).
- Natural-height banners: a very tall desktop banner (~square) now renders
  full height on desktop login/agreement pages (register has used this
  pattern since June without complaint); at 576–767px the session hero uses
  the desktop source with the mobile (natural-height, no-gradient) layout.
- `rescheduleSequenceIfAnchor` adds one `event.findUnique` per times-changed
  session update (validate() loaded the event moments earlier — thread it
  through if it ever shows up in traces).
- API-only edge: an event PUT that changes `startDate` AND repoints
  `settings.webinar.sessionId` in the same request cascades the OLD anchor
  (the dashboard never sends both).

### Per-tenant API keys (item 7) — deferred finding M1 (Aug 4, 2026)

Adversarial review of the per-tenant Stripe/AI keys feature (commits
`14173797..96d9436e`; two lenses — money-path correctness + security):
0 BLOCKER / 2 HIGH / 3 MED / 7 LOW. **Everything except M1 shipped same day**
(follow-up commit after the feature push): HIGH-1 cross-org forged-payment —
the shared dispatcher now takes `expectedOrgId` from the per-org webhook route
and refuses any event whose RESOLVED registration/payment belongs to another
org (200-ack + error log, so a forged event earns no Stripe retry storm;
metadata claiming a foreign org is also rejected up front); HIGH-2 —
`getStripe(orgId)` retries a failed org-settings read once then THROWS instead
of guessing the env fallback (a keyed tenant must never silently charge
through the platform's account); M2 — `event.livemode` cross-checked against
the org's stored `keyMode` (test-mode events can't flip real registrations
PAID); M3 — per-IP rate limit on the unauthenticated per-org webhook ahead of
its DB read; LOWs — one generic 400 body for every webhook refusal (no
config-state oracle), test-connection returns static error text (SDK messages
can embed masked key fragments) and hides the platform's account identity on
the env fallback, AuditLog rows on Stripe credential save/delete, corrected
cache comment, NEXTAUTH_SECRET-rotation note in stripe.ts, the deliberate
AI-vs-Stripe decrypt-failure asymmetry documented in ai/credentials.ts.

**M1 — DEFERRED (platform precondition, owner-scoped out of the same-day
batch): refund clients resolve by ORG, not by the PAYMENT that took the
money.** An org can legitimately take payments on the env fallback and later
save its own key; every refund path then asks the NEW account about
PaymentIntents that live in the OLD one — app-level refunds for that cohort
fail forever (`STRIPE_FAILED`; Stripe-dashboard only) and a stale
`RefundAttempt` for such a payment makes the reconciliation sweep churn it as
`unverifiable` every tick. Fix shape: stamp the charging account on the
`Payment` row at create (`keySource: "org"|"env"` or the Stripe account id)
and resolve refund/verification clients from the payment; minimally, warn on
the credentials PUT when the org already has env-account Payment rows.
Latent on master (MMG never switches accounts mid-stream); must land before
any org that took env-fallback payments configures its own Stripe key.

### WEBINARS MEMBER-parity read sweep (Aug 10, 2026)

The role's DESK surface went org-wide (MEMBER parity) on Aug 10; the READ side was
deliberately staged and is still outstanding. Today ~59 event GETs resolve on the
**manage** surface, so a WEBINARS user sees every event in the list, can work any
registration desk, but gets a **404 on a conference's agenda, speakers, tickets and
analytics**. That is the staged state, not a defect.

The sweep: triage each of the ~59 GETs under `src/app/api/events/[eventId]/` and pass
`{ surface: "desk" }` where MEMBER-equivalent read is intended. Fails closed on anything
missed (a 404 is a feature gap, never a leak), so it can land incrementally.

**Must STAY refused**, or the sweep quietly reverses decisions already made:
- the **org-wide invoice ledger** (`/api/invoices` + export) — the Aug-4 H-1 ruling,
  *finance-capable ≠ org-ledger access*. Full MEMBER parity would hand it back.
- the webinar console routes, email templates, scheduled emails (full-control surfaces).
- anything paired with `WEBINAR_STAFF_ALLOW` — those MUST keep the manage surface.

**Precondition met:** the `orgCtx`-branch bypass below is fixed, so `buildEventAccessWhere`
is actually reached on these routes. Sweeping before that would have written down rules
the code did not apply.

### WEBINARS / ONSITE — role scoping skipped for signed-in callers (FIXED Aug 10, 2026, `db250e45`)

Recorded because the shape is worth recognising, not because anything is outstanding.
`sessions` + `speakers` GET used `orgCtx ? { id, organizationId } : buildEventAccessWhere(...)`,
which reads as "an API key, else a person" but matches a signed-in person too, so role
scoping never ran: an ONSITE temp assigned to one conference could read any other event's
agenda and full faculty roster (emails, phones). Fixed with `accessUserFrom` — one
predicate, no branch. **Remaining watch item:** the same trap is available anywhere a route
mixes API-key and session auth. Only these two had it at the time of the sweep; a CI
grep-gate for the pattern is a candidate (see the existing gate suggestion below).

Adversarial review of the WEBINARS role (webinar team): 0 BLOCKER / 2 HIGH / 3 MED / 5 LOW.
H-1 (org invoice ledger refused + proxy block), H-2 (schedule-mutation primary writes
builder-bound), M-1 (email-logs desk-confined + CONTACT/USER/OTHER refused), M-2
(eventType flip refused on event PUT), M-3 (desk-limited UI on assigned conferences),
L-4 (registration DELETE reverted to ADMIN/ORGANIZER — owner-acked: no refund powers ⇒
no row deletion) all shipped same day, plus a route-level regression matrix
([webinars-role-regression-matrix.test.ts](../__tests__/api/webinars-role-regression-matrix.test.ts)).
Deferred:

- **L-1 — `resolveAnchorZoomMeeting` is org-scoped, not builder-scoped**
  (webinar/panelists + resend). Benign: conferences have no `settings.webinar.sessionId`
  anchor → natural 404, and M-2 now prevents the type-flip that could mint one.
  Belt-and-braces option: clear `settings.webinar` on any admin-performed type flip.
- **L-2 — contact-PII side door via the two import-contacts routes**: WEBINARS (builder-
  confined to webinars ✓) can copy a Contact's full shape into a registration/speaker by
  guessing a contact cuid (list 403s, so no enumeration). Accept or refuse the role on
  those two routes.
- **L-5 — `GET /api/organization/users` readable by every org-bound role** (pre-existing;
  ONSITE/MEMBER/CRM_USER too): staff names/emails/roles by direct API call. Tighten to
  ADMIN+ if the owner wants (the Settings UI is already proxy-blocked for all of them).
- **CI grep-gate** (reviewer suggestion, check-tenant-als.sh style): "every handler
  containing `WEBINAR_STAFF_ALLOW` must contain `buildEventAccessWhere`" — would have
  caught the email-logs pair and makes the pairing invariant self-enforcing.
- Dead sidebar entries on webinar events (Certificates / Reimbursements / AI Agent /
  Dinner) whose APIs 403 the role — cosmetic; hide via role-aware filtering if it
  generates confusion.

### Self-service check-in kiosk review — deferred LOWs (Aug 3, 2026)

Adversarial review of the kiosk feature: 0 BLOCKER / 3 HIGH / 4 MED / 7 LOW. H1 (PIN-gated
staff exit), H2 (honest badge-print failure after a committed check-in), H3 (401/5xx no
longer masquerade as "code not recognised" — persistent staff-needed screen), M1 (input
residue on debounce), M2 (busy-scan feedback beep), M3 (3 reprints/registration/hour
kiosk-local cap), M4 (route test pinning the ALREADY_CHECKED_IN body shape), L1
(defensive already-checked-in wording), L2 (shared `src/lib/scan-feedback.ts` beep) all
shipped same day. Deferred:

- **L3 — no focus trap under the kiosk overlay**: the dashboard layout DOM beneath the
  `z-50` overlay is Tab-reachable with an attached keyboard (or a crafted barcode emitting
  Tab/Enter). Largely mitigated by the H1 exit PIN + 1s refocus interval; a `inert`
  attribute on the layout while the kiosk mounts would close it fully.
- **L4 — kiosk print failures are client-console only**: a "badges not printing" incident
  isn't visible in `/logs`. Candidate: a fire-and-forget beacon endpoint, or fold a
  `printFailed` flag into a follow-up request.
- **L5 — the kiosk page loads the full staff event payload** (via `useEvent`) to render
  just the event name; ONSITE is finance-capable so tax/bank fields sit in JS memory on an
  attendee-facing machine. A minimal name-only lookup would be cleaner.
- **L6 — no rate limit on the check-in PUT / badges POST** (pre-existing, deliberate:
  venue-NAT desk traffic). Revisit only with a product call.
- **L7 — the `--kiosk-printing` dialog heuristic** (print() blocking >1.5s) misses a
  dialog dismissed faster; acceptable, documented in the user guide.
- **M3 residual**: the reprint cap is kiosk-LOCAL (in-memory; resets on reload). A durable
  server-side cap would read `badgePrintCount` / audit rows — do this if badge farming is
  ever actually observed.

### Comms-log sweep (Domain #18) — deferred decisions (Aug 3, 2026)

> **✅ RULED ON — Aug 4, 2026.** The owner decided both items (offboarding =
> archive-to-S3 then remove; NULL-org purge = archive + delete) plus the
> `?? ""` class (stamp default/operator org id + tenant identifier). Full
> record + build-time items: [docs/PLATFORM_DECISIONS.md](PLATFORM_DECISIONS.md)
> §1/§2/§4. The text below is the original problem statement, kept for context.

The adversarial review of the EmailLog/ScheduledEmail sweep (`37337b6e`) closed every
code-level finding same day (record: MULTI_TENANCY.md §13 #18). Two items are OWNER
DECISIONS, platform-only, deliberately not implemented as code:

1. **Tenant offboarding vs `EmailLog.organization` `onDelete: SetNull`.** Deleting an
   org converts its entire email log — recipient addresses, subjects, and stored
   `htmlBody` — into NULL-org rows that are unreadable/undeletable from every tenant
   lane (the asymmetric policy) and reachable only by the platform owner role. Options:
   flip the FK to `Cascade` (schema migration; matches ScheduledEmail), or add an
   explicit offboarding purge step to the platform's tenant-deletion runbook. Decide
   before the platform onboards its first real tenant; irrelevant on single-org master.
2. **A NULL-org retention/purge job.** The email-log-prune worker only nulls `htmlBody`
   and keeps rows forever; NULL-org rows (auth emails + any lost-attribution residue,
   plus unauthenticated forgot-password writes at up to the rate-limit ceiling) have no
   reaper and no reader. Fold a NULL-org row deletion window into the privileged
   maintenance lane work (the same lane the prune job already requires).

3. **The `runWithTenant(session.user.organizationId ?? "")` class — 16 instances**
   (Invoice + Reg-core sweeps: invoices detail/pdf/send/export, clone, cancel,
   check-in ×2, activity, payments, …). For an org-null SUPER_ADMIN the lane is `""`
   → under platform RLS every swept read fail-closes to 404/empty on those routes.
   Fail-CLOSED direction (no leak), master-inert, and consistent — so it is deferred
   as its OWN pass (convert each to the resource-org shape: load the un-swept Event
   first, wrap with `event.organizationId`) rather than point-fixed one file at a
   time. Do it before the platform gives SUPER_ADMIN an org-null console.

Also parked (LOW, no action): the migration-DDL-ordering pattern (put `CREATE INDEX`
after backfill UPDATEs so the ACCESS EXCLUSIVE lock isn't held across them — the #18
migration is already applied and was a no-op at prod's table sizes, so it stays as-is;
apply the ordering in FUTURE sweep migrations), and the `reimbursements/send` double
narrow wrap being past the gate's first-op read-placement check (both wraps verified
correct by hand).

### AuditLog sweep (Domain #19) — deferred decisions (Aug 3, 2026)

> **✅ RULED ON — Aug 4, 2026.** The owner decided the org-null audit-write
> item: stamp the default/operator (MMG) org id + a tenant-identifier field
> instead of losing the row (one operator-visibility nuance to confirm in the
> privileged-lane discussion). Full record:
> [docs/PLATFORM_DECISIONS.md](PLATFORM_DECISIONS.md) §3.

Record: MULTI_TENANCY.md §13 #19. Platform-only items, deliberately not implemented:

1. **Org-null audit writes are LOST on the platform (owner decision needed before the
   first real tenant).** ALL 163 AuditLog writers use Prisma `create()`
   (INSERT..RETURNING), and RETURNING must pass the strict USING — so from an
   app-role lane with no ambient org, a NULL-org audit write (the org-null
   registrant/reviewer password-flow audits) is REJECTED at the DB; every writer's
   fire-and-forget catch logs it, so the loss is loud but real. Options: a privileged
   write lane for the auth routes, a createMany-based null-safe path in the
   withAuditOrgStamp extension (risky: create()'s return value would need
   synthesizing), or acceptance. Master (no RLS) unaffected — org-bound users' auth
   audits are already explicitly stamped and unaffected either way.
2. **AuditLog has no retention/offboarding story** (pre-existing, now sharper): no
   prune job, no delete surface, and the new org scalar has NO FK — deleting an org
   leaves its audit rows stamped with a dangling org id (correct for audit-trail
   durability; the platform's tenant-offboarding runbook must decide whether to purge
   them, same decision family as the EmailLog SetNull item above).

Resolved by this sweep (previously tracked here): ~~"AuditLog has no flat
`organizationId` column (org id lives in `changes` JSON, which can't back an RLS
policy)"~~ ✅ — flat column + `[organizationId, createdAt]` index + 9-source backfill
shipped in migration `20260803180000`; the global `/api/activity` feed now reads the
flat column and surfaces the previously-invisible Contact/CRM/org-admin audits.

### Certificates tenancy-sweep review — LOWs (Aug 3, 2026) — ✅ ALL SHIPPED same day

Adversarial review of the Domain #13 Certificates sweep (`46af5714`): 0 BLOCKER / 2 HIGH /
4 MED / 7 LOW — no cross-tenant leak anywhere; every finding was fail-closed-direction and
inert on master (RLS off). HIGHs + MEDs fixed same day, and the owner then opted to close
the LOWs immediately too (rather than wait for a platform-bringup issue — L2/L5/L6's whole
failure mode is *silence*, which "wait for an issue" can't detect). Record of what shipped:

- ~~**L1 — email-preview swept reads unwrapped**~~ ✅ the whole handler body now wraps in the
  **resource org** (`event.organizationId` — the route serves org-null SUPER_ADMIN, so
  session-org would've been wrong), covering the cert-cover branch, the target
  speaker/registration overrides, AND `buildRealPreviewOverrides` + the sample
  ticket/serial nested selects (moved inside the wrap — they previously fail-closed to
  silent canned-sample degradation).
- ~~**L2 — NULL-org run stalls silently**~~ ✅ `processRun`'s `!run` early-return now warns
  `cert-issue:run-invisible-to-tenant-read` with the org-mismatch hint.
- ~~**L3 — template DELETEs check-then-act**~~ ✅ both the route + MCP
  `delete_certificate_template` compound-where `{ id, organizationId }` (defence #1), and
  the harness gained the defence-#1-in-isolation assertion (owner client bypasses the
  policy → the where-shape alone P2025s a cross-tenant delete). Harness 256 → 257.
- ~~**L4 — `auto-issue.ts` listed twice in the gate**~~ ✅ deduped to the Certificates block
  with a cross-reference note at the July-29 slot.
- ~~**L5 — `CertificateBulkSendInput.organizationId` optional**~~ ✅ now required
  `string | null` — omitting it no longer compiles.
- ~~**L6 — no unit test pins the cert-row org stamp**~~ ✅ pinned in
  `certificates-bundle.test.ts` (findOrIssueCertificate — the choke point for
  bundle/bulk-issue/worker) + `certificates-deliver.test.ts` (issueSingleCertificate's own
  create).
- ~~**L7 — doc/comment drift**~~ ✅ closed in the HIGH/MED round (§13 handler count + gate
  roster).

### Custom session roles — organizer-managed role list (July 30, 2026, owner decision: PARKED, design recorded)

Owner asked whether the static `SessionRole` enum (SPEAKER / MODERATOR / CHAIRPERSON / PANELIST)
could become organizer-managed so agenda setup can add roles like "Workshop Faculty".
Decision: **park it** until an organizer actually needs a role the four can't cover.

**Why the roles are static today (the constraint any build must respect):** the enum values
carry BEHAVIOR, not just labels — MODERATOR + CHAIRPERSON gate the `{{moderatorDetails}}`
run-sheet email block and the Brief Moderators/Chairpersons Communications tiles + the
`sessionRole` bulk-email filter; PANELIST feeds the webinar panelist import; SPEAKER drives
`{{presentationDetails}}`. The enum is also the repo's exhaustiveness safety net — label/colour
maps in [src/lib/session-enums.ts](../src/lib/session-enums.ts) are exhaustively keyed Records,
so a new value fails the BUILD until every surface handles it.

**Chosen design when un-parked — "custom role = label + base behavior" (Option 1 of 3):**
- Role definitions live in `Event.settings.sessionRoles` JSON (`{ label, base }[]`, base ∈
  SPEAKER | SESSION_LEAD (moderator/chair-like) | PANELIST) — no new table.
- One additive nullable column: `SessionSpeaker.customRoleLabel String?`. The `role` enum
  keeps storing the BASE, so every behavior gate (emails, tiles, panelist sync, filters,
  MCP whitelists) is untouched by construction; a custom "Workshop Faculty" based on
  Session-lead gets the run-sheet automatically.
- Display sweep: everywhere a role renders (session editor, dashboard agenda tooltip, public
  agenda + session page badges, `{{role}}` token, speaker page) shows
  `customRoleLabel ?? SESSION_ROLE_LABELS[role]` — one helper, ~8 surfaces.
- "Manage roles" UI on the agenda page; role picker in the session form merges the 4
  built-ins + the event's custom list. MCP `add_speaker_to_session` gains an optional
  `customRoleLabel` (pkg bump + client reconnect).
- The load-bearing UX decision: a custom role MUST declare its base behavior at creation
  (the system cannot guess whether "Workshop Faculty" should receive a moderator run-sheet).

**Rejected:** full custom-role table replacing the enum (deletes the build-time
exhaustiveness guard, forces arbitrary-string handling into every MCP schema/filter/email
gate, risky migration on live prod). **Cheap interim** if one specific role is needed
before the build: an additive enum value + label/colour mappings is a couple of hours —
ask the owner for the exact names.

**Multi-tenancy (owner asked July 30, 2026):** the design is tenant-safe by construction —
role definitions live in `Event.settings` and an Event belongs to exactly one org, so one
tenant's "Workshop Faculty" can never appear in another tenant's picker; no extra RLS work
(the `customRoleLabel` scalar rides the program domain's normal tenancy sweep, and the enum
itself is CODE shared by all tenants — base behaviors, not tenant data). The one rule:
**never a global role table** — that would make role vocabulary cross-tenant state. The
multi-org convenience layer, when wanted, is an ORG-level default list in
`Organization.settings.sessionRoles` merged under per-event overrides (so a tenant defines
"Workshop Faculty" once for all their events), plus event-clone already carrying the
event-level list. Works identically on master and the platform silo — flags-not-forks.

### Registration-create unification — shared importer row-create helper (July 29, 2026, owner-approved, DEFERRED until the Registration-core tenancy sweep lands)

All admin-driven creation paths now allow a blank/typeless registration type
(manual add full-page + quick dialog, MCP `create_registration`, CSV import,
import-from-contacts) with the same rules: typeless ⇒ `ticketTypeId` null +
COMPLIMENTARY + no seat claim; the hidden Faculty type refused server-side
everywhere (registration-service guard + `resolveImportFallbackTicketType`).
**Public routes deliberately keep `ticketTypeId` mandatory** (owner rule):
public register requires it; complete-registration's optional field is only
the July-27 self-select mechanism for typeless rows.

**Remaining (approved, not built): extract ONE shared importer row-create
helper** for the CSV + import-contacts routes (attendee create + serial +
registration create + seat claims via `registration-seat-db`) — the July-2
dedup queue item #1. **Owner decision July 29: when extracted, import-contacts
adopts the CSV row defaults** (typed rows get CONFIRMED status — PENDING when
`requiresApproval` — UNASSIGNED/COMPLIMENTARY payment, and a minted entry
barcode; today they land on schema defaults PENDING/UNPAID with **no qrCode**,
so contact-imported people can't be scanned at the door). Deferred ONLY because
the concurrent Registration-core tenancy sweep (Domain #8, C2 PARTIAL as of
July 28) is actively editing these exact files — do this as its own gated pass
once that sweep lands.

### Presence / "who is logged in right now" (July 28, 2026) — shipped, with two open items

`User.lastSeenAt` + the **Active Now** card (Activity → Sign-ins). Full
record in [LOGIN_ACTIVITY.md §4b](LOGIN_ACTIVITY.md) and the session-model
trade-off in [SESSION_ARCHITECTURE.md](SESSION_ARCHITECTURE.md).

- **No session revocation — the significant one.** Nothing can sign anyone out. A
  compromised account cannot be cut off: changing the password does **not**
  invalidate the existing token, and deleting the account leaves its cookie
  working until it expires (up to 24h). Does **not** need database sessions to
  fix — the cheap path is `User.tokenVersion Int @default(0)`, stamped into the
  JWT at sign-in and compared in the re-validation block that already runs, so
  "sign out everywhere" becomes `tokenVersion++` and revocation takes effect
  within ≤5 min. See SESSION_ARCHITECTURE.md §7.
- **Derived "last activity" fallback — considered and declined July 28, 2026.**
  Deriving a fallback from `AuditLog._max(createdAt)` for accounts with no
  presence yet. Sound as a *separate labelled signal* (never as a backfill into
  `lastSeenAt` — that laundders "last edit" into "last seen"), and cheap: one
  groupBy over just the null set, self-eliminating as people get stamped.
  Declined because the blank is transitional (each person fills their own row in
  within 5 min of use, so within a week it's dead code still costing a query) and
  its coverage is worst where a blank misleads most — **audit rows only record
  writes**, so a read-only MEMBER never generates one. Revisit only if blanks
  persist for accounts genuinely in use.
- **`PRESENCE_TRACKING_SINCE` is a hardcoded constant.** Fine while it's recent
  and load-bearing for the "—" copy; delete the constant and the explanatory line
  once every active account has a real stamp.

### Sign-in activity (July 28, 2026) — shipped scope + what was deliberately left out

Full record in [docs/LOGIN_ACTIVITY.md](LOGIN_ACTIVITY.md) §7. Shipped: `LoginEvent`
(every attempt), the one writer across all four login doors, the failed-attempt
throttle the web login never had, lazy IP→location, an ADMIN-only Settings tab, and
a 180-day prune job. Not built, in rough order of how likely someone is to ask:

- **Per-user "your recent sign-ins".** Offered at planning; owner chose admin-only
  for v1. This is the half that catches a compromised password *early* — the person
  themselves spots the session they don't recognise. A block on `/profile` backed by
  the same route filtered to `userId = session.user.id`; the read boundary would need
  its own predicate (every authenticated user may see their **own** history), NOT a
  loosening of `canViewLoginActivity`.
- **Alerting.** Nothing pushes. A burst of failures, a sign-in from a new country,
  or a lockout is only seen if an admin opens the tab. Everything is warn-logged so
  it reaches `/logs`/CloudWatch/Sentry, but there is no notification. Cheapest real
  version: fold a threshold check into the existing prune tick (or its own job) and
  fire `notifyEventAdmins`-style in-app + SES on "N failures against one account in
  M minutes".
- **Unknown-email attempts are recorded but invisible in the UI.** They carry a null
  `organizationId` (no user to attribute them to), so the org-scoped view cannot show
  them — "someone is hammering our login page with made-up addresses" is answerable
  only from the table or the logs. Deliberate (address spray is noise; an attack on a
  real account resolves to a user and IS shown). If it becomes a question people ask,
  the shape is a separate aggregate — "N unknown-address attempts from K addresses in
  the last 24h" — rather than exposing the attempted strings, which are
  attacker-supplied and would be a fresh PII surface.
- **Throttle store is in-memory and per container.** Counters reset on every deploy,
  and a blue-green swap mid-attack hands a clean slate; two containers roughly double
  the effective limit. Same known limitation `checkRateLimit` already carries —
  **migrating both to a shared store (Vercel KV / Upstash) is ONE piece of work, not
  two**, and `login-throttle.ts` was written with the same peek/charge/clear shape so
  it ports alongside.
- **No session list and no remote sign-out.** This records *attempts*, not live
  sessions. Sessions are stateless JWTs (24h rolling; `AuthSession` exists from the
  Prisma adapter but is unused under `strategy: "jwt"`), so there is nothing
  server-side to enumerate or revoke. "Sign out everywhere" needs a token-version
  column on `User` checked in the JWT callback — its own piece of work, and the
  natural companion to the per-user view above.
- **Adjacent auth events not recorded:** logout, password reset, invitation
  acceptance, mobile token refresh, MCP/API-key/OAuth access. Notably **an account
  takeover performed via password reset leaves no trace in this view** — the reset
  routes are untouched. Adding `PASSWORD_RESET` / `INVITE_ACCEPTED` outcomes is
  additive (new enum values + call sites); the enum was left deliberately small.
- **No CSV export.** Export is a separate, narrower boundary in this codebase
  (`denyContactExport` / `denyRegistrationExport`) and would need an audited path via
  `recordExport`. Not asked for; cheap to add if finance/compliance ever wants it.
- **Timing oracle on account existence (pre-existing, not introduced).** bcrypt runs
  only for addresses that resolve to a user, so response time differs. Closing it
  needs a dummy compare on the miss path.
- **Geo is a cross-border transfer of personal data** (ipapi.co, outside the region),
  defaulted ON with a `LOGIN_GEO_ENABLED=false` kill switch. Revisit if the PDPL
  stance tightens — a self-hosted MaxMind GeoLite2 DB is the no-egress alternative
  (~70MB, monthly refresh, needs a licence key).
- **`.env.example` is gitignored** (`.gitignore` line 44's `.env*` pattern), so the
  two new vars could not be documented there — they live in
  [docs/LOGIN_ACTIVITY.md](LOGIN_ACTIVITY.md) §4.1 instead. Worth deciding whether
  `.env.example` should be force-added, since CLAUDE.md §10 asserts it is in the repo
  and it is not.

### Typeless-import + completion self-select review (July 27, 2026) — M1/M3/L2/L3 shipped, M2 + L1 deferred

Review of the "registration type can be null on import; the person states it on the
completion form" feature (import-ticket-type.ts / current-pricing-tier.ts / the
completion-route type-set). M1 (explicit `paymentStatus` — PAID/INCLUSIVE — survives
completion), M3 (conditional row claim → 409 `REGISTRATION_TYPE_ALREADY_SET` on a
concurrent organizer assignment), L2 (self-selected `requiresApproval` type flips
CONFIRMED → PENDING, matching public-register semantics), L3 (hook response types
`uncategorised`) all shipped with the feature. Deferred:

- **M2 — EventsAir re-sync into a since-priced event is a UI dead end.** The
  EventsAir import route 400s `DEFAULT_TICKET_TYPE_REQUIRED` when the event
  charges and no `defaultTicketTypeId` was sent — but
  [eventsair-import-dialog.tsx](../src/components/import/eventsair-import-dialog.tsx)
  never sends one and has no picker, so re-syncing contacts into an event that
  gained priced types/tiers after the initial import fails with an error telling
  the operator to "pick one" where nothing can be picked. (The normal new-event
  flow is unaffected — freshly imported EventsAir events have only zero-priced
  seeded types, so the guard never fires there.) Also an intentional asymmetry
  to record: CSV import allows typeless rows on a paid event (warns + reports an
  `uncategorised` count, relying on the completion-form flow); EventsAir hard-blocks.
  Fix options when picked up: (a) allow-null-with-warning like CSV for
  consistency (EventsAir rows can be sent completion forms too — the
  send-completion-emails route takes any non-cancelled, account-less
  registration), (b) add the fallback-type picker to the EventsAir dialog
  (mirror the CSV dialog's), or (c) keep the block + reword the error to say the
  type must be added via the API/no-op. Trigger: the first re-sync attempt into
  a priced event.
- **L1 — VIRTUAL rows at completion claim an in-person seat + in-person price.**
  The completion type-set ignores `attendanceMode`: a typeless VIRTUAL import
  that completes claims a ticket-type `soldCount` seat (virtual rows never hold
  one elsewhere — `holdsSeat()` is false, so a later cancel won't release it →
  permanent +1 counter leak) and stamps the in-person rate instead of
  `virtualPrice`. Rare path (typeless VIRTUAL CSV row on a priced event → person
  completes); fix = skip the seat claim + price via `virtualPrice ?? price` when
  the row's `attendanceMode` is VIRTUAL. Trigger: hybrid event importing virtual
  attendees without types.

### CRM adversarial review (July 24, 2026) — 0 BLOCKER / 0 HIGH; actionable fixes shipped, edges deferred

A 4-angle adversarial review of the whole CRM module (lifecycle · RBAC/PII/finance ·
concurrency · drift/logging) after it was surfaced in the sidebar + the July-24 email
work. **Verdict: 0 BLOCKER, 0 HIGH.** Security (cross-org IDOR across all 38 routes + 15
services, finance redaction, inbox staff-only, reply-forward audience not
inbound-injectable) and concurrency (conditional-claim on every transition, data-layer
idempotency on both workers) came back clean.

**Shipped** (see CLAUDE.md): M1 reply-forward-excludes-actual-replier (`f16c8020`), M2
persistent send dedup (`675708b6`), + the LOW cluster — `wonAt` re-stamp guard, Freshsales
owner-preserve, import P2002 messages, CRM 401 logging (`a044bc86`).

**Deferred / left as-is (owner-accepted edges):**
- **M2 residual scope** — the persistent dedup closes the realistic double-submit but does
  NOT resume a genuine crash MID-send (that was the heavier full-jobification path, not
  chosen). Sponsor fan-outs are small + fast, so the residual is narrow.
- **M3 — silent 401s are systemic, not CRM-specific.** Fixed at the CRM gate
  (`crm-route:unauthorized` log); the deeper cause is core `getOrgContext` returning null
  silently on every route in the app — a separate, app-wide decision.
- **Quote-number gaps on render failure** — the org-sequential quote counter commits before
  the PDF renders; a render/disk failure burns a number (gap). Accepted (an atomic counter
  can't roll back without reintroducing collision risk).
- **BEC same-domain residual** — `verifySender` treats a From-domain matching the
  counterparty domain as verified when SES emits no `dmarc=fail`; a spoof against a
  counterparty domain that publishes NO DMARC would pass. Acknowledged best-effort (the
  common cross-domain display-name spoof IS caught; tightening to require an explicit
  `dmarc=pass`/`spf=pass` would false-reject legit DMARC-less senders).
- **MCP `move_crm_deal_stage`** uses a fresh read as its `fromStageId` precondition (weaker
  TOCTOU guarantee than the REST route, which passes the stage the client saw) — documented
  + accepted (the MCP caller doesn't know the board's current state).
- **Enrich-forever `externalId` thrash** — an EA-born row matched by name across two
  conflicting-id exports can ping-pong its `externalId` (bounded — a genuine collision hits
  the unique index + surfaces as a row error). Edge.
- **Inbound worker 3-way tick overlap** — a spurious `crm-inbound:object-failed` log when a
  loser moves the object before the winner's own move (no correctness impact; the `s3Key`
  unique + P2002-before-forward keep the store/forward exactly-once).
- **Multi-tenancy (future platform, not now)** — the CRM email plumbing's global env vars,
  incl. the reply-forward cross-tenant leak, are recorded in
  [MULTI_TENANCY_IMPACT.md](MULTI_TENANCY_IMPACT.md) §7.1 as a hard precondition before the
  platform onboards a 2nd tenant. Harmless on single-org master.

### npm audit — security updates deferred by owner decision (July 23, 2026)

**Snapshot: 32 vulnerabilities (13 high, 16 moderate, 3 low), 0 critical** — owner chose "not now" (live
platform, no change window); schedule deliberately. Three buckets, in priority order:

1. ~~**Next.js 16.1.4 → 16.2.11 (the one that matters).**~~ **✅ SHIPPED July 23, 2026** (owner go-ahead
   after local verification) — all ~30 advisories cleared; the Turbopack standalone whole-repo-trace
   regression found during verification was neutralized via the Dockerfile standalone ALLOWLIST copy.
   Full applied record: docs/DEPENDENCY_UPGRADES.html §8a. Original rationale kept below for context.
   ~30 advisories against our exact version, the
   relevant ones for EA-SYS: **middleware/proxy bypass** (several variants — our `src/proxy.ts` RBAC
   redirects are affected, mitigated because the API layer is the authoritative gate, but the middleware
   confinement of ONSITE/CRM_USER/REGISTRANT is bypassable until patched), **SSRF in Server Actions /
   rewrites**, request-smuggling in rewrites, cache-poisoning/confusion of response bodies, and a pile of
   DoS vectors that matter on a self-hosted single box (image optimizer, PPR resume, connection
   exhaustion). It's a **minor** upgrade (16.1→16.2) but Next minors shift behavior — ship as its OWN
   commit/deploy with the full gate + e2e + a Playwright smoke (login, public register, dashboard,
   check-in), so it's independently revertable via the drilled 22s pinned rollback (docs/ROLLBACK.md).
   Also clears the bundled `sharp` + `postcss` advisories.
2. **`npm audit fix` (no `--force`) — ~25 transitive in-range patch bumps.** axios, form-data, undici, ws,
   dompurify, @sentry/*, qs, uuid, opentelemetry, etc. No semver-major, no API changes; one commit,
   full gate, deploy. Lowest risk of the three.
3. **Deliberate upgrades, NOT audit-driven (semver-major, moderate-only):** `@anthropic-ai/sdk`
   0.82 → 0.113 (touches the in-app AI agent + help chat) and `@modelcontextprotocol/sdk` (touches the
   MCP server — clients must reconnect after; bump `package.json` version). Each needs its own
   verification pass against the agent/MCP surfaces when picked up.

Re-run `npm audit` when picking this up — counts drift weekly. Suggested trigger: next quiet week with no
live event in the following 7 days; bucket 2 is the remaining deploy (bucket 1 shipped July 23).

### E2E suite drift — 15 standing local failures (July 23, 2026)

Surfaced by the Next 16.2.11 baseline diff (identical failures on 16.1.4 and 16.2.11 — NOT
upgrade-related; full listing in docs/DEPENDENCY_UPGRADES.html §8a). Three clusters: **(1) 12 ×
certificates API-contract specs** fail together on one root cause — the specs' admin API calls receive
403 where the contract expects 404/200, i.e. the test auth/session setup drifted from the app since
June 3 (prod cert flows fine in daily use); **(2) 2 × UI-drift specs** — `abstract-submitter.spec.ts`
(July 2 submitter-flow redesign) + `bulk-email-payment-filter.spec.ts` (dialog → workflow tiles;
already noted failing in May) point at locators that no longer exist; **(3) 1 × flaky
`rbac-redirects.spec.ts`** REGISTRANT redirect (`net::ERR_ABORTED` navigation race on the dev server).
Fix order when picked up: diagnose the shared 403 first (likely one fixture/session repair un-fails 12
specs), then rewrite the two drifted specs against the current UI, then stabilize or retry-tag the
redirect spec. Until then, local e2e runs must be compared against this known-failure baseline rather
than expected green.

### CI deploy speed — eliminate the duplicated `next build` inside the web Docker image (July 22, 2026)

**Backlogged by owner decision (option B of the deploy-speed pass).** Context: the July 22 measurement of
run 29911070770 showed `build-push` at 6.6 min (web 247s + worker 119s, serial). Option A — building the two
images as **parallel matrix legs** — shipped same day (`e813c64b`; first matrix run green, image-phase wall
clock now bounded by the web leg at ~4–4.8 min; deploy end-to-end ~7.5–8.5 min, was ~10).

**The remaining ~3 min is a straight duplication:** the gating `build` CI job runs `npx next build` on the
runner and discards the output, then the web Docker build re-runs the identical `next build` inside buildx
(the `COPY . .` layer invalidates on every code change, so the layer cache never saves it). The fix: the
`build` job uploads `.next/standalone` + `.next/static` + `public` + the generated Prisma client
(`node_modules/.prisma` + `node_modules/@prisma`) as an artifact; `build-push`'s web leg downloads it and the
Dockerfile becomes assemble-only (no `npm ci`, no `next build` in Docker). Expected: web leg ~60–90s,
**full deploy ≈ 5 min**.

**Why it's parked rather than done:** it restructures the deploy pipeline of a live platform. Care points for
whoever picks it up: (1) runner build env must match the runtime image — both are Node 24 / glibc x64 /
OpenSSL 3 today (`.nvmrc` vs `node:24-slim`), and the Prisma engine binary target (`debian-openssl-3.0.x`)
must be verified to load inside the slim image when generated on ubuntu-latest; (2) keep the on-box
`deploy.sh` fallback build working (it has no artifact — the Dockerfile needs both paths or a build-arg
switch); (3) artifact upload/download is ~100–200 MB each way (~30–60s) — net win only because the in-Docker
build is ~3 min; (4) `Dockerfile.worker` is unaffected (no next build inside it — its time is npm ci + push).
Verify with a full blue-green deploy + `/api/health` GIT_SHA check + a rollback drill re-run (docs/ROLLBACK.md
§1.6 — the pinned-rollback path must keep working against assemble-only images).

### Cross-caller duplication audit — deferred findings (July 21, 2026)

A repo-wide duplication audit (verified finding-by-finding against source before any fix — full report at
[docs/CODE_REVIEW_DUPLICATION_JULY21.html](CODE_REVIEW_DUPLICATION_JULY21.html), browseable at `/admin/docs`)
surfaced 11 cross-caller findings. The three ALREADY-DRIFTED clusters shipped same-day as gated commits:
`814224aa` (seat+promo accounting → shared guarded helpers in `registration-seat-db.ts`; fixed the unguarded
promo decrements that could drive `usedCount` negative + added the H6 promo re-claim on bulk reactivation),
`6b66649a` (`promo-code-service.createPromoCode` — MCP finally audits; REST finally event-binds `ticketTypeIds`),
`858a50cd` (`abstract-service.assignReviewer/unassignReviewer` — the twice-drifted H6/H8 pair is one
implementation). The post-ship adversarial review of the batches (0 BLOCKER / 0 HIGH / 3 MED / 5 LOW) had
M1 (relative-decrement clamp) + M2 (stable reviewer 500 bodies) + L2 (audit-log error-level restore) fixed
in-band. Deferred here:

**Second tranche SHIPPED July 21 (findings 4–7):** `56dcad12` (session roster ops → session-service:
`setSessionSpeakersTx` shared by updateSession + the new `replaceSessionRoster`, plus `addSessionSpeaker` /
`removeSessionSpeaker`; the three MCP roster executors are thin wrappers), `14540e81` (invoice status
transitions → shared `transitionInvoiceStatus` + new `markInvoiceOverdue`; REST invoice status changes are
audited for the first time; MCP delegates and gains the idempotency guard), `9e9f2ed0` (`rateLimited()`
canonical 429 in [src/lib/api-errors.ts](../src/lib/api-errors.ts) — NOT security.ts, it's the API-error
helper home — applied to all 7 call sites in the 4 files missing `Retry-After`). Post-ship review of the
tranche: 0 BLOCKER / 0 HIGH / 2 MED / 7 LOW; **M1 ("mcp-remote audit FK fails") was REFUTED** — migration
`20260418000000_seed_mcp_system_user` seeds the User row, the FK holds; L2/L3/L5 riders fixed in-band.
Still deferred:

- **M2 (owner decision) — no source-state machine on invoice status transitions.** The shared
  `transitionInvoiceStatus` only guards `status === target`, so a **PAID** invoice can be marked
  OVERDUE/CANCELLED (and CANCELLED → OVERDUE) from both REST and MCP, desyncing the invoice from Payment rows —
  same class the M6 target-set fix addressed. Pre-existing on both paths (not a regression); now that one
  transition path exists, a `PAID`/`CANCELLED`-source guard is a ~5-line change but changes behavior an operator
  may rely on — needs an owner call.
- **429 sweep remainder.** The ~100 already-compliant sites keep their inline 429s; migrate to `rateLimited()`
  opportunistically when a route is next touched (new code must use the helper).
- **M3 — bulk-status promo re-claim TOCTOU.** The MCP bulk executor computes its seat/promo maps from a
  pre-transaction `findMany` and the row `updateMany` is unconditional on current status, so two concurrent
  identical bulk reactivations double-claim promo usage (seat half is pre-existing + policy-accepted
  oversell-allowed; promo half is new surface). Condition the update on `status != target` or re-read in-tx when
  the executor is next touched.
- **L4 — promo-usage release not fully unified.** `promo-code-service.releaseExistingRedemption` still hand-rolls
  the guarded single decrement (same operation as `releasePromoUsage(count=1)`, now with different clamp
  behavior). The maxUses-gated increments (capacity-claim vs restore-claim) are semantically distinct and stay
  separate.
- **A4 — detail-sheet edit forms missing state/zipCode.** Both the registration detail sheet's edit mapping
  (`registration-edit-mapping.ts`) and the speaker detail sheet's `editData` omit `state` + `zipCode`, which the
  create forms (via `PersonFormFields`) collect — operators can set them but not fix them from the sheets. (The
  audit's tags/photo/website claims were verified WRONG — those are all editable.)
- **A6 — `speaker-enums.ts` extraction.** The speaker-status colour map is copied in FIVE files (speakers list,
  speaker detail page, speaker detail sheet, reviewers page, agenda page); the agenda copy has drifted (`-700`
  shades, CANCELLED dropped). Mirror the session-enums/abstract-enums pattern with exhaustive Prisma-enum-keyed
  Records.
- **A8 — one shared free/paid computation for registration create.** The add-registration dialog and the
  full-page form have identical attendee payload builders but diverged "is this free?" logic (the page resolves
  the CHOSEN pricing tier's price; the dialog only sees base price + active-tier presence). Extract the payload
  builder + `paymentStatusForSelection` into a shared module.
- **A5 is NOT here** — the CRM company/deal form-fields extraction fixing the edit-dialog free-text-country
  drift was already sitting uncommitted in the working tree when the audit ran; it ships with the CRM module work.

### Agenda break items (SessionType) review — July 21, 2026

Adversarial review of the break-items feature (SESSION vs REGISTRATION/BREAK/LUNCH/NETWORKING on
`EventSession.type`) returned 0 BLOCKER / 1 HIGH / 4 MED / 6 LOW. Shipped same-day: H1 (MCP roster
tools refuse break items), M2 (attached ZoomMeeting blocks conversion), M3 (webinar anchor session
can't be converted), M4 (form clears `abstractId` on conversion + surfaces the server's error in the
toast), L1 (agent dashboard/stats session counts exclude break items), L2 (conversion clears
lingering capacity). Deferred here:

- **M1 — check-then-act race on the break-item invariant.** `session-service` `validate()` reads
  `_count.speakers/topics` pre-transaction and the tx claim re-asserts nothing, so two interleaved
  updates (one converting to a break item with empty lists, one adding a speaker) can both commit,
  leaving a break item with a hidden roster. Narrow window; the next dashboard save self-heals it
  (submits empty lists). Fix when touched: re-check the invariant inside the tx after the claim, or
  condition the claim on `type` when the payload writes speakers.
- **L3 — HTTP-MCP clients can't convert a topic-bearing session.** The registered `update_session`
  Zod has no `topics`/`sessionRoles` params and no remove-topic tool exists (extends the pre-existing
  "MCP `update_session` schema omits `topics`" gap, M8 of the July 16 program/comms review). The
  dashboard is the workaround.
- **L4 — registration-page agenda preview renders break items as ordinary entries**
  (`speakers-agenda-preview.tsx` ignores `type`; cosmetic, no crash — name + time still read fine).
- ~~**Multi-track calendar layout**: on the dashboard multi-column (per-track) grid, a track-less
  break item renders in the "No Track" column rather than as a band spanning all track columns.~~
  **✅ SHIPPED July 23, 2026** — a multi-track event complained (BHS2026: adding a coffee break
  appeared to "create a new track"). Break items are now excluded from the track-column grouping
  and render as full-width muted bands spanning ALL track columns (`BreakBand` in the agenda page;
  bands sit at z-[5] below session cards at z-10, so a workshop running through lunch stays visible
  + clickable; breaks also bypass the track filter since they span the event). Verified visually
  against a seeded 2-track + 2-break day on the test DB.

### CRM module whole-module review (July 16, 2026) — ALL HIGHs + MEDs shipped, 8 LOWs deferred

First whole-module adversarial review (4 angles: RBAC/IDOR · concurrency/integrity · drift/logging ·
lifecycle/correctness): **0 BLOCKER / 4 HIGH / 12 MED / 17 LOW**. Full teaching report at
[docs/CODE_REVIEW_CRM.html](CODE_REVIEW_CRM.html) (browseable at `/admin/docs`). All 4 HIGHs, all 12
MEDs and 9 LOWs shipped same-day across 4 gated commits (`adc14bf9`, `9bb318a1`, `7ccf12cb`,
`f7beb16d` — see the report's status banner for the finding→commit map). Deferred here:

- **L3 — find-or-create silently reuses ARCHIVED companies/contacts.** `findOrCreateCompany` /
  `findOrCreateCrmContact` match on the normalized key regardless of `archivedAt` (correct dedup, but
  the caller can't tell it just attached work to a hidden record), and `validateRelations` accepts
  archived relation ids. Return an `archived: true` flag or auto-restore on reuse — product decision.
- **L6 — silent truncation.** Deals CSV export caps at `take: 5000`, the board list at 1000, with no
  marker — a capped CSV reads as "everything". Append a marker row / log when the cap binds.
- **L7 — subject-token asymmetry in the CRM email.** Body tokens tolerate `{{ eventName }}` spaces;
  the subject renders via `renderTemplatePlain` (no spaces) and receives the full vars map, so
  `{{message}}` typed in a subject dumps the whole HTML body into the subject line. Align the regexes
  and render subjects against the four contact/event tokens only.
- **L8 — double-greeting only hint-guarded.** The send pipeline bakes "Dear {{firstName}}," and an
  org-edited DB template starting with its own greeting produces two. Detect a leading greeting and
  skip the baked one (or lint on template save).
- **L10 — PATCH `{ archived, ...fields }` silently drops the field edits** in the archive branch of
  every record PATCH handler (deal/company/contact/task/template). Either apply both or 400 the
  combination. No UI sends both today; an API caller loses edits silently.
- **L13 — MEMBER sees rival reps' contact PII (email/phone) on the deal detail** — consistent with
  "only money is redacted", but if MEMBER can genuinely be a sponsor-side stakeholder, rival-rep PII
  is arguably as sensitive as deal value. Owner call; pairs with the shipped M2 (notes are now
  money-gated for MEMBER).
- **L14 — rep leaderboard: lost-only reps show 0 open / 0 won** (their losses invisible in their own
  row). Cosmetic — the win/loss card exists.
- **L16 — test gaps.** `pipeline-service.ts` still has no unit tests (seed idempotency, `createStage`,
  `deleteStage`'s `STAGE_HAS_DEALS` + P2003 race + the new `LAST_TERMINAL_STAGE` guard, `reorderStages`
  org-binding); the `STATUS_BY_CODE` error→HTTP mapping has no test.
- **L17 — the two deal dialogs carry a verbatim copy** of the company find-or-create + value-parse
  block. Fold into a helper next time either is touched.
- **M4 (second half) — no optimistic lock on record edits.** The shipped half computes History diffs
  from the submitted patch (no misattribution); concurrent edits to the SAME field are still silent
  last-write-wins. Adopt the house `expectedUpdatedAt` conditional claim (409 on a stale edit) when the
  edit dialogs next get touched.
- **L2 (second half) — a due task whose owner's User row was deleted never fires and never logs**
  (excluded by the reminder query's `ownerId: { not: null }` predicate; only the UI "Unassigned"
  surfacing mitigates). Add a periodic warn for owner-less due tasks.

### CRM review ROUND 2 (July 20, 2026) — 2 HIGHs + all 12 MEDs + 4 log/LOW riders shipped, rest deferred

Second whole-module adversarial pass ahead of the deploy decision (same 4 lenses; round-1 fixes all
verified to HOLD). **0 BLOCKER / 2 HIGH / 12 MED / ~19 LOW-INFO / 20 doc-rot items.** Full report at
[docs/CODE_REVIEW_CRM_R2.html](CODE_REVIEW_CRM_R2.html) (browseable at `/admin/docs`). Shipped
same-day in two batches: the HIGHs (`a918b1b5` — Freshsales enrich-forever + the CrmDealProduct
unique, migration `20260720120000`) and the full MED batch + riders L5/L6/L12/L14 (archived-freeze on
field edits/notes/line-items, conditional-claim archive/restore, FOR-UPDATE last-terminal-stage guard,
importer P2002-loser reuse + close-date preservation + dual-key in-file dedup + no-open-stage refuse,
assignee role-binding incl. the CSV owner map, archived-product block, shared report-service for
REST+MCP, `defaultOpenStage` helper, the one silent 404 + sponsor-email per-site logs, and the
MEMBER prose gate over task `description` + deal `lostReason` incl. the CSV column). pkg 0.4.21→0.4.22
(MCP behavior changed — clients reconnect). Deferred here:

- **L1 — gate-drift test is file-granular, not handler-granular** (+ its ≥9-handler floor is stale vs
  ~50): a future second handler in an already-gated file passes un-gated. Slice per exported function.
- **L2 — sponsor-email attachment allowlist bypassed by omitting `contentType`** (`if (t && …)`):
  require or infer the type (filename extension / magic bytes). Trusted-staff senders, caps hold → LOW.
- **L3 — MCP list tools filter drift vs REST** (deals: owner/date/value; tasks: "all" status + owner;
  companies: needsReview/industry) — close the gaps or document them in the tool descriptions.
- **L4 — dead ESLint boundary exemption** for `mcp-server-builder.ts` (zero `@/crm` references).
- **L7 — 4 mutations lack `onError`** (`useCreateDeal`/`useUpdateDeal`/`useCloseDeal`/`useSendCrmEmail`)
  — safe today (all callers try/catch `mutateAsync`); a future `.mutate()` caller fails silently.
- **L8 — find-or-create reuses ARCHIVED companies/contacts silently** (same as R1-L3; owner call:
  reuse-and-restore vs reuse-and-say-so vs refuse).
- **L9 — PATCH mixing `archived` with other fields silently drops the fields** (same as R1-L10).
- **L10 — a stage occupied only by ARCHIVED deals can't be deleted** and the error blames invisible
  deals; either auto-relocate archived deals or name the archived count.
- **L11 — unmapped-terminal-column divergence pocket**: a WON deal dragged out of one is reopened with
  no REOPENED trail entry; the reconcile script can strand WON deals in an open column.
- **L13 — reminders worker read-then-claim window** can email a just-reassigned task's previous owner
  (claim doesn't re-check `ownerId`). 5-min-tick micro-race.
- **L15 — two CONCURRENT identical re-assign PATCHes double-notify** the new owner (cosmetic).
- **L16 — sponsor-blast dedup is in-memory per-container** (documented posture; weaker than the event
  pipeline's `emailedKeys` resume — revisit if blast sizes grow).
- **L17 — dead export `CrmReportStatus`** in `reports.ts`.
- **L18 — `stripProseKeys` also eats `_count.notes` for MEMBER** (a number, not prose; note before
  "fixing the count" so the prose strip isn't removed wholesale).
- **L19/INFO — SUPER_ADMIN `x-org-id` override in `getOrgContext` is unvalidated** (core-wide, the
  CRM's only cross-tenant door; single-org moot — belongs in MULTI_TENANCY_IMPACT.md).
- **Doc-rot batch (20 items)** — CRM_STATUS.html §1/§2/§5 (MCP "NOT BUILT", "review NOT DONE", three
  inconsistent API counts, stale stage list, "name-bound close", model/enum counts, the
  "0 rows in prod" claim vs project memory — **owner to verify against prod**), src/crm/README.md §3.1/§5/§6,
  CRM_MODULE_PLAN.md header, the `CrmLifecycleStage` schema comment, MCP_REFERENCE.md (13 CRM tools
  missing), and CLAUDE.md's CRM_STATUS description. Fix as one docs commit.

### CRM products (catalog + deal line items) review (July 15, 2026) — H1 shipped, M/L deferred

Adversarial review of the new CRM product-catalog + deal-line-items feature: **0 BLOCKER / 1 HIGH /
3 MED / 5 LOW**. The core-correctness invariants were verified **solid** — IDOR/org-binding (every
`productId`/`dealId`/`lineId` bound to the org; exploit paths traced to 404s), finance-gating
(`price`/`unitPrice` redacted for MEMBER on every route; totals render "—", never a fake 0),
snapshotting (line items snapshot name/category at add-time), RBAC (archive = admin+CRM_USER), and
seed-once. **H1 was fixed in the same pass** (owner picked "just H1"); the rest are deferred here.

- **H1 — silent business rejections** ✅ **SHIPPED** — the service returned `DEAL_NOT_FOUND` /
  `PRODUCT_ALREADY_ON_DEAL` / `NAME_REQUIRED` etc. with no `apiLogger.warn` (violated the "every
  failure path logs" rule; the sibling deal/task services all comply). Fixed via a `reject()` helper
  that logs `crm-product:<code>` + context before every business `return { ok: false }`.
- **M1 — seed can double-seed** ✅ **SHIPPED** — `CrmProduct` has no unique constraint, so two concurrent
  first-loads (Products tab + a deal's product picker both firing `GET /api/crm/products` →
  `ensureCrmProducts`) can both see `count 0` and both insert 131 rows → a silent 262-row duplicated
  catalog; the "seed-race" catch can't fire. **Fix:** `@@unique([organizationId, sku])` + `skipDuplicates:
  true` on the seed createMany (nullable sku → manual no-SKU products stay distinct), and/or an
  advisory lock. **Fixed:** `@@unique([organizationId, sku])` (migration `20260715180000`) + `skipDuplicates: true` on the seed createMany, so a racing second seed skips every SKU-collision; comment corrected.
- **M2 — mixed-currency products total** ✅ **SHIPPED** — `sumDealProducts` adds `unitPrice × qty` across
  line currencies and labels the total with line 0's currency; and the catalog defaults to **AED**
  while a deal defaults to **USD**, so the products total (AED) sits beside the deal Value (USD) with no
  distinction. **Fix:** constrain a deal's line items to one currency (validate on add against the
  deal's), or have `sumDealProducts` return null / group-by-currency when currencies differ and surface
  the currency. **Fixed:** `sumDealProducts` returns null when line currencies differ (and stays null when a price is redacted); the deal Products card shows "— (mixed currencies)". +4 tests.
- **M3 — product dialog keeps stale state** ✅ **SHIPPED** — `CrmProductDialog` (create) is always mounted;
  Radix unmounts only the portal, so after creating a product and reopening "New product" the fields are
  pre-filled with the last entry → easy accidental near-duplicate. **Fix:** remount on open via `key` or
  reset state on the closed→open transition. **Fixed:** both the create and edit `CrmProductDialog` are keyed by their open state, so each open remounts with fresh values.
- **L1 — duplicate line-on-deal race (deferred).** The `PRODUCT_ALREADY_ON_DEAL` guard is `findFirst`
  then `create` with no `@@unique([dealId, crmProductId])` → two concurrent adds of the same product
  both pass. Add the unique index (tolerate nullable `crmProductId`) + translate P2002.
- **L2 — line-item money rounds off cents (deferred).** Line rows reuse `formatDealValue`
  (`maximumFractionDigits: 0`), so seed prices like `6422.5` render "AED 6,423". Add a 2-fraction-digit
  money formatter for product/line-item prices (keep 0 digits for headline deal values).
- **L3 — line qty/price edits not in the deal History (deferred).** `updateDealProduct` records no
  `CrmActivity` (only add/remove do). Consider a `PRODUCT_UPDATED` entry (weigh against timeline noise).
- **L4 — seed data quirks (deferred, source data).** All 65 Out-Sourced rows have placeholder `price: 1`
  (the org fills the real price per deal — line price is manual anyway); "Communcation"/"Fullfilment" are
  typos in the source names. Left faithful to the QuickBooks export; clean up during a catalog pass.
- **L5 — line input goes stale after external refetch (deferred).** `LineItem`'s `qty`/`price` local
  state is seeded once; a concurrent server-side change to the line isn't reflected until retyped. Minor.

## Current Release — July 10, 2026

### Check-in & badges review (July 10, 2026) — ALL 8 HIGHs SHIPPED (Phases 1-3), MEDs/LOWs deferred

A 4-angle production review of the check-in + badges domain ahead of real conferences with 500–2000
in-person attendees: **0 BLOCKER / 8 HIGH / 7 MED / 4 LOW**. Full report:
[docs/CODE_REVIEW_CHECKIN_BADGES.html](CODE_REVIEW_CHECKIN_BADGES.html). **Phase 1 (door correctness — H1/H2/H3/M7) shipped `706ba17`; Phase 2 (credential exposure — H6/H7/H8/L4) shipped `aac727a`; Phase 3 (Print All + logging — H4/H5) shipped `935c1f7`.** All 8 HIGHs done; the MEDs/LOWs below are deferred. Severity is calibrated: 0 BLOCKERs because no barcode leak is
reachable by an arbitrary unauthenticated caller (all require an org-attached account or an unguessable
cuid), unlike the same-day sessions blockers.

**Fix these before the next live event (door-day):**

- **✅ H1 (SHIPPED `706ba17`) — the admission gate and the badge filter disagree about who is attending.** `badges/route.ts:78-83`
  re-implements "no money due" as `PAID || complimentary`, dropping **INCLUSIVE** (sponsor-paid) and
  **UNASSIGNED** (pay-at-desk) — while `checkInGate` admits them (it blocks only UNPAID/PENDING). The
  canonical set `NO_PAYMENT_DUE_STATUSES` already includes INCLUSIVE. A sponsored VIP scans in fine and
  gets no badge; selecting only that sponsor block yields the 400 *"No paid or complimentary registrations
  found"*, which blames them for not paying. Fix: use the canonical set; decide UNASSIGNED policy.
- **✅ H2 (SHIPPED `706ba17`) — THERE IS NO UNDO.** `checkedInAt: null` is never written anywhere in `src/`; the general
  registration PUT references `checkedInAt` zero times. Flipping status back to CONFIRMED leaves the
  timestamp set, so `checkInGate` refuses that person **forever** while the attendance tile says they're
  not in. CLAUDE.md advertised "(+ undo)" — **corrected in this commit**. Fix: an audited `undoCheckIn()`
  in `check-in.ts` that clears status + `checkedInAt` together.
- **✅ H3 + M7 (SHIPPED `706ba17`) — concurrent double-scan has no conditional claim.** `check-in.ts:76` reads `checkedInAt`, `:114`
  commits with an unconditional `update` by id. Two stations (or two tabs — the 2s debounce is a per-tab
  `useRef`) both pass the gate and both write: the true first-entry time is clobbered, and audit rows +
  admin notifications duplicate. Schema has no unique/partial index on `checkedInAt`. Fix is one line:
  `updateMany({ where: { id, checkedInAt: null } })`, `count === 0` → ALREADY_CHECKED_IN. **Also closes M7**
  (two concurrent `allowCancelled` overrides double-increment seat AND promo counters).
- **✅ H4 (SHIPPED `935c1f7`) — "Print All" is unbounded** in N with unbounded `bwip-js` fan-out (`Promise.all` over up to 2000
  rows) and builds the whole PDF in-request, on the same swapless box that serves the live scanner and the
  Stripe webhook. This is the concrete content of the readiness audit's "bulk badge Print All is fragile".
  Fix: `take` cap + `p-limit` + ideally move the render to the worker tier.
- **✅ H5 (SHIPPED `935c1f7`) — the unknown-barcode scan 404 logs nothing** (`check-in/route.ts:147`), nor does the **ONSITE
  cross-event denial** (the exact adversarial case the July-7 isolation tests defend), nor the badges 400
  or the DTCM import 400s. At a live door you cannot answer "why did that badge not scan?" from `/logs`.

**Credential exposure (insider-scoped, same class as the July-10 sessions blockers):**

- **✅ H6 (SHIPPED `aac727a`) — `FINANCIAL_KEYS` omits `qrCode`/`dtcmBarcode`**, so `redactFinancialFields` — the only redaction
  pass that runs on both registration GETs for non-finance roles — never strips the physical-access
  credential. This is the amplifier; fixing it closes the payload half of H7 + H8 in one place.
- **✅ H7 (SHIPPED `aac727a`) — the registrations LIST GET has no `denyReviewer`** (the one at `:306` guards the POST) and uses
  `include:`, so every attendee's `qrCode` + `dtcmBarcode` is returned to any org-attached caller —
  including **MEMBER** (documented as sponsor-side stakeholders/auditors) and internal-domain
  **REGISTRANT**s. One call yields enough to clone a badge and walk someone through the door.
- **✅ H8 + L4 (SHIPPED `aac727a`) — two IDOR paths.** The detail GET uses bare `auth()` with the row scoped `{ id, eventId }` (not
  user-scoped), so an external REGISTRANT with a registration in the event can fetch any other
  registration's barcode by id. And `registrant/registrations/[id]/barcode/route.ts:43-51` org-scopes its
  staff branch instead of routing through `buildEventAccessWhere`, letting an **ONSITE** temp assigned to
  Event A pull a scannable barcode for Event B — the July-7 class, on a route that fix didn't touch. Both
  need an unguessable cuid; **H7 is what defeats that mitigation.** **L4**: that route also has no rate limit.

**Gate policy + import integrity (MED/LOW) — door-day batch SHIPPED July 11, 2026:**

- **✅ M1 (SHIPPED July 11)** — audited desk override for a payment-blocked attendee. Owner decision: the
  override covers **any** payment block (webhook-lagged PENDING, UNPAID, …). `checkInGate` gained
  `allowPaymentDue`; the check-in POST accepts `{ overridePayment: true }` (desk-gated), logs
  `check-in:payment-override` at warn and audits `paymentOverride` + `paymentStatusAtOverride`; the
  registration detail sheet offers "Admit anyway (override)" when a check-in is refused PAYMENT_REQUIRED.
- **✅ M2 (DECIDED July 11 — no change, now explicit)** — owner call: `FAILED` and `REFUNDED` stay
  **admitted** at the door (a failed charge attempt / goodwill refund doesn't bar the person from the
  venue). ⚠️ REVERSED Aug 27, 2026 — the door now admits only PAID/COMPLIMENTARY/INCLUSIVE. Pinned in `isPaymentAdmissible` + a truth-table test so it can't be "fixed" without a
  new product decision. The desk reinstate half remains via the detail sheet's normal flows.
- **✅ M3 (SHIPPED July 11)** — DTCM import now runs **every row in its own try/catch**: a P2002
  unique-collision (concurrent import) becomes a per-row error, anything else a generic per-row error with
  a server-log pointer — the import report always survives.
- **✅ M4 (SHIPPED July 11)** — the email lookup is deterministic: prefers a **non-cancelled** registration,
  newest first (falls back to newest overall).
- **✅ M5 (SHIPPED July 11)** — a successful scan invalidates the registrations query so the attendance
  counter tracks the door live instead of freezing for up to 5 min.
- **✅ M6 (SHIPPED July 11)** — a network drop mid-scan now produces the failure beep, an explicit
  "Network error — NOT checked in" Recent-Scans row, and a toast; the 2s same-code debounce is cleared so
  an immediate retry of the same badge isn't swallowed.
- **L2 (partial July 11)** — replacing a *different* existing barcode on re-import is now warn-logged
  (`barcode-import:overwriting-existing-barcode`); a visible per-row report entry remains open.
- Still open: L1 the scan `OR`s across two independent unique domains with no `orderBy`; L3 MCP
  `check_in_registration` short-circuits the shared gate.

**Explicitly NOT a finding:** the desk check-in path has no rate limit, and that is **correct** — a hardware
scanner legitimately fires many scans/sec, the endpoint is authenticated and desk-gated, and the in-memory
limiter is per-container and resets on deploy. The exposure there is idempotency (H3), not volume.

**Verified clean:** the June `check-in.ts` unification held (`checkedInAt` written in exactly one place;
all three callers share `executeCheckIn`); audit + notification cannot 500 a committed check-in on any
path; barcode rendering is centralized across all five callers; the scan lookup is event-scoped (a
wrong-event badge 404s); sequential double-scan IS idempotent (only the concurrent case races); the July-7
ONSITE fix holds on the five routes it touched; DTCM is never substituted for the entry barcode.


### Survey + Dinner RSVP review (July 13, 2026) — ✅ **B1 CLOSED (Aug 7, 2026)**; everything else in the batch shipped

First independent review of the last un-reviewed domain: **2 BLOCKER / 5 HIGH / 8 MED / 5 LOW** — the most
severe result of any domain. Full report (teaching format):
[docs/CODE_REVIEW_SURVEY_RSVP.html](CODE_REVIEW_SURVEY_RSVP.html).

> ## ✅ CLOSED (Aug 7, 2026) — B1: anyone could submit a survey AS another attendee, minting their CME certificate
>
> **Fix shipped — option (a), owner-selected.** The share page is now a **gateway, not a form**:
> it takes the typed email and, if it matches a registration, **emails that address the same
> per-registration `?token=` link the bulk-email invitation mints** (256-bit secret, stored hashed,
> single-use, TTL-bounded). It never submits answers and **never stamps `surveyCompletedAt`** — so
> the certificate trigger can no longer be reached by asserting an identity. A stranger who types a
> victim's address now merely causes the real attendee to receive their own link.
>
> Also closed in the same change: **M1, the enumeration oracle** — the endpoint returns one
> identical generic message for registered / unregistered / already-completed, so it can't be used
> to test whether a named physician attended.
>
> **Rate limiting was re-shaped for the intended use.** The share request is dispatched *before* the
> submit limit (10/15min/IP, calibrated for one-submit-per-person) and carries its own: **100/15min
> per IP** (room-scale — a whole hall scans the QR from one venue-NAT egress IP, the same failure
> mode that got the ipHash dedup removed in H1) plus **3/hr per email address** to stop mail-bombing
> one person. The per-email limit deliberately returns the *same generic 200* rather than a 429,
> because any status that varies with the email would re-open the oracle. Pinned by a regression
> test asserting exactly two limit checks on the share path.
>
> **Files:** [survey/route.ts](../src/app/api/public/events/%5Bslug%5D/survey/route.ts)
> (`handleShareRequestLink`), [survey/page.tsx](../src/app/e/%5Bslug%5D/survey/page.tsx)
> (share mode renders the gateway + a "check your inbox" panel).
> **+7 tests** in [public-survey-route.test.ts](../__tests__/api/public-survey-route.test.ts) pinning:
> no stamp / no `SurveyResponse` even when answers are supplied (the old exploit shape), token mint
> + email with a `?token=` link, non-enumeration byte-equality, already-completed still gets a link,
> invalid + expired share tokens, per-email limit returns generic 200, and the dispatch-ordering guard.
>
> **The lesson (worth carrying):** the share link shipped when `surveyCompletedAt` was *just a
> feedback flag* — trusting a typed email was a defensible trade at the time. Certificate auto-issue
> later **promoted that flag into a credential-issuing trigger**, and nobody went back to re-audit
> who was allowed to set it. **When a field becomes a credential trigger, re-audit every writer of
> that field.**
>
> <details><summary>Original blocker write-up (historical)</summary>
>
> **Do not run a conference that issues CME certificates off a broadcast survey link until this is closed.**
>
> The survey share link (designed to be posted publicly — a slide, WhatsApp, an email signature) resolves the
> respondent **purely from the email they type into the form** — no proof of mailbox control. That submit
> stamps `Registration.surveyCompletedAt`, which is exactly what the certificate auto-issue sweep polls on
> (`auto-issue.ts`: `surveyCompletedAt: { not: null }`).
>
> So a stranger who knows an attendee's email (routinely public for medical faculty) can:
> 1. **auto-issue a real, serialized, audited CME certificate in that person's name** off garbage answers;
> 2. **permanently lock the real attendee out** — `SurveyResponse.registrationId` is `@unique` and the flag is
>    set, so their own link returns `alreadyCompleted` forever, and there is no organizer "reset survey";
> 3. poison the accreditation dataset with forged answers attributed to a named physician.
>
> **How it happened** (the lesson): the share link shipped June 9, when `surveyCompletedAt` was *just a feedback
> flag* — trusting a typed email was a defensible trade. Certificate auto-issue shipped June 25 and **promoted
> that flag into a credential-issuing trigger**; its own comment reads *"the survey POST path is UNTOUCHED — it
> already sets surveyCompletedAt."* Nobody went back to ask who was allowed to set it.
>
> **Needs an owner decision** (each changes the attendee's experience):
> - **(a) Email them their link (recommended)** — the share page becomes "enter your registered email → we'll
>   email you your survey link", reusing the EXISTING secure per-registration token path. Turns an assertion
>   into a proof; also closes M1 (the enumeration oracle). Costs one step: the attendee checks their phone.
> - **(b) Share = feedback, never a certificate** — direct submit stays but doesn't stamp `surveyCompletedAt`.
>   Keeps the frictionless closing-slide flow; breaks "fill the survey to get your certificate" for share users.
> - **(c) Retire the share link** — only the emailed per-registration token works. Simplest + safest; removes a
>   feature organizers use.
>
> ### Live exposure (checked against prod, 2026-07-13) + the interim mitigation
>
> Of **29 events, exactly one has a survey share link generated**: **OSH Monthly Meeting 2026**
> (`/e/osh-mm-june2026`), PUBLISHED, link **live until 2026-07-18**. That event has **37 non-cancelled
> registrations, only 2 of whom have completed the survey** — so **35 are forgeable** — and **4 certificate
> templates, all with `autoIssueOnSurvey = true` and a tag**. A forged submit there today mints a real CME
> certificate. (The token has also been pasted into a chat window, which is exactly how bearer links leak.)
>
> **Interim mitigation — no code, no deploy, and it costs the organizer nothing:**
> **Survey builder → Shareable link card → Disable.** Attendees never receive the share link in the normal
> flow: Communications → *Send Survey Invitations* mints a **per-recipient `?token=` link inside each
> attendee's own email**, which is the secure path and is unaffected. Disabling the share link only removes
> the broadcast option (QR on a closing slide / WhatsApp blast). **Disable, don't regenerate** — regenerating
> mints a fresh bearer token with the same design flaw.
>
> Deliberately **left open** (owner call, 2026-07-13) rather than picking a mechanism under time pressure.
> Revisit before the next CME event that wants a broadcast survey link.
>
> </details>
>
> **Live exposure at close (re-checked 2026-08-05, read-only):** the one share link ever generated
> (`osh-mm-june2026`) had **expired on 2026-07-18** on a `COMPLETED` event, and **0 survey tokens
> were outstanding** — so the window was never exploited in practice. 4 templates still had
> `autoIssueOnSurvey = true`, i.e. the machinery stayed armed and would have re-opened the hole the
> moment an organizer generated a new share link. Whole-feature usage at close: **2 survey responses
> ever**, so the fix carried no migration and broke no established habit.

**Shipped** (Blockers+HIGHs batch, minus B1):
- **✅ B2 (`220d421`) — editing a dinner wiped its venue, description and RSVP deadline.** The roster GET (the
  console's ONLY source of dinners) selected `{id, name, dinnerAt}`; the edit dialog read the missing fields as
  blank and PUT them back as `""`/`null`, which the PUT reads as an explicit CLEAR. Fixing a **typo in a
  dinner's name** erased its venue and set `rsvpDeadline = NULL` — so **RSVP for that dinner never closed
  again**. The client's `Dinner` interface always *declared* those fields; nothing enforced that the API sent
  them.
- **✅ H5 (`220d421`) — dinner times drifted by the UTC offset on every save** (`iso.slice(0,16)` into a
  `datetime-local`, which the browser reads as local). A 19:00 Dubai gala opened showing 15:00 and *moved* there
  on save; save again → 11:00. New `src/lib/datetime-local.ts` is the one lossless pair.
- **✅ H2 (`1ea4a92`) — the RSVP roster handed out the invite token** (an impersonation credential: it lets
  anyone POST the *public* rsvp endpoint with no login and rewrite a professor's attendance) plus the VIP guest
  list, to MEMBER / cross-event ONSITE / internal-domain REGISTRANT. Now `denyReviewer` + `buildEventAccessWhere`.
- **✅ H1 (`1ea4a92`) — the survey "soft IP dedup" locked an entire conference room out.** Keyed on IP, not
  registration → everyone on the venue WiFi shares one NAT IP → QR on the closing slide, first submit lands,
  **everyone else gets 429**, window never empties → they never complete the survey → **they never get their
  certificate**. It was also redundant (the `@unique` already handles the double-click). Deleted.
- **✅ H3 (`c7a2faf`) — the thank-you sweep starved everyone but the newest 100** (took 100 newest, filtered
  already-thanked *after* the take). On a 400-completion conference ~300 people never got the thank-you — the
  email carrying their certificate — while the sweep logged a healthy `scanned: 100` forever.
- **✅ H4 (`c7a2faf`) — MCP `list_dinner_rsvps` computed the caterer's headcount over one truncated page**
  (~25% under-order on a 260-invitee event; and `status:PENDING` made every dinner report 0 seats).

**Deferred:**
- **M1 — the share submit is a registration-enumeration oracle** (unknown email 404s, known one proceeds), so
  anyone with the broadcast link can test emails against a named medical conference's roster. *Closed
  automatically by B1 option (a).*
- **M2 — a speaker who is also a delegate** has two registrations on one email; the share path picks one
  arbitrarily, so the completion stamp can land on the hidden faculty companion while the delegate row stays
  "not completed" and its certificate never issues.
- **M3 — deleting a survey question after responses exist** makes those answers vanish from the dashboard AND
  the CSV with no warning (the data survives in JSON but is unreachable from every operator surface).
- **M4 — a withdrawal is silently partly ignored.** The replace-all only covers dinners whose deadline hasn't
  passed, so "I can't attend any of the dinners" leaves a past-deadline *Yes +2* intact — while the invitee sees
  the full "your RSVP has been recorded" screen. Three covers get plated for someone who told you they weren't
  coming.
- **M5 — the import picker includes CANCELLED registrations** (no status filter, no badge) → cancelled people
  get invited to the gala.
- **M6 — a deactivated dinner still feeds the organizer headcount + CSV** while hidden from invitees; those
  stale responses can never be cleared (the public replace-all only touches active dinners), and reinstating the
  dinner resurrects every original "Yes".
- **M7 — 8 unlogged 4xx branches in the SURVEY routes.** (The CLAUDE.md "every failure path logs" claim for
  **Dinner RSVP was independently verified and HOLDS** — zero silent 4xx. Survey is where the rule breaks.)
- **M8 — doc drift on a security boundary:** both survey-responses routes claim "MEMBER allowed (read-only)",
  but `denyReviewer` 403s MEMBER. The behaviour is the safe one; the comment is a lie in a security-relevant
  place, and the denial logs as `auth-guard:write-denied` on a *read* route.
- **LOWs:** RSVP tokens never expire / can't be rotated (permanent bearer credential in a URL path);
  `?preview=1` is unauthenticated, works for DRAFT events, and survives share-link revocation; the send route
  shares one 10/hr bucket between bulk and single-invitee sends (429 on the 11th nudge); `target:"all"` re-mails
  everyone including those who already replied.

**Verified clean:** the per-registration survey token is hashed at rest, slug-bound, one-time-use, and its
delete + the response write + the completion stamp are all in ONE transaction; `SurveyResponse.registrationId
@unique` genuinely prevents a duplicate response (P2002 caught as an idempotent 200), so re-submitting can't
mint a second certificate; answers are strictly validated against the config; both CSV exports use
`escapeCsvCell`; the RSVP token is 192-bit CSPRNG and event-slug-bound (no cross-event replay); the share-link
compare is timing-safe AND correctly ordered (token before expiry); the public RSVP submit is a
server-authoritative replace-all under a row lock; bulk-add dedup is race-safe.


### Accommodation / hotels review (July 13, 2026) — security + counter batch SHIPPED, visibility/hygiene deferred

First full 4-angle review of the accommodation + hotels domain (booking lifecycle · RBAC/info-exposure ·
concurrency/counter integrity · drift/duplication/logging): **0 BLOCKER / 8 HIGH / 10 MED / 5 LOW** — the worst
of any domain so far, because these routes predate the IDOR + logging sweeps applied everywhere else. Full report
(written as a teaching document — every finding has the buggy code, the failure, the fix, and a
"what a junior dev should learn" box): [docs/CODE_REVIEW_ACCOMMODATION.html](CODE_REVIEW_ACCOMMODATION.html).

**Shipped** — everything that leaked a credential or corrupted a counter:
- **✅ H1 (`7fcb256`)** — cross-tenant IDOR: all three `rooms/[roomId]` handlers resolved the room by
  `{ id: roomId, hotelId }` and never bound the hotel to the org-verified event (the sibling `rooms/route.ts` did).
  Now binds the full chain.
- **✅ H2 (`7fcb256`)** — the booking GETs/PUT returned the full `Registration` row via `include`, leaking `qrCode` +
  `dtcmBarcode` (door credentials) past the July-11 barcode-visibility boundary. Now an allow-list `select` +
  composed redaction.
- **✅ H3/H5/H6/M1/M4 (`71ce307`)** — the counter family, fixed as ONE shared `planRoomTransition()` + guarded
  `releaseRoom()` / atomic `claimRoom()` rather than five patches.
- **✅ H4 (`ce7ae60`)** — `Accommodation` cascade-deletes from Registration/Speaker, so deleting a person silently
  lost their room forever. `releaseRoomForDeletedPerson()` on all three cascade paths +
  `scripts/reconcile-bookedrooms.ts`. **Prod dry-run: 6 room types, 0 drift** (accommodation is lightly used — which
  is why these hadn't bitten yet, not evidence they were harmless).

**Deferred:**

- **H7 — ~30 unlogged failure paths.** Includes three *business* 400s operators actually hit
  ("Cannot delete hotel with existing bookings", "Cannot delete room type with existing bookings",
  "Total rooms cannot be less than booked"). Worse: the **REST create path logs none of the service's ten rejection
  codes** — while the MCP twin auto-logs via `runTool`, so the same failure is visible when an agent causes it and
  invisible when a human does. During a live event, room assignments failing produces nothing in `/logs`.
  (Phase 1 logged the security-relevant denials on the routes it touched; the rest of the sweep is open.)
- **H8 + M10 — the UI silently swallows errors.** `handleHotelSubmit` / `handleRoomSubmit` / `handleDeleteHotel` in
  [accommodation/page.tsx](../src/app/%28dashboard%29/events/%5BeventId%5D/accommodation/page.tsx) are
  `if (res.ok) { … }` with **no else** — the operator confirms a hotel delete, the server refuses with
  "has existing bookings", and *nothing appears on screen*. The assign dialog maps a failed fetch to `[]` →
  "No registrations for this event yet" on an event with 800 registrants. (`fetch` doesn't throw on 4xx/5xx —
  the classic mistake. Note `handleStatusUpdate` in the same file does it correctly.)
- **M2 — guest count validated on create, never on edit.** The PUT's Zod only checks `min(1)`, so a booking can be
  edited to 6 guests in a 2-person double, or moved into a single-occupancy room. The hotel gets a rooming list that
  doesn't fit in the rooms.
- **M3 — no server-side status state machine.** REST + MCP accept **any → any**; only the UI's buttons constrain the
  flow. An agent told "mark everything checked out" can push a CANCELLED booking to CHECKED_OUT — and the applier
  then *re-claims a room* for it.
- **M5 — a lost create race returns an opaque 500.** The duplicate-assignee check is a pre-tx read; the `@unique`
  correctly stops the loser but `P2002` isn't recognised, so it surfaces as `UNKNOWN` with a raw Prisma string
  instead of `REGISTRATION_HAS_ACCOMMODATION` (and the MCP auto-pivot hint never fires).
- **M6 — finance redaction on the list routes but not the detail routes** (5 sibling read paths). No live leak today
  (every org-bound role is finance-capable) but the boundary is already broken next door.
- **M7 — hotel/room CRUD `await`s the audit write with no catch** → an audit blip 500s a request whose mutation
  already committed. The accommodation routes do it correctly (fire-and-forget with logged catch).
- **M8 — `AccommodationStatus` hardcoded in four places** (two duplicate Sets in the MCP file alone; `z.enum` vs
  `nativeEnum`; a non-exhaustive UI colour map). Adding a status value breaks three surfaces with **no build error**
  — unlike `registration-enums.ts`, where TS fails the build.
- **M9 — MCP `create_hotel` writes no AuditLog row** (its sibling room-type tools all do).
- **LOWs:** L1 the assignee refine is "at least one", not "exactly one" — one booking can consume BOTH a
  registration's and a speaker's `@unique` slot; L2 no rate limit anywhere in the domain; L3 room-type DELETE races
  its own `_count` guard (raw FK 500 instead of 400) + a REST/MCP parity gap (REST refuses, MCP soft-deletes);
  L5 copy-paste comments from other domains in the MCP file ("Media Executor", "A4: Invoice CREATE / SEND flow").

**Verified clean:** both create callers genuinely delegate to `accommodation-service` (no duplicated create logic);
status transitions genuinely share the applier across REST + MCP; the create-path capacity claim and the MCP re-book
are atomic; every write handler has `denyReviewer`; every route binds the event to the caller's org — which is why
H1 needed a *second* id to exploit rather than being wide open.


### Communications / bulk-email review (July 11, 2026) — anti-double-send batch SHIPPED, rest deferred

A 4-angle production review of the communications / bulk-email domain (send lifecycle · RBAC &
info-exposure · concurrency & idempotency · drift/duplication/logging): **0 BLOCKER / 2 HIGH / 7 MED /
6 LOW**. Full report: [docs/CODE_REVIEW_COMMUNICATIONS.html](CODE_REVIEW_COMMUNICATIONS.html). The send
core is genuinely well-built (logContext threaded everywhere, no swallowed send errors, atomic row claims,
a real slug-drift test). The user chose the **anti-double-send batch**; shipped in three gated phases:
**Phase 1 (`fadfc44`)** — H2 enqueue dedup + M2 synchronous viability precheck + M3 lossy-filters-edit
removal; **Phase 2 (`1e7c45e`)** — M1 worker heartbeat + conditional completion; **Phase 3 (`5d03569`,
additive migration `20260711120000`)** — H1 per-recipient idempotency (`ScheduledEmail.emailedKeys`) which
also closed M6.

- **✅ H1 (SHIPPED `5d03569`)** — `executeBulkEmail` had no per-recipient idempotency; a retry after a
  genuine crash re-emailed everyone already sent. New `emailedKeys String[]`; the send skips already-emailed
  ids and appends each batch's sent ids, so a retry resumes.
- **✅ H2 (SHIPPED `fadfc44`)** — non-idempotent "Send now" enqueue; a double-click / HTTP-retry made two
  identical `ScheduledEmail` rows and the worker drained both (whole audience twice). Best-effort content+2min
  dedup window returns the existing jobId.
- **✅ M1 (SHIPPED `1e7c45e`)** — the 10-min stuck-sweep keyed on `updatedAt` with no heartbeat, so a
  legitimately long send was falsely FAILED mid-flight and resurrectable into a concurrent second send; the
  terminal write was unconditional-by-id. Now a 2-min heartbeat + conditional (`status=PROCESSING`) completion.
- **✅ M2 (SHIPPED `fadfc44`)** — viability deferred to fire time → green "queued" toast then a FAILED row a
  minute later. Extracted `precheckBulkEmailViability`; both the enqueue + schedule routes call it synchronously.
- **✅ M3 (SHIPPED `fadfc44`)** — schedule-edit PATCH replaced the whole `filters` JSON with a
  `{status,ticketTypeId}`-only schema, stripping send-critical keys. `filters` removed from the edit schema.
- **✅ M6 (SHIPPED `5d03569`)** — survey-invitation token re-mint (`deleteMany`+`create`) broke the first
  email's link on a re-run; now the skip filter means an already-emailed recipient's token is never touched.

**Deferred (pick up when a related issue surfaces):**

- **M4 — `email-preview` org-null collapse.** [email-preview/route.ts:51](../src/app/api/events/%5BeventId%5D/email-preview/route.ts)
  uses `...(organizationId ? {organizationId} : {})` instead of the explicit `organizationId!` its five sibling
  routes use. Not currently exploitable — `denyReviewer` blocks every org-null role before the query — but the
  isolation depends on the guard's block-set ordering, not the query. Fix: bind org explicitly for parity, so a
  future org-null role that passes the guard can't POST another org's eventId and read a real registrant's
  confirmation number.
- **M5 — recipient-count predicate triplicated.** `countRegistrations`/`countSpeakers` are hand-copied across
  communications/registrations/speakers pages, each independently mirroring `executeBulkEmail`'s `where`. The
  **speakers-page copy already omits the `sessionRole` filter** the backend applies — latent only because that
  surface doesn't yet pass `sessionRoleFilter` to the dialog. Fix: a shared `matchesBulkEmailFilters()` client
  helper so count == send can't drift.
- ~~**M7 — a bad filter value silently widens the audience, unlogged.**~~ ✅ **SHIPPED July 13, 2026** —
  new `assertValidBulkEmailFilters()` ([bulk-email.ts](../src/lib/bulk-email.ts)) rejects any unparsable
  `status` (per recipient type: Speaker/Registration/Abstract enums) or `paymentStatus` token (ANY invalid
  token in a comma list rejects — "PAID,COMPLIMENTRY" must not silently narrow either) with a 400
  `INVALID_FILTER` BulkEmailError; the "all" sentinel passes as no-filter. Called from
  `precheckBulkEmailViability`, so the enqueue + schedule routes 400 synchronously AND a legacy persisted
  row fails loudly (FAILED + admin notify) at fire time instead of over-sending. Also closed the LOW
  abstracts `status as never` cast (now a validated safeParse — no more cryptic Prisma throw). +9 tests.
- **LOWs:** unlogged post-auth rejection cluster (schedule lead-time 400 + several 404s — the silent-4xx class);
  ~~abstracts recipient path uses an unchecked `status as never` cast~~ (✅ closed with M7, July 13);
  `presentationDetails` embeds session/topic/track names raw in agreement emails
  (same class as the `{{abstractTitle}}` fix, trusted today); `email-preview` has no rate limit; the legacy
  `/api/cron/scheduled-emails` route lacks the advisory-lock wrapper (safe today via the atomic per-row claim —
  informational); the advisory lock is a no-op under the pgbouncer transaction pooler (documented P3 — matters only
  if a 2nd worker is ever run, e.g. Singapore DR failover).

**Verified clean:** every send outcome (per-recipient failure, whole-row failure, retry, benign 0-recipient
skip, stuck-row sweep) produces a findable log line; `logContext` is threaded through both the bulk and
cert-bundle send paths (no orphan EmailLog rows); the `email-template-slugs.ts` system-vs-custom classifier has
a real drift test against `DEFAULT_TEMPLATES`; the atomic PENDING→PROCESSING claim + FAILED-only retry + org-bound
edit/cancel/retry all hold; MCP `send_bulk_email` sending inline (not jobified) is intended.

### Communications / bulk-email review ROUND 2 — 3 HIGH + R1 + C3 SHIPPED; rest deferred (July 16, 2026)

A fresh 3-angle pass (send lifecycle/audience · worker concurrency/idempotency · RBAC/injection/
logging/drift) over the post-July-13 state. **The July 11 anti-double-send batch verified solid under
adversarial interleaving** (claim/heartbeat/sweep/conditional-completion/emailedKeys compose
correctly; registrations count==send parity clean incl. the newer filters; the survey check-in-gate
removal consistent; body-injection escaping clean; cross-caller send/viability consolidation held).
New findings: **0 BLOCKER / 3 HIGH / 9 MED / ~12 LOW**.

**SHIPPED July 16:**
- **A1 (HIGH, regression in `6f5f6e9`)** — MCP/agent `send_bulk_email` HTML-escaped the HTML body:
  the pipeline rewire routed the tool's sanitized-HTML `htmlMessage` through `{{message}}`, which is
  not a raw-HTML key → **every agent/n8n bulk email with markup rendered as literal source code**,
  audience-wide, with `success: true`. New server-internal `BulkEmailInput.customMessageIsHtml`
  (deliberately NOT in the Zod schema) adds `message` to the raw-key set; only the MCP executor sets
  it — the dashboard's plain-Textarea message stays escaped. The parity test had mocked
  `executeBulkEmail` and asserted only the call shape (the contacts-H4 "assert the effect" lesson,
  re-instanced); effect-level raw-key tests added.
- **A4 (HIGH)** — certificate bulk sends had **no email-level idempotency** (issue-or-reuse dedups
  the cert ROW, not the email): a worker crash mid-send + operator Retry re-emailed everyone already
  emailed on the post-event cert fan-out — the exact class H1 closed for every other type.
  `executeCertificateBulkSend` now takes the same `alreadyEmailedKeys`/`onBatchEmailed` contract
  (skip-filter + per-batch progress reporting; a failed send — incl. issued-but-send-failed — is
  deliberately NOT recorded so a retry re-attempts it and the cert row is reused). Zero worker
  changes needed — the worker already threads `emailedKeys` through `executeBulkEmail`.
- **A2 (HIGH, fails-safe)** — the four `abstract-*` email types offered by the dialog can never send
  (no slug mapping) and since jobification failed AFTER a 202 success toast (FAILED row + error page
  a minute later). The slug map is hoisted (`BULK_EMAIL_TEMPLATE_SLUGS`) and
  `precheckBulkEmailViability` rejects unsupported types synchronously at both enqueue doors;
  the dialog no longer offers them (abstract audiences keep Custom Email; status updates are sent
  from the abstract detail page). Legacy persisted rows still fail loudly at fire time.
- **R1 (MED)** — `GET /emails/schedule` was the ONE comms read with no role guard (bare
  `organizationId!`): **CRM_USER** (walled off from every event surface), **ONSITE**, and **MEMBER**
  could read every scheduled campaign's subject/body/filters org-wide via direct API call (the
  "guard on the write, not the read" class again). Now `denyReviewer`, matching its four siblings.
- **C3 (MED)** — the schedule POST never got H2's enqueue dedup: a 502'd/double-clicked schedule
  request created two identical PENDING rows that BOTH fired at the scheduled time. The guard is now
  the shared `findDuplicateQueuedSend()` in [bulk-email.ts](../src/lib/bulk-email.ts) (one
  implementation, both enqueue doors; schedule mode matches only rows with the IDENTICAL
  `scheduledFor`).

**NEW — deferred (round 2):**

| # | Sev | Finding |
|---|---|---|
| ~~C1~~ | MED | **Completion writes prove *status*, not *ownership*** — no claim token/nonce, so a zombie sender surviving a DB-write outage could be swept FAILED, Retry'd, and then mark the re-claimed row SENT with its own counts while worker B was mid-send. ✅ **SHIPPED July 16**: new `ScheduledEmail.claimToken` (additive migration `20260716120000`) — the claim stamps a per-claim token; heartbeat + SENT/SENT-0/FAILED writes condition on `status = PROCESSING AND claimToken = ours`; retry clears it. |
| ~~C5~~ | MED | **A send cannot be cancelled once PROCESSING** — cancel was PENDING-only and the batch loop never re-checked status. ✅ **SHIPPED July 16** with C1 (one mechanism): `executeBulkEmail` + the cert sender take a `shouldContinue` callback checked between 25-recipient batches (the worker's check = status + OUR token); the cancel DELETE accepts PROCESSING rows — a mid-flight send stops at the next batch boundary, writes no terminal state (`aborted: true`), and `emailedKeys` keeps what went out so a retry resumes. A throwing check means keep-going. MCP `cancel_scheduled_email` deliberately stays PENDING-only. |
| C6 | MED | **MCP `send_bulk_email` writes no AuditLog row** (every other MCP write tool + both REST enqueue paths do) — an agent-triggered 500-recipient blast is reconstructible only from EmailLog rows + pino lines. |
| A3 | MED | **`precheckBulkEmailViability` does not validate `filters.templateSlug`** — the route + worker comments claim a deactivated saved template 400s synchronously; it actually 202s then FAILs at fire time (fails safe, no silent fallback — but the M2 contract and two in-code comments are wrong). |
| ~~A6~~ | MED | **The "Cancelled Re-engagement" tile is 2 clicks from surveying/dunning cancelled registrants** — the tile seeds explicit `status=CANCELLED`, the email-type dropdown stays switchable, and only `certificate` got the unconditional CANCELLED rejection; survey-invitation and payment-reminder go through (the reminder computes a live amount from raw price columns, not cancel-zeroed financials). ✅ **SHIPPED July 16 (`f985a747`, owner decision: block both)** — the explicit-CANCELLED rejection in `precheckBulkEmailViability` now covers ALL of `CANCELLED_EXCLUDED_EMAIL_TYPES` (payment-reminder + survey-invitation + certificate), warn-logged, 400 `INVALID_FILTER`, enforced at both enqueue doors AND fire time. Also closes the cancel-with-refund L1 (explicit `status:"CANCELLED"` payment-reminder filter). +3 tests. |
| A12 | MED | **MCP inline send has neither dedup nor resume** — an n8n timeout + auto-retry re-sends the entire audience (the 2-min dedup lives only on the REST route; `emailedKeys` aren't passed inline). Accepted residual of the inline-send decision — now written down. |
| A5 | MED | **`emailedKeys` is unstable for abstracts recipients** — recipient key = first-seen abstract id from an un-`orderBy`'d query; a resume can re-key a multi-abstract speaker and re-email them. One-line `orderBy: { id: "asc" }` (or key on speaker id). |
| C4 | LOW-MED | Send-now dedup's effective window is ≤~60s (PENDING-only — the worker claims within a minute), and its `filters` JSON comparison deterministically misses under Postgres jsonb key reordering (fails safe: duplicate possible, never a wrong merge). |
| R2 | LOW | Bulk + schedule **attachments bypass `validateManualAttachments`** (magic-byte/MIME/filename checks used by the single-send speaker route); the schedule-edit PATCH has no size check at all. Route both through the shared validator. |
| R3 | LOW | **CRLF injection into the raw-MIME `To:` header** via self-registered names on attachment sends (`formatAddress` doesn't strip CR/LF; Subject is RFC-2047-encoded, names aren't). Bounded (injects into the recipient's own message); strip CR/LF or RFC-2047-encode names in `buildRawMime`. |
| A7 | LOW | MCP `paymentStatusFilter` hand-list omits `INCLUSIVE` (the H5 enum-drift class — the `6f5f6e9` rewire also removed the derived `ALL_PAYMENT_STATUSES` validation). "Email all sponsor-paid registrants" is impossible via MCP; fails closed. |
| A8 | LOW | The advertised MCP `INVALID_FILTER` coded error is unreachable for enum-invalid values — the pre-cap count query runs `status as never` BEFORE `executeBulkEmail`, so Prisma throws first → opaque generic error. Also the executor ignores `input.emailType` (always sends "custom") while the schema offers 4 types. |
| A9 | LOW | Resumed-run counters overwrite instead of accumulate — crash at 1500/2000 + Retry → the row terminally reads "Sent 500 / total 500" (EmailLog keeps the truth). |
| A10 | LOW | Selected-mode dialog count ignores in-dialog filters + the server's cancelled-default guard — "Send to 10 selected" can mail ≤8. |
| ~~A11~~ | LOW | `payment-reminder` has no `emailTypeToSlug` mapping → "Preview isn't available" for a first-class money email whose slug exists. ✅ **SHIPPED July 16 (`73dd7a29`, organizer-reported)** — the dialog's map now mirrors the server's `BULK_EMAIL_TEMPLATE_SLUGS` slug-identical set (payment-reminder + survey-invitation + the five webinar types; the webinar values are inert on CONFERENCE events, which never offer those options). |
| C10 | LOW | The retry route bypasses the 20/hr `bulk-email:org` bucket; rate-limit slots burn before Zod/precheck (20 rejected attempts lock out legitimate sends); MCP 10/hr + REST 20/hr are independent budgets (30/hr combined) — by design but undocumented. |
| C11 | LOW | A backlog tick can burst ~250 concurrent SES sends (10 parallel rows × 25-recipient batches) vs the 14/s SES rate — throttles surface as per-recipient failures that self-heal on retry, but produce spurious failureCount noise. |
| C8 | LOW (sharpened KNOWN) | The advisory-lock unlock's `false` return is silently discarded, and a wedged lock makes every tick skip at **debug** — scheduled sends stop with no alert. Given the over-alerting preference: escalate N-consecutive `skip-tick-locked` to warn. |
| ~~SIG-1~~ | LOW | **`{{organizerSignature}}` gaps** (diagnosed July 16): (a) the registration single-send route never threaded the var (literal token rendered); (b) `custom-notification` (every Custom Email send) doesn't carry the token in its default body; (c) tokens typed into the message box were never substituted (renderTemplate is single-pass over the template, not var values). | ✅ **SHIPPED July 16 (same day — owner un-deferred).** New `renderMessageValue()` in [email.ts](../src/lib/email.ts): tokens typed INTO the compose message resolve on all three senders (bulk + both single-send routes), with each key's historical escaping contract preserved ({{message}} escapes literal text — the MCP A1 flag now feeds the helper's `isHtml`; {{personalMessage}} stays raw-literal); the registration single-send route loads the sender's `User.emailSignature` and threads `organizerSignature`; compose-box hint + TEMPLATE_VARIABLES updated. (b) ~~deliberately NOT auto-appended~~ **superseded same day (owner request)**: the token now ships in **22 of 25 default templates** (html + text) — every default except payment-confirmation / refund-confirmation (pure transactional, owner exclusion) and certificate-bundle-delivery (rendered by the cert cover pipeline's own token resolver). `organizerSignature` joined `DEFAULT_RAW_HTML_KEYS`; `renderAndWrap` defaults the var to "" so automated senders (cron sequences, submission confirmations, public register) render NOTHING instead of the literal token; `sendRegistrationConfirmation` (renders via renderTemplate directly) sets its own ""; preview/test-send sample vars carry a sample signature. A coverage test pins all 25 templates' carry/omit status, so a new template can't silently miss the token. Human-triggered paths (bulk, both single-sends) render the real sender signature; threading real signatures into the reviewer/abstract-status notify helpers remains a future nicety (renders empty there today). |

**Known-deferred re-verified unchanged:** M4 (email-preview org-null collapse), M5 (count-predicate
triplication — speakers copy still missing `sessionRole`), preview rate limit, `presentationDetails`
raw HTML, the unlogged post-auth 4xx cluster (schedule lead-time 400, event-not-found 404s, the
email-templates 404/409 set), the legacy cron shim, P3 pooler advisory-lock.


### Program / agenda / sessions review (July 10, 2026) — deferred findings

A 4-angle production review of the program / agenda / sessions domain (scheduling lifecycle · RBAC &
public exposure · concurrency & integrity · drift/failure-visibility): **2 BLOCKER / 5 HIGH / 9 MED /
5 LOW**. Full report: [docs/CODE_REVIEW_PROGRAM_AGENDA.html](CODE_REVIEW_PROGRAM_AGENDA.html)
(browseable at `/admin/docs/CODE_REVIEW_PROGRAM_AGENDA.html`). **Both BLOCKERs and all 5 HIGHs fixed
the same day** (`835c49d` B1 Zoom host-URL leak to attendees + B2 recording-password leak to the
internet + M4 rate limit; `12e01d1` **session-service extraction** closing H1 PUT data-loss + H4
REST/MCP drift incl. the MCP audit gap + L2; `ce1f635` H2 orphaned billable Zoom meetings + H3 session
DELETE tells Zoom and guards the webinar anchor; `1d61af6` H5 unlogged-4xx sweep). Deferred:

- ~~**M1 — `provisionWebinar` is not idempotent under concurrency.**~~ ✅ **SHIPPED July 27, 2026**
  (webinar batch) — a `webinar.provisioningAt` sentinel is claimed atomically through the
  `updateEventSettings` row lock BEFORE anything is created: a contended claim backs off
  (`provision-already-in-progress` → 409 on the manual re-run), a lost claim retries the idempotent
  branch against the winner's session, a stale claim (>10 min, crashed provision) is reclaimable, a
  dangling `sessionId` (operator deleted the anchor) still recovers, and the sentinel is released on
  both success (function-form final write — which also stops clobbering a concurrent lobby-settings
  save) and failure. 8 tests in `__tests__/lib/webinar-provisioner.test.ts` with a STATEFUL settings
  mock so the claim mechanics run for real.
- ~~**M2 — session PUT regenerates every topic id.**~~ ✅ **SHIPPED July 16, 2026** (`bf678930`) — the
  service updates payload topics carrying an existing id in place (per-topic speakers replaced), creates
  id-less rows, deletes topics absent from the payload; foreign ids ignored (no cross-session hijack).
  Dashboard form, SessionDetailSheet, and MCP `update_session` all thread the id through.
- ~~**M3 — public `stream-status` hands the live HLS URL + `streamKey` to anyone**~~ ✅ **SHIPPED
  July 27, 2026** (webinar batch) — `streamKey` (which doubles as the RTMP **publish** credential on
  MediaMTX, i.e. stream-hijack material) is no longer returned to ANYONE (the client never used it);
  the `hlsUrl`/`hlsOriginUrl` fields are gated on auth + (org staff of the event's org OR a
  non-cancelled registration) with a 60s per-(user,event) positive micro-cache so a 5k recovery-poll
  storm doesn't hammer the pool — anonymous/unregistered callers get the bare liveness flag, which is
  all the lobby needs. The GET's DB write stays DELIBERATELY (reviewed): it fires only on a real
  probe-state transition (probe-cached), so polling harder cannot amplify it. 6 tests in
  `__tests__/api/stream-status-route.test.ts`.
- ~~**M5 — DRAFT-event exposure is still systemic**~~ ✅ **RESOLVED July 27, 2026** (via M3 + the
  eventType guard) — with `stream-status`'s payload viewer-gated, the DRAFT residual on the public
  webinar routes is a liveness boolean + non-sensitive lobby copy, both REQUIRED for the documented
  DRAFT-auto-open test flow (accepted; `zoom-join`/`presence` were already auth+registration-gated).
  `lobby-status` additionally 404s non-WEBINAR events now.
- ~~**M6 — retiming a session never re-syncs its Zoom meeting.**~~ ✅ **SHIPPED July 27, 2026**
  (webinar batch) — `session-service.updateSession` pushes a changed start/end to the linked Zoom
  meeting (`PATCH /meetings`) or webinar (`PATCH /webinars`) with the recomputed duration + event
  timezone and mirrors `ZoomMeeting.duration` locally. Failure-isolated: a Zoom outage never fails
  the session save — it surfaces as `zoomSync: "failed"` through the REST PUT + MCP `update_session`
  responses, and the dashboard agenda shows a warning toast ("Zoom still shows the old time — save
  again to retry"). Covers BOTH callers by construction (service-level). 6 tests.
- ~~**M7 — the public agenda buckets days in the VIEWER's timezone while rendering times in the EVENT's.**~~
  ✅ **SHIPPED July 16, 2026** (`15bb3e88`) — day buckets on the public agenda + the registration-page
  preview use `localDateInTz(event.timezone)`; the preview's false "renders in viewer tz" comment removed.
- ~~**M8 — the dashboard agenda ignores `event.timezone` entirely**~~ ✅ **SHIPPED July 16, 2026**
  (`15bb3e88`) — grid positioning (new `hourFractionInTz`), labels (`formatTimeInTz`), day bucketing, and
  the session form's datetime-local values (new `localDateTimeInTz` / `wallTimeInTzToDate`, DST-safe) all
  operate in the event's timezone; `SessionDetailSheet` gained a timezone prop.
- ~~**M9 — narrowing an event's dates silently orphans out-of-range sessions.**~~ ✅ **SHIPPED July 16,
  2026** (`bf678930`) — the event PUT blocks with 400 `SESSIONS_OUTSIDE_NEW_DATES` naming the offending
  sessions (owner decision: block, not warn); also fires when only the timezone moves the window.
- ~~**M10 — `sortOrder` allocated read-then-insert with no unique constraint**~~ ✅ **SHIPPED July 16,
  2026** (`bf678930`) — tracks POST + MCP `add_topic_to_session` compute max+1 inside the same
  transaction as the create (the certificate-templates pattern).
- ~~**M11 — no shared `session-enums.ts`.**~~ ✅ **SHIPPED July 16, 2026** (`d2e749b2`) — new
  [src/lib/session-enums.ts](../src/lib/session-enums.ts) (exhaustive Prisma-enum-keyed Records); the four
  re-implementations migrated (dashboard agenda incl. the raw-`MODERATOR:` tooltip, detail sheet, public
  agenda, public session page, speaker-agreement email context).
- ~~**L1** removing/replacing a session's speakers orphans their per-topic `TopicSpeaker` rows~~ ✅
  **SHIPPED July 16, 2026** (`bf678930`) — service update + MCP remove/replace clear dropped speakers'
  rows on that session's topics in the same transaction. ~~**L3** abstract→session uniqueness
  check-then-act race → opaque 500~~ ✅ **SHIPPED** (`bf678930`) — P2002 on `abstractId` maps to
  `ABSTRACT_ALREADY_ASSIGNED`. ~~**L4** session/track writes org-scope by hand + three viewer-local
  "join opens at" countdowns~~ ✅ **SHIPPED** (`15bb3e88` countdowns via `formatJoinOpens` event-TZ +
  GMT label; `bf678930`/`d2e749b2` org-scope via `buildEventAccessWhere` on sessions POST/PUT/DELETE +
  tracks POST/PUT/DELETE). **L5** — the `localDateInTz` lexical YYYY-MM-DD contract is now documented in
  event-time.ts (✅ July 16); the org-scoped public slug lookups half stays open (multi-tenant
  pre-condition, tracked in MULTI_TENANCY_IMPACT.md).


### Abstracts & reviewers review (July 10, 2026) — deferred findings

A 4-angle production review of the abstracts + reviewers domain (lifecycle · RBAC/info-leaks ·
concurrency · drift/failure-visibility): **0 BLOCKER / 9 HIGH / 11 MED / 6 LOW**. Full report with
quoted code + failure scenarios: [docs/CODE_REVIEW_ABSTRACTS_REVIEWERS.html](CODE_REVIEW_ABSTRACTS_REVIEWERS.html)
(browseable at `/admin/docs/CODE_REVIEW_ABSTRACTS_REVIEWERS.html`). **All 9 HIGHs fixed the same day**
in a 4-phase round (`97b11d4` H3 cross-org score injection + H5 empty-review route guard + H6
un-reviewable-status scoring; `fcd5932` H1 status-only-via-service + H2 create restricted to
DRAFT|SUBMITTED; `0dcf750` H4 conditional-claim status write in a tx + H5 gate-half count-scored + M4;
`314e45e` H6 remainder — DRAFT/WITHDRAWN out of the portal feed + unassignable). Deferred, each
independently shippable (anchors in the HTML doc):

- ~~**H7 — review-submission pipeline triplicated**~~ ✅ **SHIPPED July 13, 2026** — new
  `abstract-service.submitAbstractReview()` is the ONE implementation; the REST submissions POST and
  both MCP executors (`submit_abstract_review`, `admin_submit_review_on_behalf`) are thin delegations.
  The H3 org-bind now lives in the service (admin bypass computed against the event's org, self-submit
  only — never on-behalf). Drift unified on REST semantics: integer scores everywhere (MCP floats now
  rejected), `reviewNotes: ""` clears / `undefined` keeps on every path, empty payloads rejected on the
  MCP paths too (they used to upsert an all-null row), >5000-char notes rejected (MCP silently
  truncated). +16 service tests pin the contract; all 81 pre-existing route/COI/assign tests pass
  unchanged through the delegation. M10's feedback-notification re-wire now has its landing spot.
- ~~**H8 — MCP `assign_reviewer_to_abstract` silently drops `conflictFlag`**~~ ✅ **SHIPPED July 13,
  2026** — the executor now persists `conflictFlag` on create (default false) AND toggles it on the
  idempotent upsert (REST parity: role and/or COI can change independently; a same-role+same-flag
  re-call is a no-op reporting the current flag). Audited with `previousConflictFlag`; tool description
  now states the flag is enforced. pkg 0.4.17→0.4.18 (MCP clients reconnect). +4 executor tests.
- ~~**H9 + M7 — blind review is one-sided**~~ ✅ **SHIPPED July 13, 2026** — both halves: (a)
  `consolidateReviewNotes` anonymizes attribution in the author decision email (`— Reviewer N:` instead
  of names; single note stays bare); (b) the submissions GET's full per-reviewer view (identities /
  notes / per-criterion) is restricted to org STAFF (ADMIN/SUPER_ADMIN/ORGANIZER) + pool reviewers —
  MEMBER/ONSITE org-attached roles now receive the SAME anonymized shape the submitter gets (notes +
  overall aggregates, no identities, no per-criterion). +7 tests (view matrix + note format pinned).
- **M1 — decisions can rest on pre-revision reviews**: after REVISION_REQUESTED→resubmit the old
  submissions still satisfy the gate (no `submission.updatedAt` vs `abstract.submittedAt` check), and
  the portal's NEEDS_UPDATE keys on `submittedAt` so content-only edits don't flip it.
- **M2 — criteria mutable/deletable mid-round**: no sum-to-100 enforcement (the helper divides by a
  hardcoded 100), `overallScore` computed with then-current weights and never recomputed (mixed bases
  averaged into the decision mean), delete leaves orphaned `criteriaScores` JSON keys + hard-rejects a
  reviewer mid-form. Fix: warn/refuse weight-sum ≠ 100; refuse delete when submissions reference the id.
- **M3 — CFP deadline gates only public registration**, not abstract create/submit/resubmit
  (`allowAbstractSubmissions` + `abstractDeadline` never checked in the abstracts POST/PUT).
- **M5 — abstract create has no double-submit defense** (no unique on (eventId, speakerId, title), no
  dedup) → duplicate abstracts + duplicate confirmation/admin emails on a double-click.
- **M6 — the PUT status-branch's second field write bypasses the optimistic lock** and is non-atomic
  with the service call (a stale field write clobbers a concurrent edit with no 409; a field-write
  failure returns a 500 claiming nothing succeeded when the decision + email already fired).
- **M9 — in-app agent: 5 abstract executors undiscoverable** (wired + MCP-registered but absent from
  `ABSTRACT_TOOL_DEFINITIONS`) + the `update_abstract_status` def advertises a `reviewNotes` param the
  executor discards and omits `force`.
- **M10 — feedback-notification path vanished in Sprint B**: `feedbackOnly` is dead (no caller), and
  the "reviewer submitted notes/score" events call no notification helper — the speaker "Reviewer
  Feedback Received" email is unreachable and admins are no longer pinged on a review. CLAUDE.md still
  advertises the feature. Decide: re-wire from the (H7) submission service, or delete + correct the doc.
- **M11 — silent 4xx sweep**: ~20 unlogged rejection paths (PUT guards, submissions 403/400s,
  reviewers + review-criteria 404s, abstracts POST 403/404s). Same class fixed for payments (M12);
  one logging pass.
- **L1** managementToken generated + returned but never consumed (latent plaintext secret; strip from
  responses). **L2** pool reviewers see co-reviewers' identities/emails/scores (anchoring risk).
  **L3–L5** find-then-create → P2002-mapped-to-500 trio (reviewer-user create, submitter signup,
  reviewer assign) + the pool-add stranding window. **L6** doc drift — CLAUDE.md June-10 entry still
  says "the COI flag is advisory in v1" after June-26 enforcement (+ MCP create_review_criterion
  misses the 200-char name cap).

### Payments / refunds / credit-notes review (July 10, 2026) — deferred findings

A 4-angle production review of the money domain (money-flow lifecycle · concurrency &
idempotency · RBAC/security · drift/failure-visibility). Full report with quoted code +
failure scenarios: [docs/CODE_REVIEW_PAYMENTS_REFUNDS.html](CODE_REVIEW_PAYMENTS_REFUNDS.html)
(browseable at `/admin/docs/CODE_REVIEW_PAYMENTS_REFUNDS.html`). **The BLOCKER (B1
sponsor-paid double-collection) + all 11 HIGHs were fixed the same day** in an 8-phase
round (`4cffd0a` charging gates, `b490392` charge-level webhook idempotency, `b579bbe`
RefundAttempt crash-safety + sweep, `1191b25` multi-payment allocation +
`Payment.refundedAmount`, `c480834` invoice IDOR + ONSITE finance scoping, `da2531c`
paymentStatus/invoice-status write subsets (MCP 0.4.16 — clients reconnect), `48e7397`
Dashboard-refund parity, `fa96114` manual-capture truthfulness). M3, M4, M6, M11 and
the old deferred "L2 silent webhook-CN-cap-rejection" were closed in the same round.
Two new migrations (both additive/idempotent/blue-green-safe): `20260710120000_add_refund_attempt`
+ `20260710130000_add_payment_refunded_amount` (with backfill).

Deferred (each independently shippable; report anchors in the HTML doc):

- ~~**M1 — post-payment document minting is check-then-act**~~ — **SHIPPED July 10
  (`f6a9ff8`)**: createPaidInvoice + createPaidReceipt take the `SELECT … FOR UPDATE`
  registration-row lock with the existence checks inside the locked tx. (The manual
  recovery branch's non-locking `payment.count` remains a micro-edge — two concurrent
  RECOVERY clicks on a hand-flipped PAID reg — tracked as L4 below.)
- ~~**M2 — `cancelRegistration` seat/promo transition uses a pre-refund snapshot**~~ —
  **SHIPPED July 10 (`a4d5141`)**: the cancel tx re-reads the seat-relevant fields inside
  the transaction and transitions from those.
- ~~**M5 — PAID invoice totals come from CURRENT pricing, not the captured Payment**~~ —
  **SHIPPED July 10 (`f6a9ff8`)**: `capturedTotal` (the actual `Payment.amount`) threads
  through `issuePaidRegistrationDocuments` into both creates; divergence >1¢ scales the
  components + reconciles tax (CN pattern), warn-logged; the promote path re-totals stale
  SENT figures.
- ~~**M7 — refund + cancel endpoints have no rate limit, and refund omits `denyFinance`**~~ —
  **SHIPPED July 10 (`a4d5141`)**: refund gains `denyFinance`; both gain 60/hr/user limits.
- ~~**M8 — webhook doesn't compare `session.amount_total` to the amount currently owed**~~ —
  **SHIPPED July 10 (`a4d5141`)**: `stripe-webhook:paid-amount-diverges-from-owed` warn.
- ~~**M9 — `calcInvoicePricing` is a fourth, unrounded totals implementation + three
  divergent `round2` copies**~~ — **SHIPPED July 10 (`c13c86a`)**: delegates to
  `computeRegistrationFinancials`; `round2` exported from registration-financials, local
  copies removed everywhere.
- ~~**M10 — invoice/CN PDFs recompute tax from `taxRate` instead of printing the stored
  figures**~~ — **SHIPPED July 10 (`c13c86a`)**: invoice/CN/receipt PDFs print the stored
  `taxAmount`/`total` (quote keeps the recompute — no stored row). The zero-decimal-currency
  nit in CN math remains open (L5 below).
- ~~**M12 — silent 4xx sweep**~~ — **SHIPPED July 10 (`678cef5`)**: `denyReviewer`/`denyFinance`
  now log inside the guards (no call site can forget); all payment-service rejection codes,
  the refund/credit-notes/cancel route boundaries, and the invoice/quote 401/404 paths log
  at warn with user + role + code.
- ~~**L1 — public document route serves SENT over PAID**~~ — **SHIPPED July 10
  (`a4d5141`)**: picks PAID first (newest), else newest non-CANCELLED; CANCELLED-only falls
  through to the quote.
- ~~**L2 — registrant portal hand-rolls discount/tax/total client-side**~~ — **SHIPPED
  July 10 (`a4d5141`)**: the portal renders from `computeRegistrationFinancials`.
- ~~**L3 — doc drift: MEMBER finance-capable since June 17**~~ — **SHIPPED July 10
  (`aedac06`)**: CLAUDE.md RBAC section corrected. (Product re-confirmation of MEMBER
  finance visibility still worth a nod from the owner.)
- ~~**H2 sub-item — cancel should expire open Stripe checkout sessions**~~ — **SHIPPED
  July 10**: new `Registration.stripeCheckoutSessionId` (additive migration
  `20260710150000`) stored at checkout-create, cleared on completion/expiry; the
  never-throwing `expireOpenCheckoutSessionOnCancel()` helper
  ([src/lib/checkout-session-cleanup.ts](../src/lib/checkout-session-cleanup.ts)) is called
  post-commit by ALL four cancel paths (cancel service, REST PUT flip, MCP single + bulk).
- ~~**L4 (new)** — manual-capture RECOVERY branch (PAID-with-no-Payment-row) still guards
  with a non-locking `tx.payment.count`; two concurrent recovery clicks can double-insert.~~
  ✅ **SHIPPED July 16 (`a461420e`)** — the recovery branch takes the registration-row
  `FOR UPDATE` lock before its payment-count race check (createCreditNote pattern).
- **L5 (new)** — credit-note/refund math doesn't consult `isZeroDecimalCurrency` (a JPY
  CN can carry fractional components). Cosmetic until a zero-decimal-currency event exists.

### Registrations & speakers review (July 10, 2026) — deferred findings

A 4-angle production review of the registrations + speakers + companion-registration
domain (lifecycle · facets · security · duplication/logging). Full report with quoted
code + failure scenarios: [docs/CODE_REVIEW_REGISTRATIONS_SPEAKERS.html](CODE_REVIEW_REGISTRATIONS_SPEAKERS.html)
(browseable at `/admin/docs`). **All 9 HIGHs fixed July 10** in an 8-phase remediation
round (`a1641fe` activity-route IDOR, `c5e56cd` CSV formula injection, `f910e41`
companion-CANCELLED link + registration→speaker email cascade, `47644cc` MCP tag sync,
`dafef1d` promo usedCount lifecycle, `34ad041` registration PUT atomicity, `5cd8a1f`
bulk-type repricing, + the check-in unification onto `src/lib/check-in.ts` — shared
gate/commit for both REST handlers + MCP, pkg 0.4.15). The mediums/lows below are
deferred and independently shippable. Suggested order:
~~M4 first~~ (M4 turned out to be a stale finding — already fixed by `1191b25`, see its row), then
the MCP-parity cluster (M7/M8/M9/L4), then logging hygiene (M12/M13), then the
`updateRegistration()` service extraction (#5 below in the cross-caller section) which stops
the drift class from regenerating.

- ~~**M1 — MCP registration writes scope by org, not the tool's `eventId`**~~ ✅ **SHIPPED July 13 (`a0b427f`)** — the `updateRegistration()` service extraction binds the lookup to `{id, eventId}`; both callers delegate. (The bulk-status executor's org-scope remains with M10.)
- **M2 — companion create race** (`speaker-companion.ts:100-124`). Check-then-create, no uniqueness backstop; two racing calls mint an orphaned CONFIRMED faculty reg with a live entry barcode. Fix shape: partial unique index on `(eventId, attendee-email) WHERE createdSource='SPEAKER_COMPANION'` or advisory lock.
- **M3 — deleting a companion registration silently strips the speaker's facet** (registration DELETE has no `SPEAKER_COMPANION` guard; `sourceRegistrationId` SetNulls; nothing recreates). Fix: warn/confirm on companion rows + log the detach.
- ~~**M4 — refund routes the whole balance through the newest PAID payment only**~~ — **STALE FINDING (verified July 11)**: already fixed by the payments round's `1191b25` multi-payment allocation — `refundRegistration` now slices across ALL settled payments (Stripe charges first, each slice capped at its charge's own remaining via `Payment.refundedAmount`, manual remainder recorded). This row and the payments-review H6 described the same defect; the fix landed under H6.
- **M5 — seat/promo deltas computed from pre-transaction snapshots** (`payment-service.ts:421→484` — the gap contains the Stripe network call; also MCP bulk + bulk-type). Concurrent mode/type change in the window → double release. Fix: re-read the row inside the tx and compute `prev` from that. (Seats dormant; promo live.)
- ~~**M6 — CSV import claims a seat for rows imported as CANCELLED**~~ ✅ **CLOSED July 24, 2026** (Option B review MED-1): the claim block now skips CANCELLED rows entirely (both `soldCount` and the new `Event.seatCount`), mirroring `holdsSeat`/`holdsEventSeat`.
- ~~**M7 — MCP sponsor-gate drift**~~ ✅ **SHIPPED July 13 (`a0b427f`)** — the shared service enforces the INCLUSIVE↔sponsor invariant change-scoped for both callers.
- ~~**M8 — MCP `create_registrations_bulk` drift (4 behaviours)**~~ ✅ **SHIPPED July 13 (`6f5f6e9`)** — paid→UNASSIGNED / free→COMPLIMENTARY defaults, CANCELLED-excluding dup check, `requiresApproval`→PENDING, per-row sales-window enforcement, and money-owed rows now get the confirmation + quote email via the shared `sendRegistrationConfirmationEmail()` helper (single-create path refactored onto it — no third copy).
- ~~**M9 — MCP `create_speakers_bulk` skips `syncToContact` and drops fields**~~ ✅ **SHIPPED July 13 (`6f5f6e9`)** — all dropped fields persisted (+ `registrationType`, so companions inherit the profession), per-row contact-store sync, INVALID_ROLE validation. The speakers **CSV import** contact-sync half remains open.
- **M10 — `bulk_update_registration_status` is a 4th hand-written cancel/reactivate copy** (~90 lines, two near-identical claim blocks) — same as pre-existing cross-caller #6.
- **M11 — create-time seat claim hand-rolled in 3 places** instead of `claimSeat` (registration-service, MCP bulk create, public register).
- ~~**M12 — REST boundaries return service rejections as unlogged 4xxs**~~ ✅ **SHIPPED July 16 (`f985a747`)** — registrations POST + speakers POST log every service rejection (warn; UNKNOWN at error) with user + code + status; the public register route logs tier-not-found / sales-window / sold-out AND the sentinel-mapped business 400s (ALREADY_REGISTERED, SOLD_OUT, all four promo rejections) at warn with the event slug.
- ~~**M13 — five REST sites bare-`await` `db.auditLog.create()` after the commit**~~ ✅ **SHIPPED July 16 (`f985a747`)** — registration DELETE, speaker DELETE, and the speaker single-send EMAIL_SENT audit writes are fire-and-forget with a logged catch (the check-in pair + registration/speaker PUTs were already fixed in the July-10/13 rounds; a repo-wide sweep of the ~18 remaining bare-await sites in OTHER domains — hotels/tracks/sessions/org — remains open).
- **L1 — speakers list GET returns full faculty PII (email/phone/bio) to SUBMITTER/REGISTRANT sessions** attached to the event — broader than the abstracts-only role needs; consider a reduced projection.
- **L2 — speaker DELETE cleans up the companion outside the transaction** — a blip leaves an ownerless CONFIRMED faculty reg with a valid barcode; wrap the pair in one tx (failure-isolation is right for create, not delete).
- ~~**L3 — `cancelRegistration` lost-race returns success + writes an audit row for a cancel it didn't perform**~~ ✅ **SHIPPED July 16 (`a461420e`)** — the cancel tx returns a `claimed` flag; the loser warn-logs `cancel:lost-race` and returns ok WITHOUT the audit row (still idempotent).
- ~~**L4 — empty-string→null normalization drift**~~ ✅ **SHIPPED July 13 (`a0b427f`)** for registrations — the shared service collapses `""`→null on every path; the `updateSpeaker` half folds into that future extraction.

### Multi-certificate-per-email (bundles) — deferred review findings

The 6-phase cert-bundling feature (one email carries every cert a person earns —
Issue tab multi-select, Communications bulk-email "certificate" type, survey
auto-issue bundles, resend-all-in-one-email) shipped with an 8-angle independent
review. Blockers + highs (run-wedge P2002, cross-run bundle theft, event-wide run
guard, auto partial-failure stranding, resend email anchor, EmailLog attribution)
were **fixed in-band**. Deferred (medium/low, each independently shippable):

- **M7 — bulk cert "Email All" counts non-tag-holders as failures.** An unfiltered
  send with one `committee` template on a 500-reg event reports 30 success / 470
  "failures" ("No selected certificate applies") in the ScheduledEmail row + admin
  notification, though everything worked as designed. Fix: count zero-tag-match
  recipients as SKIPPED (new counter or excluded from `total`), keep the per-recipient
  detail at debug/info. ([src/lib/certificates/bulk-issue.ts](../src/lib/certificates/bulk-issue.ts))
- **M8 — legacy 1:1 `issueRunItem` readers miss bundle certs #2..N.** The auto-issue
  analytics `certsAutoIssued` count, the issued-list card's "sent …" timestamp, and
  the single-cert resend route's cover-email-snapshot lookup all read the legacy
  `item.issuedCertificateId` 1:1 relation; non-primary bundle certs show as
  never-sent / fall back to the default cover. Fix: read via `issueRunItemId`
  (provenance) OR the deterministic (templateIds × facets) rule the worker send
  phase now uses.
- **M9 — cover-email semantics drift.** (a) The bulk dialog's "Message (optional)"
  REPLACES the whole cover body (plain-text newlines not converted, `{{certificateList}}`
  lost) though the label reads additive; (b) resend-bundle's 1-cert case uses the
  system default instead of the template's saved cover email (bulk + issue paths keep
  it); (c) the single-vs-multi default cascade is hand-copied in bulk-issue /
  worker fallback / page dialog prefill instead of one `defaultCoverEmailFor` call —
  and bulk keys on per-recipient cert count while the worker keys on run-level
  template count.
- **L — cleanup batch.** Person-linking email match is case-insensitive in
  `eligibleForTemplates` but case-sensitive in `resolveLinked*` (same person merged
  at issue, split at resend — extract one shared predicate); 4 near-identical
  title-prefix name formatters (`formatRecipientName` / auto-issue + eligibility
  `formatName` / `formatPersonName`); the worker's dead `templateIds` fallback + the
  retained ~250-line legacy render pipeline duplicate `findOrIssueCertificate`'s
  domain op (delete once pre-deploy in-flight runs drain); `{{certificateList}}`
  resolves raw HTML in a SUBJECT if an operator puts it there (spec says body-only —
  enforce or strip); per-recipient facet/tag queries in `bulk-issue.resolvePersonFacets`
  and per-cert `loadRecipient`/`loadEventContext` in `renderAndUpload` could be batched
  (perf headroom for 500+ recipient sends); `run.type` is a lossy "primary category"
  for mixed bundles (derive display category from `templateIds` if analytics ever
  group by type).

### Dinner RSVP (shipped) — backlog / deferred items

Dinner RSVP shipped P1→P3 + a first-class email template with preview, then an
adversarial review (no BLOCKER/HIGH; M2 + M3 fixed). See
[docs/RSVP.md](RSVP.md). Deferred / conscious-accept items:

- **Auto-reminder cron (P3c) — deliberately NOT built** (owner decision, July 8).
  The manual **"Remind pending"** button covers it. Revisit only if an event needs
  hands-off reminders — would need a `RsvpInvite.lastReminderAt` field + a worker
  job + a trigger-timing decision (e.g. X hours before each dinner's deadline).
- **Scheduled send** — the invitation send is direct (per-recipient, immediate),
  not routed through the Scheduled Emails queue, so there's no "schedule for later."
  Add by wiring the send through `ScheduledEmail` if organizers want to pre-schedule
  the wave.
- **L1 (accepted-as-is)** — the organizer's `personalMessage` is rendered as raw HTML
  (in `rawHtmlKeys`), consistent with bulk-email / speaker-email (trusted,
  ADMIN/ORGANIZER-only; no invitee-controlled value hits an unescaped sink). It's a
  plain `<textarea>` (not Tiptap), so multi-line notes currently collapse. Optional
  hardening: `escapeHtml` + `nl2br` the plain-text message.
- ~~**L2 (accepted-as-is)** — the roster GET is org-scoped but not role-narrowed …~~
  **SUPERSEDED**: the Survey/RSVP review's **H2 fix** locked the roster GET down
  (`denyReviewer` + `buildEventAccessWhere` — MEMBER/ONSITE/REGISTRANT 403), and
  Round 2 extended the same policy to `GET /dinners` (M4) and the in-app agent's
  `list_dinner_rsvps` (M5, `ROSTER_PII_AGENT_TOOLS`).
- **MCP write tools** — only the read tool `list_dinner_rsvps` exists; creating dinners
  / adding invitees / sending stays in the organizer UI. Add write tools if agent-driven
  RSVP management is wanted.

**Round 2 remaining LOWs (July 16, 2026 — [docs/CODE_REVIEW_DINNER_RSVP_R2.html](CODE_REVIEW_DINNER_RSVP_R2.html);
all 12 MEDs + 7 LOW riders shipped same-day in 4 batches `2716baf7`/`3966a6d4`/`c54addef`/`e41d4692`):**

- **L3** — rate-limit buckets on the three organizer routes are consumed BEFORE the
  event-ownership check, so any staff user can burn another event's 10/hr send budget
  with 404ing posts. Same-team nuisance today; DoS-shaped under multi-tenancy. Key the
  bucket on `${eventId}:${userId}` or move the check after the event lookup.
- **L4** — embedded CRLF survives into the email subject + recipient display name
  (mitigated by structured provider APIs) — fold into the existing "To-header CRLF" item.
- **L5** — the invitation HTML (containing the live RSVP token twice) is stored in
  `EmailLog.htmlBody` for 180 days by default. Audience currently matches the roster
  GET's; if email-log-body access is ever widened, pass `storeBody: false` here.
- **L6** — console TZ race: `dinnerTz` falls back to Dubai while `useEvent` is in
  flight; a dialog opened pre-resolve and saved post-resolve shifts `dinnerAt` by the
  offset delta. Capture the tz at dialog-open into form state.
- **L8** — `isActive` is honored everywhere server-side but unreachable from the
  console (no toggle) — add the toggle or note it as API-only.
- **L10** — CSV export columns are keyed by dinner NAME; duplicate names collide.
- **L12** — no rate limit on dinner PUT/DELETE + invite DELETE (the header comment
  over-claims "writes are rate-limited").
- **L14** — the CSV export is a bare `<a href>`; an expired session navigates to raw
  401 JSON (the quote.json class) — fetch-then-blob like the invoice buttons.

### Per-event ONSITE staff (shipped) — deferred review follow-ups

Per-event ONSITE registration-desk staff shipped (`893d3b3`) + the adversarial-
review BLOCKER fix (`93deed7`, cross-event isolation on the 5 desk routes). See
[docs/ONSITE_PER_EVENT_PLAN.md](ONSITE_PER_EVENT_PLAN.md). Deferred, non-blocking
review findings (BLOCKER already fixed; these are HIGH-cosmetic / MED / LOW):

- **H1 (cosmetic post-fix)** — the middleware confines ONSITE to
  `/registrations*`/`/check-in*` but not to *assigned* events. Now that the API
  404s an unassigned event (B1–B4 fix), navigating there loads an empty shell
  instead of redirecting. Fix: make the registrations page server component 404
  when `buildEventAccessWhere(user, eventId)` returns nothing, so the UI matches
  the API. **Not a security issue** — the API is the authoritative gate and it's
  closed.
- **M1** — deleting an ONSITE account via `DELETE /api/organization/users/[userId]`
  leaves stale ids in every event's `onsiteUserIds` (cosmetic; cuids aren't
  reused; the Settings-tab delete already strips-first, but a direct API call
  doesn't). Fix: on ONSITE account delete, sweep `onsiteUserIds` org-wide.
- **M2** — ORGANIZER (not just ADMIN) can assign existing ONSITE users to events
  (creating the account is ADMIN-only). Confirm intended. The create+assign UI
  flow (POST users → N× POST assign) has no partial-failure rollback — surfaces a
  warning toast but leaves an unassigned account on partial failure.
- **L1/L2** — `updateUserSchema` role enum omits ONSITE/MEMBER (can't PUT-change
  to ONSITE, only invite/promote); org onsite-staff GET over-fetches full
  `settings` JSON per event to read one array.

## Previous Release — June 30, 2026

### Scheduled email — "one-shot, late-inclusive" + fixed `recipientIds` overlook

- **Behavior:** a scheduled email now reliably reaches people who register *after* it is scheduled. Filter-based scheduled sends already re-resolved recipients at fire time; this makes that the explicit, recommended default and closes the gap where a row-selected schedule froze the audience.
- **Overlook fixed:** the schedule-create route (`POST /api/events/[eventId]/emails/schedule`) **parsed `recipientIds` but never persisted it** — only the immediate-send route did. So every scheduled send silently fell back to filter-based, and a "schedule to these N ticked rows" actually fanned out to **everyone matching the filters** at fire time (often *all* registrations when no filter bar was active) — an over-send risk on a live system. Now the route writes `recipientIds` (and exposes it on GET).
- **UX:** `src/components/bulk-email-dialog.tsx` — when scheduling from a row selection, an explicit choice (default **"Everyone matching the current filters at send time"** = late-inclusive, drops the ids; alt **"Only the N selected (fixed list)"**). "Email All" schedules show a "✓ includes new registrations" note. `scheduled-emails-list.tsx` labels each row **"matching at send time"** vs **"N fixed"**. "Send now" unchanged.
- **No schema/migration** (`ScheduledEmail.recipientIds` already existed). New test `__tests__/api/scheduled-email-create.test.ts`. Full design in [docs/SCHEDULED_EMAILS.md](SCHEDULED_EMAILS.md) §4; user guide `public/user-guide.html` §9.

---

## Previous Release — June 29, 2026

### Communications filters + Activity edit-history + public SEO + Add-form parity + faculty data fix

- **Bulk-email audience filters (registrations).** "Send Bulk Email" dialog (registrations-list "Email All" + Communications page) gained in-dialog **multi-select** filters in a collapsible "Filter recipients" section: Payment status + **Registration type** (`ticketTypeIds`, `in`) + **Badge type** (`badgeTypes`, `in`) + **Tags** (`tagsInclude`, `hasSome`). OR-within-field / AND-across; empty = no restriction. Wider 4xl dialog, 3-up layout, "or"-joined recap, footnotes. Fixed a real bug: the list's "Filter by tag" was never passed to Email All (silently ignored). Backend `src/lib/bulk-email.ts`; UI `src/components/bulk-email-dialog.tsx`. Count==send preserved. Adversarially reviewed (0 blocker/0 high).
- **"Exclude faculty / speakers" toggle + single filter surface.** One-click `excludeFaculty` checkbox (registrations `where` spreads `EXCLUDE_FACULTY_WHERE` = `NOT ticketType.isFaculty`) → email delegates only. The Communications page's duplicate single-select registration Advanced-filters block was **removed** — the dialog is now the single registration-filter surface (Speakers card keeps its own filters). Plus a cerulean color pass + an Email-Type trigger height fix (same-variant override of the base `data-[size=default]:h-9`).
- **Activity edit-history diffs.** Registration + speaker Activity timeline now renders field-level before→after diffs from `AuditLog.changes` (incl. nested attendee), finance-redacted for non-finance roles (`src/lib/activity-feed.ts`). **Dedup follow-on:** shared `ActivityItem`/`ActivityFieldDiff` types extracted to a client-safe `src/lib/activity-feed-types.ts` (was declared in both the lib + the card); and the two *global* audit feeds (`components/activity-feed.tsx` + `(dashboard)/activity/global-activity-feed.tsx`) now share `src/components/activity/audit-log-display.ts` (icon/colour maps + `describeAuditAction`/`auditActorLabel`) instead of byte-identical copies — the components stay separate (not merged).
- **Public SEO metadata.** Per-event OpenGraph/Twitter + per-section titles on `/e/[slug]/*` via server `layout.tsx` + `buildEventMetadata` (`src/lib/public-event-metadata.ts`). **Follow-up:** slug lookups are org-unscoped — add `organizationId` when multi-tenant lands (`docs/MULTI_TENANCY_IMPACT.md`).
- **Add Registration ↔ Add Speaker parity.** Both forms share one personal section via `PersonFormFields` (speaker form was dropping Phone). Frontend-only.
- **Faculty registration-type correction (prod backfill, audited).** 33 legacy companion attendees with `registrationType="Faculty"` → 3 restored to the speaker's profession, **30 defaulted to "Physician"**. Faculty designation (`badgeType` + `isFaculty` ticket type) untouched; live companion-creation path unchanged. Review the defaulted set via Badge=Faculty + Type=Physician.
- **Speaker phone/additionalEmail enrichment (prod backfill, audited, enrich-only).** Fills blanks from the counterpart registration's attendee; 1 row enriched.
- **scheduled-email 0-recipient → benign skip** (terminal SENT/0, info log; not a paging FAILED). Smaller: removed confirmation-page "Back to Event" button, deleted orphaned `docker/Dockerfile`, sidebar `w-64→w-56`.

**Deferred follow-ups:** tag-value-**exclude** (skip a specific tag) + attendance-mode bulk-email filters (the "exclude faculty/speakers" exclude is shipped); a "Faculty vs delegate" review tile; per-recipient deselect in the bulk dialog; SEO `noindex` on transactional public pages (login/confirmation) + editorial meta-title override.

## Current Release — April 22, 2026

### Services Refactor (Phases 0 + 1 + 2a + 2b shipped; 2c deferred into Phase 3)

Shared domain logic moved out of route handlers into a new `src/services/` layer so REST routes, MCP agent tools, and the upcoming external API can all share one implementation per domain. This eliminates silent side-effect drift between entry points — the class of bug that caused paid registrations created via the Claude agent to miss their confirmation emails before the fix.

- **Phase 0 — MCP parity fixes (shipped).** Confirmed drift patched directly in the MCP tools: paid `create_registration` now fires the confirmation email + quote PDF, defaults `paymentStatus` to `UNASSIGNED` (paid) / `COMPLIMENTARY` (free), atomically increments `soldCount`, generates `qrCode`, enforces sales-window + `requiresApproval`, syncs to Contact store, writes audit log, notifies admins. Same treatment for `create_speaker`. Bulk variants get atomic increments, `qrCode` generation, and a single batched admin notification per call.
- **Phase 1 — Foundation (shipped).** `accommodation-service.ts` centralizes the atomic overbooking guard previously duplicated across REST + MCP. Conventions locked in (errors-as-values, typed-Date inputs, caller-identity via `source`, service-owned side effects). `src/services/README.md` documents the full pattern for future extractions.
- **Phase 2a — Abstract (shipped).** `abstract-service.ts` centralizes the `requiredReviewCount` gate, WITHDRAWN terminal-state guard (REST tightening), and reviewer notification fan-out with isolated failure handling.
- **Phase 2b — Speaker (shipped).** `speaker-service.ts` centralizes single-create speaker logic. Empty-string field normalization as safety net for future direct-to-service callers.
- **Phase 2c — Registration (deferred into Phase 3).** Originally planned as the third Phase-2 extraction. Phase 0's in-place patches already eliminated the confirmed drift bugs, so the remaining value is future-facing. The extraction is better done alongside the external public REST API (Phase 3) so the service shape is informed by a real third caller.

### Invoice & PDF Polish (April 22)

Companion fixes discovered during paid-registration testing:

- **Receipt PDF attachment email now fires after payment.** `createReceipt` / `createInvoice` / `createCreditNote` used to throw on missing `event.code`, silently killing the Stripe webhook's fire-and-forget invoice creation. Now reuses the shared `deriveEventCode()` helper + fire-and-forget backfill, so legacy events without a code still get proper invoice numbering.
- **"Confirmation Number" terminology unified.** Three registrant-facing emails (registration / payment / refund) now all use "Registration #" with the same padded serial — no more two different values under the same label. Payment email adds a distinct "Payment Reference" row with the Stripe PaymentIntent id.
- **"View Invoice" button is honest.** When no Invoice row exists, button now says "Download Quote" (what you actually get) instead of "Invoice".
- **Quote PDF right-side box widened.** Billing email/phone no longer wrap + collide. Fix applies to all four PDF types (Quote, Invoice, Receipt, Credit Note) via the shared layout helpers.

---

## Previous Release — April 2, 2026

The following features shipped in the most recent release:

**Event-Scoped Media Library**
Organizers can upload and manage images per event, accessible from the event sidebar under Tools. Images can be inserted directly into email templates.

**Refund Processing (Stripe + offline)**
Admins can issue full refunds from the registration detail panel for **both** Stripe and offline (cash / bank-transfer / card-onsite) payments. Stripe payments are reversed automatically via the Stripe API; offline payments are returned to the attendee out-of-band and the system just records the reversal. Either way it marks the registration Refunded, flips the payment record, sends a refund confirmation email, and issues a branded credit-note PDF. Refunds initiated directly in the Stripe Dashboard are handled via webhook. _(Manual/offline refund path + branded credit note shipped July 7, 2026.)_

**Abstract System Expansion**
- Added Video and Workshop as presentation types
- Submitters can now withdraw their abstracts
- Reviewers can recommend a format (Oral / Poster / Neither)
- Organizers can configure event-specific abstract themes
- Weighted review criteria with automatic score calculation

**MEMBER Role**
A new read-only role for stakeholders who need dashboard visibility without write access.

---

## Planned Future Features

The following items are candidates for the next development phases. Priorities can be adjusted based on business needs.

### Billing payers — inline-entry follow-ups (June 29, 2026)

Shipped: event-level **inline payer create** from the registration Charge-to picker (full-page Add Registration form) with org-level consolidation — `findOrCreateBillingAccount()` (exact-name reuse; near-duplicate → create + flag `needsReview`), event-scoped `POST /api/events/[eventId]/billing-accounts` (find-or-create + auto-attach junction), reusable `AddPayerDialog` + `useCreateAndAttachBillingAccount`. The reusable dialog makes these follow-ups cheap:

- ~~**Inline create on the detail-sheet reassign picker**~~ ✅ **SHIPPED July 16 (`6f772e07`)** — "+ Add a new payer" under the Charge-to Select, same `AddPayerDialog` + org-level find-or-create, auto-selects the created payer. Still open: the **quick-add registration dialog** (has no payer picker at all — needs the picker first, like its pre-existing pricingTier/sponsor gap).
- ~~**Admin merge UI for `needsReview` payers**~~ ✅ **SHIPPED July 16 (`6f772e07`)** — new `mergeBillingAccounts()` service (one tx: re-point `Registration.billingAccountId` + `EventBillingAccount` junctions — overlapping attachments dropped, not duplicated — delete the duplicate, clear `needsReview`; MERGE audit row with moved counts), `POST /api/billing-accounts/[id]/merge` (denyReviewer+denyFinance, org-bound both ids, 30/hr), per-row Merge action + survivor-picker dialog in Settings → Billing. +3 tests.
- **Optional niceties** *(S)* — ~~a "Payer" column on the registrations list/CSV~~ ✅ **SHIPPED July 16 (`6f772e07`)** (badge column + CSV "Payer"; finance-redacted server-side). Still open: a payer *filter* on the list; `needsReview` count badge in Settings → Billing; public-registration "who pays" step (schema/route already carry the fields).

### Promo-on-existing-registration — deferred review findings (July 1, 2026)

Adversarial review of the "apply/remove a promo code against an existing registration" feature returned **fix-then-ship, 0 blockers**. HIGH #1 (the "Free registration" price-resolution bug — `originalPrice` stamping) and HIGH #2 (the per-email TOCTOU race — `SELECT … FOR UPDATE` row lock) were **fixed + shipped**. The rest were deferred by product decision, all independently shippable:

- ~~**MEDIUM — 100%-off code strands the registrant's own Remove button.**~~ ✅ **SHIPPED July 16 (`8757020d`)** — the event-scoped `/my-registration` confirmed card renders "Promo code X applied — Remove" whenever a promo zeroed the price on a still-outstanding reg (true COMPLIMENTARY / PAID / sponsored / refunded never show it).
- ~~**MEDIUM — fragile `replaced` flag.**~~ ✅ **SHIPPED July 16 (`8757020d`)** — the flag is set by the branch that actually releases the old code.
- ~~**LOW — `discountValue` sign/cap not validated at apply.**~~ ✅ **SHIPPED July 16 (`8757020d`)** — both apply paths (promo-code-service + public register) clamp: discount floored at 0 (never a surcharge), PERCENTAGE capped at 100. MCP `update_promo_code` now validates the EFFECTIVE type/value pair (REST parity; catches flip-type-to-PERCENTAGE-with-stored-500 too). +2 tests.
- ~~**LOW — register-route promo ordering.**~~ ✅ **SHIPPED July 16 (`8757020d`)** — the per-email check runs BEFORE the `usedCount` increment.
- **Product call — MEMBER sees the applied promo *code*.** `promoCode`/`promoCodeId` aren't in `FINANCIAL_KEYS`, so the read-only MEMBER role sees the code + that a discount exists (the *amount* is redacted). Inconsistent with the sponsor/billing-account redaction posture. Decide whether to add them to `FINANCIAL_KEYS`.
- **Coverage — unstamped `originalPrice` create paths (2 remaining).** HIGH #1 stamps `Registration.originalPrice` at the public-register, registration-service, speaker-companion, and MCP-bulk create paths. **`import-contacts` now stamps it too** (July 2, `fa36ba7` — with the new pricing-tier prompt: tier price, else base price). Still unstamped: the **CSV import** and **EventsAir import** paths — new rows there get null `originalPrice` and rely on the read-fallback (correct for tier'd/flat rows; the one edge left is a *new* VIRTUAL reg created via CSV, which would fall back to the in-person price). No backfill was run (forward-looking fix), so pre-July-1 rows also rely on the fallback until re-created.

### Data-loss audit — residual follow-ups (June 29, 2026)

From the concurrency/data-loss sweep (most fixes shipped: contact-sync + EventsAir import enrich-only, MCP accommodation atomic re-book, bulk-type + import-contacts oversell guards, and the `updateEventSettings`/`updateOrganizationSettings` atomic settings helper). Two review-flagged residuals, both LOW/MED real-world risk (admin single-actor flows), left as tracked follow-ups so the settings-migration commit didn't balloon:

- **MED — cross-field atomicity in the split settings PUTs.** `event PUT`, `org PUT`, and the cert-settings routes (REST + MCP) now write the `settings` blob via the atomic helper and the **scalar columns** (name/dates/cmeHours/etc.) via a separate `db.*.update` — two sequential writes. A crash/error *between* them leaves a partial update (settings persisted, scalars not, or vice-versa); the original single-`update` was atomic across both. Fix: give the helper an optional `tx` param and wrap the scalar update + settings merge in one `$transaction` per caller (settings-merge first so the scalar update returns the merged row for the response). Low risk (admin single-actor; window is a crash between two awaits).
- **LOW — `settings.webinar` sub-key last-write-wins.** The webinar PUT / provisioner / MCP webinar tools read `settings.webinar`, spread a sub-patch, and write the whole `webinar` key via the object-form helper. Cross-*top-level*-key clobber is fixed, but two concurrent edits to *different sub-keys of `webinar`* (e.g. `lobbyMessage` vs `viewingMode`) still lose one. Fix: use the helper's function-form to read `cur.webinar` inside the lock and merge there. Pre-existing; concurrent webinar-settings edits are unlikely.

### Reviewer/submitter lifecycle audit — open findings (June 26, 2026)

A 3-agent end-to-end trace of the reviewer + submitter + crossover flows. **Two production-breaking HIGHs were fixed in-session** (commit pending): self-registered submitter-speakers now mint a companion registration (badge/check-in/survey/cert), and resubmit-after-revision now re-stamps `submittedAt` + emails the author + notifies organizers. The rest are tracked here:

| Finding | Sev | Effort | Notes |
|---|---|---|---|
| ~~**Pool reviewers never told there's work; per-abstract reviewers card omits pool members**~~ ✅ SHIPPED June 26 | HIGH | M | A pre-existing reviewer account added to the pool now gets a `reviewer-pool-invitation` email ("you're a reviewer for X", link to `/my-reviews`) via `notifyReviewerPoolAdded` (new accounts still get the account-setup invite). The "card omits pool members" half was a **FALSE POSITIVE** — `AbstractReviewersCard` already merges `useReviewers` (pool) + `useAbstractReviewers` (per-abstract) client-side (the audit agent only saw the GET route, which is one of two data sources the card combines). |
| **No reviewer reminder mechanism** ⭐ NEXT PICK | HIGH | M | Unlike payment/agreement chases, no way to nudge reviewers who haven't submitted. Can't drive a review round to completion in-product. **All prerequisites now shipped** (assignment + pool notifications + resend + a `reviewer-assignment`/`reviewer-pool-invitation` template pattern to reuse). **OPEN DECISION before building — where does the "chase pending reviewers" action live?** (a) a bulk **"Remind pending reviewers"** button on Settings → Reviewers (event-wide — emails every pool/assigned reviewer with an unsubmitted review), (b) a **per-abstract nudge** on the `AbstractReviewersCard` (remind only the reviewers assigned to *this* abstract who haven't submitted), or (c) both. Likely reuses a new `reviewer-reminder` email template + the `/my-reviews` link + a per-user/per-event rate limit. Resume here. |
| ~~**Per-abstract assignment sends no notification**~~ ✅ SHIPPED June 26 | HIGH | S | Both REST `POST .../reviewers` and MCP `assign_reviewer_to_abstract` now call `notifyReviewerAssigned` (shared helper, new `reviewer-assignment` email template) on a **new** assignment — emails the reviewer the abstract title + role + a link to `/my-reviews`. Failure-isolated; not re-sent on role/COI flips. +5 tests. |
| **Accepted-abstract → "you're presenting" handoff is 100% manual** | HIGH | L | ACCEPTED only flips status + emails a notice with no what/when/where; no link to a session. **Product call needed** — may be intentionally manual; at minimum the acceptance email could say "you'll be scheduled". |
| ~~**Saving a DRAFT abstract emails a "submission confirmation"**~~ ✅ SHIPPED June 26 | HIGH | S | `abstracts/route.ts` POST fired the confirmation email **and** the "New Abstract Submitted" admin notification for both SUBMITTED and DRAFT. Both now gated on `status === "SUBMITTED"` — a draft-save is silent (it isn't submitted + is invisible to reviewers). |
| ~~**COI `conflictFlag` is advisory only — not enforced**~~ ✅ SHIPPED June 26 | MED | S–M | A reviewer flagged conflicted on an abstract is now **blocked from submitting a review** (403 `CONFLICT_OF_INTEREST`) across all three paths: REST submissions POST, MCP `submit_abstract_review`, MCP `admin_submit_review_on_behalf` (checks the target reviewer's flag). +3 route tests. **Note:** they can still *read* the abstract (GET) — hard-gating read access is a possible follow-up; and a conflicted reviewer simply submits nothing, so the `requiredReviewCount` quorum is unaffected by their (now-blocked) review. |
| ~~**Reviewer-invite email failure is silent + no "resend invitation"**~~ ✅ SHIPPED June 26 | MED | S | New `POST .../reviewers/[reviewerId]/resend-invitation` + a "Resend" button on each pending reviewer row. Pending account → re-mints a fresh setup token + resends the setup invite; active account → resends the pool reminder. Unlike the silent add path, a send failure **surfaces** as a 502 (`EMAIL_SEND_FAILED`) so the organizer knows. 20/hr/user rate limit, audited. +4 route tests. |
| **`feedbackOnly` notification is dead code** | MED | S | A reviewer adding notes without a status change never notifies the author (the `feedbackOnly` branch in `notifyAbstractStatusChange` is never invoked). |
| **Mean review score (0–100) shown to submitters** | LOW | S | Product decision — many CFP systems hide raw scores and show only the decision + notes. |
| **Dead `eventSlug` in reviewer invite link; no "my submissions across events" home; coarse `NEEDS_UPDATE`; orphaned reviewer accounts accumulate** | LOW | — | Minor UX/cleanup items. |
| **Authors can't edit a REVISION_REQUESTED abstract** | LOW | XS | July 2: per organizer request, submitters can now edit/withdraw only while their abstract is **DRAFT** — once submitted it's locked and they contact the organizer ([abstracts/[abstractId]/route.ts](../src/app/api/events/%5BeventId%5D/abstracts/%5BabstractId%5D/route.ts) `SUBMITTED_LOCKED`; edit page `canEdit = isSubmitter ? DRAFT : editableStatuses`). **Consequence:** a `REVISION_REQUESTED` abstract is also locked to the author, so a reviewer asking for changes needs an organizer to reopen it (or the author emails the team). If authors should be able to self-edit when a revision is *explicitly requested*, it's a **one-line tweak** — allow `["DRAFT", "REVISION_REQUESTED"]` for submitters in both the edit page `canEdit` and the server submitter block. Left as a deliberate product call. |


### Partial refunds + credit notes — deferred review findings (July 7, 2026)

Adversarial review of the gated-partial-refund feature (commits `b02c361`, `1e483e3`, `dd5df4c`) returned **no BLOCKER**. The two HIGHs were **fixed + shipped**: **H1** (concurrent over-credit — `createCreditNote` now caps inside the tx under a `SELECT … FOR UPDATE` lock) and **H2** (multi-payment webhook `paidTotal` now sums all PAID payments so a full refund of one charge can't mislabel the whole reg REFUNDED); **L4** (partial-CN tax reconciled to the remainder) was folded in too. The remaining findings are deferred, non-blocking, each independently shippable:

| Finding | Sev | Effort | Notes |
|---|---|---|---|
| ~~**Refund gate accepts *any-amount* credit note (M2)**~~ ✅ **SHIPPED July 11, 2026** | MED | S | `refundRegistration` ([payment-service.ts](../src/services/payment-service.ts)) now enforces the amount gate server-side: cumulative `refundedAfter` may not exceed **Σ non-cancelled CN totals** — a $1 CN no longer unlocks a $500 refund. New `CREDIT_NOTE_INSUFFICIENT` (409) with `{creditedTotal, refundedBefore, requested, maxRefundable}` meta; the refund dialog caps its amount at `min(remaining, credited − refunded)` and routes a 409 to the credit-note dialog. Note: on rare captured-vs-computed divergent rows (payments-sum > computed total, see M1 below) a cancel-with-refund can now surface this gate instead of silently over-refunding — conservative by design. |
| ~~**`paidTotal` (payments-sum) vs CN `fullTotal` (computed pricing) divergence (M1)**~~ ✅ **SHIPPED July 16 (`a461420e`)** | MED | M | ONE collected-truth: `createCreditNote` now caps (and defaults) against **Σ settled payments when Payment rows exist, else the computed total** — byte-for-byte the refund's `paidTotal` rule — read inside the `FOR UPDATE` lock. Bonus: the parent invoice flips REFUNDED when the RUNNING credited total covers the collected total (two partial CNs used to never flip it). |
| ~~**Stripe-error rollback can clobber a webhook-advanced `refundedAmount` (M3)**~~ | MED | S | **STALE FINDING (verified July 16)** — the July-10 `b579bbe` RefundAttempt rework already replaced the unconditional reset with a **verify-first** error path + a **guarded decrement** (`updateMany where refundedAmount >= rollbackPortion, decrement`) that deliberately un-books only the portion this call knows never moved, precisely so webhook-advanced amounts survive. |
| **`refundedAmount` never reset on re-payment (L1)** | LOW | S | Monotonic forever; a partial-refund-then-repay reg misstates the refundable balance. Reset/rebase on new payment or document as unsupported. |
| ~~**Webhook out-of-band CN rejected by the cap is silent (L2)**~~ ✅ **SHIPPED July 16 (`a461420e`)** | LOW | S | A cap-rejected auto-CN now fires a "⚠ Credit note could not be recorded for a Stripe refund" admin notification alongside the warn log. |
| ~~**Client CN cap uses payments-sum, server uses computed total (L3)**~~ ✅ **CLOSED July 16 (via M1)** | LOW | XS | The server now caps against payments-sum too, so the client and server caps agree by construction. |

### Cancel-with-refund + payment-service — deferred review findings (July 8, 2026)

Adversarial review of the cancel→refund arc (commits `dbaf3a2` payment-service extraction, `d05a262` cancelled-owes-nothing, `4806e8d` cancel backend, `6532d45` cancel UI) returned **no BLOCKER**. The one **HIGH (H1)** was **fixed + shipped** (a paid-cancel with `financials` absent — transient on-open fetch failure — fell through to a silent no-refund cancel; now blocked with a "reload before cancelling a paid registration" toast). Deferred, non-blocking:

| Finding | Sev | Effort | Notes |
|---|---|---|---|
| **"Cancel & refund" silently discards other staged edits (M1)** | MED | S | [registration-detail-sheet.tsx](../src/app/%28dashboard%29/events/%5BeventId%5D/registrations/registration-detail-sheet.tsx) — `cancelWithRefund` POSTs `/cancel` and never sends `editData`, so a badge/notes/billing edit staged in the same session is dropped (unlike "Just cancel" which runs the PUT). Surface a "other unsaved changes will be discarded" note in the dialog, or persist staged edits first. |
| ~~**Refund succeeds but cancel-tx fails → generic 500 after money moved (M2)**~~ ✅ **SHIPPED July 16 (`a461420e`)** | MED | S | The cancel transaction has its own try/catch; a failure AFTER the refund committed returns the new `CANCEL_FAILED_AFTER_REFUND` code ("retry the cancel — the refund will not run twice"; retry is safe because the reg is REFUNDED by then, so the refund branch no-ops). |
| ~~**Auto-credit-note amount (computed `fullTotal`) vs refund amount (`paidTotal`) can diverge (M3)**~~ ✅ **SHIPPED July 16 (`a461420e`, via July-7 M1)** | MED | M | `createCreditNote`'s default amount + cap now use the same Σ-settled-payments collected-truth the refund uses, so the auto-CN and the refund can no longer disagree. |
| ~~**payment-reminder with an explicit `status:"CANCELLED"` filter still chases cancelled (L1)**~~ ✅ **SHIPPED July 16 (`f985a747`, via comms-R2 A6)** | LOW | XS | The explicit-CANCELLED filter is now rejected outright (400 `INVALID_FILTER`) for payment-reminder + survey-invitation + certificate, at both enqueue doors and fire time. |
| ~~**Spurious CN in the (near-unreachable) PAID-but-fully-refunded cancel branch (L2)**~~ ✅ **SHIPPED July 16 (`a461420e`)** | LOW | XS | `cancelRegistration` short-circuits the CN + refund entirely when the settled payments are already fully refunded (decidable from Payment rows; a hand-flipped PAID reg with none keeps the normal flow). |
| **PUT cancel double-release depends on callers sending the optional `expectedUpdatedAt` (L3)** | LOW | S | [registrations/[registrationId]/route.ts](../src/app/api/events/%5BeventId%5D/registrations/%5BregistrationId%5D/route.ts) — the no-double-release guarantee relies on the optimistic lock + a pre-tx `isBecomingCancelled` read; a future PUT caller that omits the lock on a status→CANCELLED would double-release seat/promo. Gate the seat/promo release inside the tx on the claim `updateMany` count (as `cancelRegistration` does). |

### Cross-caller duplication audit — deferred findings (July 8, 2026)

A codebase-wide audit (after the registration seat-transition + accommodation
duplication fixes) for "same domain op implemented in >1 entry point" — see
[src/services/README.md](../src/services/README.md) "THE RULE". **The 3 HIGHs were
fixed + shipped:** #1 accommodation status transition → `applyRoomStatusTransition`
([accommodation-rooms.ts](../src/lib/accommodation-rooms.ts)); #3 cert `loadPdfBytes`
(a **live security drift** — the worker copy lacked the resend route's traversal/SSRF
guards) → shared guarded [pdf-loader.ts](../src/lib/certificates/pdf-loader.ts); #2
MCP session date-validation → the shared `isSessionWithinEventDates`. Deferred:

| Finding | Sev | Effort | Notes |
|---|---|---|---|
| ~~**`updateRegistration` orchestration still mirrored REST ↔ MCP (#5)**~~ ✅ **SHIPPED July 13 (`a0b427f`)** | MED | L | The seat/promo transition is now shared (`applyRegistrationTransition`) + `resolveRepricing`/`readSponsors` are shared, but the rest of the update body (sponsor INCLUSIVE-invariant, billingAccount lookup, change-set assembly, audit/sync/stats fan-out) is still hand-mirrored between [registrations/[id]/route.ts](../src/app/api/events/%5BeventId%5D/registrations/%5BregistrationId%5D/route.ts) and MCP `updateRegistration` ([tools/registrations.ts](../src/lib/agent/tools/registrations.ts)) — the "Same rules as the REST PUT route" comment. Natural next `registration-service.updateRegistration()` extraction (mirrors the create path). |
| **Bulk-status seat/promo policy is a 4th copy (#6)** | MED | M | `bulk_update_registration_status` reuses the leaf seat primitives but hand-writes the cancel/reactivate → promo+seat *policy* (its own batched aggregation is a legit mechanics exception). Extract `planBulkSeatTransition(rows, status)` returning release/claim/promo maps, keeping bulk oversell-logging in the caller. |
| ~~**`send_bulk_email` (MCP) reimplements recipient resolution**~~ ✅ **SHIPPED July 13 (`6f5f6e9`)** | MED | M | The REST bulk-email route shares `executeBulkEmail`; MCP `send_bulk_email` ([tools/communications.ts](../src/lib/agent/tools/communications.ts)) has its own inline recipient-resolution + per-recipient send loop (simpler — no attachments/templates/filters). Route it through `executeBulkEmail` (or a shared resolver) for parity. |
| **`ATTENDEE_ROLE_VALUES` enum set duplicated in 2 MCP tool files (#7)** | LOW | XS | Re-declared in [tools/speakers.ts](../src/lib/agent/tools/speakers.ts) + [tools/registrations.ts](../src/lib/agent/tools/registrations.ts); `tools/_shared.ts` already holds the sibling enum sets. Move it there. |
| **`escapeHtml` — 4 more copies repo-wide** | LOW | XS | The 3 cert copies are now shared via [src/lib/html.ts](../src/lib/html.ts); `speaker-agreement.ts`, `email.ts`, `abstract-notifications.ts`, `presenter-agreement.ts` still have local copies. Point them at `@/lib/html` (email.ts's is intentionally private — confirm before touching). |

### Certificate rework — deferred review findings (July 9, 2026)

On-demand single issue + single/bulk **re-render + resend from the CURRENT
template** shipped across `6539d95` (single service + routes) → `140723d`
(Phase-3 UI: Issue / Resend-latest / Resend-all + no-silent-failure logging) →
`84979c7` (Phase-4 bulk + `reissueCount`). Independent adversarial review on the
Phase-4 backend: **SAFE TO SHIP — 0 blocker / 0 high** (the make-or-break
`@@unique([runId, speakerId])` NULL question is provably collision-free — it's a
partial unique index `WHERE speakerId IS NOT NULL`, so NULL-facet bulk items are
excluded from the index entirely). Fixed in-band: L1 (null-not-`""` `actorUserId`
for a worker-triggered reissue), M1-doc (`reprintCount` = render-attempts vs
`reissueCount` = delivered-refreshes). Deferred:

| Finding | Sev | Effort | Notes |
|---|---|---|---|
| ~~**Bulk-reissue UI trigger not built yet**~~ | — | M | ✅ **SHIPPED (July 9, 2026).** Certificates page → Issue tab → per-template "Resend to everyone (N)" button (N = issued-cert count from the template's `_count`), confirm dialog, seeds the existing per-template run panel so reissue progress (PENDING→SENDING→COMPLETED) shows inline; handles 409 `REISSUE_IN_PROGRESS` (adopts the in-flight run) + 422 `NO_CERTS`. Resends to **everyone** who holds the cert (no tag scope in the UI — the endpoint's optional `tag` filter stays API/MCP-only). |
| **M1 — `reRenderAndResendCert` bumps `reprintCount` + `pdfUrl` before the send** | MED | S | On a repeatedly-send-failing item, `reprintCount` increments each retry while `reissueCount` stays flat. Documented as intended (reprint = render attempts, reissue = delivered). If it ever reads as misleading, move the `reprintCount` bump into the post-send success block alongside `resendCount`/`reissueCount` (needs 2 deliver-test assertion updates). [deliver.ts](../src/lib/certificates/deliver.ts) |
| **L2 — "one active reissue run per template" guard has a TOCTOU window** | LOW | S | `findFirst`-then-`create` in separate steps ([bulk-reissue/route.ts](../src/app/api/events/%5BeventId%5D/certificates/bulk-reissue/route.ts)) — two near-simultaneous requests could both pass → a recipient gets two re-render+resend emails. Rate-limited (10/hr/user) + operator-driven, so low. Close with a partial unique index (`WHERE reissue AND status NOT IN terminal`) or a row-locked in-tx guard. |
| **L3 — cert revoked between cohort-snapshot and drain shows as a run failure, not a clean skip** | LOW | XS | `reRenderAndResendCert` re-checks `revokedAt` (correct — no email to a revoked cert), but the item is marked failed (`CERT_REVOKED`) → inflates the run's `failedCount`. Cosmetic; could be a distinct "skipped" state. |

### External / integration API — deferred findings (July 9, 2026)

Surfaced while building the **EA-SYS → Webflow people sync** in n8n (pulls an
event's committee + speakers on a 4-hourly schedule and upserts them into a
Webflow CMS collection). Nothing here is broken today; these are the ceilings and
papercuts that surface as the faculty list grows or as more integrations consume
the REST API. Context: committee members are **speakers tagged `committee`**
(see [COMMITTEE_MEMBERS.md](COMMITTEE_MEMBERS.md)); the sync keys on
`Speaker.sourceRegistrationId` / registration `id`, so that field's stability is
load-bearing for an external consumer.

| Finding | Sev | Effort | Notes |
|---|---|---|---|
| **`GET /speakers` (and `/registrations`) are unpaginated and return every column** | — | M | `db.speaker.findMany` with no `take`/`skip`/cursor returns **all** rows, each with ~41 scalar fields incl. `bio` (`@db.Text`, Zod-capped at 10k chars) + 4 included relations. Measured shape: **500 speakers ≈ 0.75–1.5 MB** typical, ~5–6 MB worst case (all bios maxed). Fine on EC2 today (one `findMany`, sub-second, no serverless timeout) — **the real ceiling at 500 is the *Webflow write* side** (~60 req/min → a 500-item first sync ≈ 10 min + 429s), not this read. Revisit when a single event's speaker/registration list plausibly exceeds ~1–2k: add `?limit=&offset=` (or cursor) **and** a `?fields=` / lean `?view=sync` projection so integrations fetch the ~10 columns they use instead of all 41 (drops `bio`/`socialLinks` bloat ~3×). Consumers should meanwhile do **skip-unchanged** (compare `updatedAt`) so steady-state runs write deltas, not the full set. |
| **`?tags=` GET filter is case-sensitive and skips `normalizeTag`, while writes Title-Case** | LOW | XS | On write, [`normalizeTag`](../src/lib/utils.ts) Title-Cases every word, so a tag typed `committee` / `COMMITTEE` is stored `Committee`. But the registrations `?tags=` query path only `.trim()`s each value ([registrations/route.ts](../src/app/api/events/%5BeventId%5D/registrations/route.ts)) and `hasSome` is an exact match — so **`?tags=committee` silently returns `[]`** against a `Committee` tag. Surprising, and it reads as "no data" rather than "no match". Fix: run the query values through `normalizeTag` too (+1 test). Integrations currently work around it by pulling unfiltered and matching case-insensitively client-side. |
| **MCP `list_registrations` has no `tags` param** | — | S | REST supports `?tags=` (any-of `hasSome`); the MCP tool doesn't, so an agent can't pull a tagged cohort (committee, VIP…) without listing everything. Pairs with the proposed `?segment=committee\|faculty\|internal` union filter in [COMMITTEE_MEMBERS.md](COMMITTEE_MEMBERS.md) §4c. |

### Speaker ↔ companion-registration lifecycle — deferred (July 9, 2026)

`Speaker.status` (invitation lifecycle: `INVITED`/`CONFIRMED`/`DECLINED`/`CANCELLED`)
and `Registration.status` (attendance lifecycle: `PENDING`/`CONFIRMED`/`CANCELLED`/
`WAITLISTED`/`CHECKED_IN`) are **independent enums on different models and never
sync**. The companion registration is created with `status: "CONFIRMED"` **hardcoded**
([speaker-companion.ts](../src/lib/speaker-companion.ts)) and nothing ever revisits it.
Increasingly load-bearing now that **committee members are added as Speakers** (they're
complimentary, and the companion gives them badge/barcode/check-in/certs — see
[COMMITTEE_MEMBERS.md](COMMITTEE_MEMBERS.md)).

| Finding | Sev | Effort | Notes |
|---|---|---|---|
| ~~**A DECLINED speaker keeps a CONFIRMED companion registration — badge + entry barcode stay valid**~~ ✅ **SHIPPED July 11, 2026** | MED | S–M | New `cascadeSpeakerDecline()` + `isSpeakerDeclineTransition()` in [speaker-service.ts](../src/services/speaker-service.ts) — ONE implementation for both status-write callers (REST speaker PUT + MCP `update_speaker`, per the no-cross-caller-duplication rule); the cancel itself delegates to `payment-service.cancelRegistration` (refund:false), so seat/promo release + audit + checkout-session cleanup ride the single cancel domain op. **Companion-only by owner decision** — a real linked registration is never touched (the UI/agent get a "review it separately" note). Both the speaker detail **page** and **sheet** intercept a save that transitions into DECLINED/CANCELLED with a live linked registration and prompt: **"Cancel registration too (revokes badge + entry barcode)"** vs **"Keep registration"**; MCP `update_speaker` gained `cancelCompanionRegistration` (keep-by-default; pkg 0.4.16→0.4.17 — MCP clients reconnect). Cascade audited (`SPEAKER_COMPANION_CANCELLED`) + logged; +7 service tests. The reverse (DECLINED→CONFIRMED reactivation) stays manual/deferred. |
| **Speaker → companion profile edits don't sync** | LOW | S | Known Phase-0 follow-up: editing a speaker's name/profile doesn't propagate to the companion registration's attendee row (the two drift). Same shared-helper landing spot as the row above. |

### Backlog — prioritized pick list (June 24, 2026)

A single scannable view of what's workable, in priority order. Each item links to
its detailed entry in the sections further down. Effort: **S** ≈ <½ day, **M** ≈
½–2 days, **L** ≈ multi-day. Sev = correctness/security severity where it applies.

**✅ Closed this session (June 23–24, 2026) — do NOT re-pick** (detailed entries struck through below):
- Accommodation overbooking TOCTOU (HIGH) — atomic claim shipped.
- Registration DELETE destroys shared Attendee (HIGH) — sibling guard shipped.
- Stripe post-payment fire-and-forget (HIGH) — invoice-reconciliation worker shipped (the stronger in-tx "outbox" variant remains optional).
- ~8 silent `safeParse`→400 (MED) — June-23 sweep found 0 remaining (claim was stale).
- Webinar 404 alert noise (recording + attendance/engagement) — suppressed + give-up shipped.

**P1 — Correctness / security debt still open** (pick first; none is a feature):
1. ~~**`PricingTier.soldCount` double-leak** (HIGH)~~ ✅ **SHIPPED June 29, 2026.** The seat model ([registration-seat.ts](src/lib/registration-seat.ts)) is now tier-aware: `seatCounter(row)` routes a seat to the **tier** (`createdSource === PUBLIC_REGISTER && pricingTierId`) or the **ticket type**; `planSeatTransition` returns a `SeatCounter`. Guarded appliers ([registration-seat-db.ts](src/lib/registration-seat-db.ts)) `releaseSeat`/`releaseSeats` (never < 0) + `claimSeat` (atomic capacity guard) applied at all 5 decrement/transition sites (REST PUT cancel/reactivate/type-change, REST DELETE, bulk-type, MCP `update_registration` + `bulk_update_registration_status`); refund is a no-op. Type-change nulls the stale `pricingTierId` on both the transition and the persisted row. DELETE/bulk also picked up the latent virtual-reg counter bug. The seat model also excludes **speaker companions** (`createdSource === SPEAKER_COMPANION`) — faculty are uncapped + created with no soldCount increment, so they consume no counter (mirrors create; the prod dry-run caught the script otherwise inflating every event's Faculty counter). One-time **reconciliation script** [scripts/reconcile-soldcounts.ts](scripts/reconcile-soldcounts.ts) (reuses the same helpers — can't drift; dry-run default, `--write`, `--event`, `--exclude <ids>`). Adversarial review = SAFE TO SHIP, 0 new bugs. **DATA REPAIR DEFERRED:** `soldCount` is effectively **dormant today** — almost all events are unlimited-seat, so nothing enforces these counters yet; the leak's live impact is ~nil. The code fix is the future-proofing for **when capacity limits matter (multi-tenancy)**. The prod `--write` is therefore **held** — re-run the dry-run when capacity enforcement / multi-tenancy lands (data will have moved on) and decide the legacy-row policy then. **MED-1 (pre-existing):** legacy public+tier rows created before 2026-06-05 have `createdSource = NULL` → routed to the ticketType counter; a `--write` shifts their counts tier→ticketType (June-29 prod dry-run: ~7 such rows on OSH Monthly Meeting + 1st Heart Failure Forum). Use `--exclude` to skip events pending that A/B (keep-on-tier via a `createdSource` backfill) decision. **UPDATE July 24, 2026: capacity limits are now UI-settable** (Seat Limit inputs on the Registration Types page — commit `6a816ac9`), so the guards are no longer dormant for NEW limits. Owner decision: the `--write` data repair stays HELD — no past event needs a limit, and the tier-aware transition model keeps counters correct going forward; revisit only if a limit must be applied to a pre-June-29 event's ticket types.
2. ~~**`abstractTitle` not HTML-escaped in cert email** (MED, stored-XSS)~~ ✅ **ALREADY FIXED** (verified July 13, 2026 cert review — M8). [email-tokens-resolver.ts](src/lib/certificates/email-tokens-resolver.ts) escapes the DB-fetched abstract title under `escapeDynamic`, and every HTML-body caller sets `escapeDynamic: true`. This entry was stale doc-drift; struck.
3. **`refreshEventStats` lost-update** (MED) — serialize per-event. *(M)* → Audit Hardening
4. **Money rounding divergence** (MED) — payment-confirmation email ignores discount/round2. *(S)* → Audit Hardening
5. **Frontend silent failures** (MED) — bulk-tag toast, registrant-portal fetch-error, MEMBER 403 buttons. *(M)* → Audit Hardening
6. **Add-Registration dialog vs full-page drift** (MED) — dialog drops pricingTier/sponsor. *(M)* → Audit Hardening
7. **MCP finance boundary / OAuth role snapshot** (MED). *(M)* → Audit Hardening
8. **Blue-green migration guardrail** (MED) — CI reject destructive SQL w/o EXPAND_CONTRACT_OK. *(S)* → Audit Hardening

**P2 — Quick wins (small, visible UI/feature gaps):**
9. **Abstract → Session linking (UI)** *(S)* · 10. **Room-Type Edit/Delete UI** *(S)* · 11. **Accommodation Booking UI** *(M)* · 12. **Registration Delete button (UI)** *(S)* · 13. **Survey-completed column + filter in the registrations list** *(S, detail-sheet display already shipped)* · 14. **Cert cosmetics cluster** (`handleNudgeY` ref, "Cert" pill baseline, dev-sentinel-in-prod, `?.` on resend) *(S each)* → Near-Term + Certificates deferred findings

**P3 — Larger features / follow-ups:**
15. **Sent-email content preview** ("see what was sent" — `bodyHtml` + View) *(M)* → Near-Term
16. **Hybrid attendance** — ✅ admin virtual↔in-person **qrCode minting + seat-accounting** SHIPPED June 26 (see Hybrid follow-ups below). Still open: check-in UI hide for virtual, dashboard in/virtual split, portal mode display, tier-windowed virtual pricing *(M)* → Hybrid follow-ups
17. **Charge-to-account v1.1** — public "who pays" step, payer column/CSV, quote-email-to-payer *(M)* → Charge-to-account follow-ups
18. ~~**Webinar waiting-room follow-ups** — never-opened-room warning, save-time HLS validation, DRAFT-auto-open hint *(S–M)*~~ ✅ **SHIPPED July 27, 2026** (webinar batch — see "Webinar waiting room follow-ups")
19. **Waitlist Management** *(M)* · 20. **Analytics Dashboard** *(M)* → Near-Term

**P4 — Refactor / cleanup / resilience (trigger-driven):**
21. **Resilience helper** (`withTimeout`/`withRetry`/`CircuitBreaker`) + cheap `?connect_timeout=15` precursor *(M)* → Near-Term
22. **Dead-code cleanup** — ~150 LOC commented email providers · half-extracted `AiProvider` · Vercel vestiges *(S–M)* → Abstraction cleanup
23. **registration-detail-sheet refactor** steps G→H (only when it passes ~3k lines) *(L)* → refactor remainder

**P5 — Infra hardening (deferred from INC-001):**
24. **CI → ECR build, box pulls** (HIGH — the OOM root-cause fix) *(M, + operator AWS steps)* · 25. container `mem_limit` *(S)* · 26. mem/disk CloudWatch alarm *(S)* · 27. external `/api/health` uptime check *(S)* → Deploy/Infra Hardening

**Sequenced big programs (locked order, runs around the above):** Core Stability passes → **Certificates** (multi-role + speaker-as-attendee + survey-auto-issue all SHIPPED June 25 — see below) → **Stripe live-mode** → **Multi-Tenancy / White-Label** (next major program).

**Speaker-as-attendee + multi-role certificates — SHIPPED June 25, 2026** (Phases 0–2; plan: [docs/SPEAKER_AS_ATTENDEE_PLAN.md](SPEAKER_AS_ATTENDEE_PLAN.md)). Speakers auto-get a comp "Faculty" companion registration (badge/barcode/DTCM/check-in/survey; excluded from delegate counts via `EXCLUDE_FACULTY_WHERE`); certs are now **per-template** so one person holds several role certs (Speaker + Moderator + Committee), each with its own role label + manual CME hours (`{{role}}`/`{{cmeHours}}`). **Phase 2 SHIPPED (survey-gated auto-issue, pkg 0.4.11):** completing the survey auto-issues flagged templates **fully automatically** (rendered + emailed, no operator click). Per-template `autoIssueOnSurvey` + `autoIssueTag` (REST + MCP + editor); cert-worker sweep off `Registration.surveyCompletedAt`/`certAutoIssueCheckedAt` (survey POST untouched); routing attendee-tags→ATTENDANCE→registration, speaker-tags→APPRECIATION→speaker; reuses `CertificateIssueRun` (new `autoIssue` flag, nullable issuer, skip AWAITING_REVIEW); idempotent (per-template uniqueness + guard); **retry/backoff** (1/5/15/60/180min, give up after 5) + **analytics** endpoint + card + a CME-accredited badge on the certs page. CME stays a derived event attribute (`Event.cmeHours`/accreditations) independent of cert issuance — non-CME events render blank CME tokens. Known limit: a reg is swept once (flag templates before surveys; else manual Issue). **Phase 3** = manual override (mostly exists — verify per-template-uniqueness compat).

**Phase 2 fast-follow — deferred review findings (June 25, 2026).** Adversarial + performance reviews ran pre-commit; **no blockers** (the "double-email" finding was a verified false positive — `CertificateIssueRunItem.issuedCertificateId @unique` makes the losing item fail-at-link, never email). Deferred, all independently shippable:
- **H2 (correctness) — ✅ SHIPPED June 26 (`reclaimStalledRuns` is now autoIssue-aware):** the cert worker's stall-reclaim bounced a stalled `SENDING` run → `AWAITING_REVIEW`, which a manual run resumes via the operator Send click — but an **auto run has no operator**, so a survey-gated run whose email phase stalled >10 min (SES outage / container restart mid-send) was stranded un-emailed (reg already terminally stamped → sweep won't re-enqueue → silent non-delivery). Now `reclaimStalledRuns` partitions the SENDING reclaim: manual (`autoIssue: false`) → `AWAITING_REVIEW` as before; auto (`autoIssue: true`) → stay `SENDING`, just refresh `lastTickAt` so the next tick re-drains the remaining `emailedAt`-null items (send phase is re-entrant). +2 unit tests.
- **Perf (sweep N+1):** `runAutoIssueSweep` does ~350 queries/tick at batch 50 (per-reg: up to 2 `speaker.findFirst` + per-target `issuedCertificate.findFirst` + `runItem.findFirst` inside the tx) → ~5 hr wall-clock to drain a 5000-all-survey backlog. It's **serial within one advisory lock** (1 connection at a time → not the concurrent contention that caused the P2024 incident), so it's a wall-clock not pool-exhaustion concern. Fix: batch the speaker lookup + the existence probes per tick (one `findMany` keyed by recipient IDs), and/or raise `SWEEP_BATCH_SIZE`.
- **M2 (perf, cheap):** the new partial index keys on `(eventId)` but the candidate query orders by `surveyCompletedAt` + gates on `certAutoIssueNextAttemptAt` — re-key to `surveyCompletedAt` (or `(certAutoIssueNextAttemptAt, surveyCompletedAt)`) under the same partial predicate so the ORDER BY is index-served during a large backlog drain.
- **M1 (perf, cheap) — ✅ poll half SHIPPED `2405a84` (June 26, 20s→60s + staleTime 30s); index half still deferred:** the `AutoIssueAnalyticsCard` polls 8 aggregates; some (`resolved`/`gaveUp` counts, `recentErrors`, the `certsAutoIssued` join) aren't served by the pending-only partial index → still TODO: add `(eventId, surveyCompletedAt)` (+ index `CertificateIssueRun.autoIssue`).
- **Minor/dormant:** legacy `/api/cron/certificate-issues` runs the sweep without the worker's advisory lock (dormant — crontab disabled, worker sole runner; idempotency net holds); tag matching is exact (no case/whitespace normalization — a `Speaker` vs `speaker` tag silently issues nothing); tagless-template terminal-stamp (documented known limit).

---

### Sequencing (locked June 1, 2026)

Two events have gone live (registration-only — Stripe is sandbox). Before
the next feature streams land, the **Core Stability Program**
([docs/CORE_STABILITY.md](CORE_STABILITY.md)) introduces a monthly checklist
+ kaizen burndown of the audit-hardening backlog. Order is firm:

1. **Core Stability Pass #1** — must close ≥ 1 HIGH, all gates green, no
   new HIGH severities.
2. **Certificates** — attendance / presenter / poster certificates with
   automated post-event email. Reuses the HTML→PDF renderer, bulk-email
   per-recipient attachment pipeline, and inline-CID email path.
   See [docs/CORE_STABILITY.md](CORE_STABILITY.md) §Sequencing decision.
3. **Core Stability Pass #2** — runs after certificates ships, before
   payment-live.
4. **Stripe live-mode activation** — payment verification + go-live
   switch. Sandbox keys → live keys; webhook secret rotation; reconciler
   cron for the documented HIGH backlog item ("Stripe post-payment
   side-effects are fire-and-forget"); first-paid-customer rehearsal.
5. **Core Stability Pass #3** — runs after payment-live, before any next
   feature stream.

> **Next major program after the Certificates module: Multi-Tenancy / White-Label
> SaaS** (decided June 24, 2026 — see the dedicated section below). It is the
> designated next feature stream once the certificate work lands; the interim
> stability/Stripe-live passes above still apply.

### Multi-Tenancy / White-Label SaaS (next major program — after Certificates)

*Added June 24, 2026. The next big effort after the Certificates module.* External
demand to white-label EA-SYS so other companies run their events under their own
domain + branding + integrations + money. **Two reference docs are already written
— read both before scoping:**
- **[docs/MULTI_TENANCY.md](MULTI_TENANCY.md)** — the *conceptual* reference: tenancy
  models (Pool/Bridge/Silo), RLS on Prisma+Supabase, Stripe Connect, per-tenant
  observability, ops, a real cost model, security, phased roadmap.
- **[docs/MULTI_TENANCY_IMPACT.md](MULTI_TENANCY_IMPACT.md)** — the *codebase-grounded*
  Impact & Blast-Radius assessment (from a 3-lens read-only audit): where single-org
  assumptions live + what breaks/leaks if done wrong, with a subsystem impact table,
  blast-radius ranking, and breaking-vs-additive migration sequencing.

**Verdict:** well-disciplined for single-org, but **far from safe tenant isolation
today — 0 RLS, isolation by-convention only.** This is **months of foundational
work, not a hardening pass.**

**Biggest blast-radius items (the work):**
1. **No RLS + 25 of 33 tenant tables have no `organizationId` column** (scoped only
   via `eventId`) — RLS needs join-policies or denormalization. The central project.
2. **Systemic public `where:{slug}` with no org filter** (~15 routes + lobby/stream
   micro-caches) — `Event.slug` is unique only *per-org*, so this is "correct by
   accident" and becomes a **cross-tenant public-page leak the instant a 2nd org
   exists.** The #1 latent bug.
3. **`User.email` global-unique** — the hardest identity call (recommend: shared
   `User` + a `Membership` join table, preserving the cross-org reviewer; full
   per-tenant user rows can't be migrated in one step on a live payments DB).
4. **193 `organizationId!` assertions + IDOR-by-convention** — durable fix = RLS + a
   CI lint (audits keep finding these).
5. **Stripe single-account → Connect**; plus per-tenant **email (no DKIM) / storage
   (not isolated) / logging (no tenant tag) / rate-limiting (in-memory)** gaps.

**Already per-tenant-ready (don't redo):** Zoom + EventsAir creds, branding,
company/invoice identity, the MCP/API-key surface, schema uniques on
`Event.slug`/`Contact`/`BillingAccount`/`AbstractTheme`.

**Decisions to make first (human call — before any build):** (1) identity model
(recommend shared User + Membership); (2) isolation model (recommend shared-DB +
RLS; flat-via-denormalized-`organizationId` vs join-policy RLS); (3) Stripe Connect
destination charges + application fee; (4) MM Group migrated **last** (it's live
prod with real money) or kept siloed.

**Do-now prep (safe before committing to the full build):** a **CI lint** for
`where:{id}`/`where:{slug}` without an org bind (stops IDOR recurrence); lock the
identity + isolation decisions; **incrementally denormalize `organizationId`** onto
the 25 event-scoped tables (additive + backfill — the prerequisite for flat RLS).

**Phasing** (maps to MULTI_TENANCY.md §13): Phase 1 = isolation foundation (host→tenant
routing + `TenantDomain`, pooler-safe `SET LOCAL` Prisma extension, RLS on every tenant
table, the slug-routing cut shipped *with* the resolver, a tenant-isolation test suite —
**the gate; nothing onboards to shared infra until proven**). Phase 2 = platform features
(Stripe Connect, per-tenant email sender-domain verification, custom-domain TLS, per-tenant
logging/quotas + Redis limiter, tenant lifecycle). Phase 3 = scale + consolidate (cost
attribution, worker fairness + the `DIRECT_URL` lock fix before a 2nd worker, per-tenant
secret keys/KMS, migrate MM Group in last).

### Speaker ↔ Registration identity unification — Person/Contact hub (future initiative, scoped June 24, 2026)

**Today (and intentionally, for now):** `Speaker` and `Registration`/`Attendee`
are **separate first-class records** with no FK between them — correlated only by
`email` (and a shared `User` when one exists). "Import registration → speaker"
**copies** the attendee's fields into a new Speaker row, so the two then drift.
This is *correct* for the common case the owner described: many speakers are
**independent** (sponsor- or society-suggested, manually added, may never
register), so a speaker **must** be able to exist with no registration.

**Shipped as the 80/20 (June 24, Option A):** a nullable `Speaker.sourceRegistrationId`
pointer (set on import; read-time email-match fallback for older/independent
speakers) + a unified **speaker Activity timeline** that surfaces the linked
registration's audit + email activity **pointed, not duplicated**. Person data is
still two rows, but the activity is linked.

**The future initiative (Option B — a real project, NOT a quick task):** make a
single **Person/Contact identity hub** that **both** `Speaker` and
`Attendee`/`Registration` *optionally* reference — so "speaker" and "registrant"
become **roles/functions on one person**, edit-once-updates-everywhere, activity
naturally shared. **Critical constraint:** it must be `Speaker → Person?`
(optional), **never** `Speaker → Attendee` (required) — that would break every
independent/manually-added speaker. The existing `Contact` store (org-level,
deduped by `(org, email)`, already synced from both speakers + registrants) is the
seed of this hub. Scope = schema + backfill + rewrite of speaker/attendee CRUD +
the import becomes "flag this person as also a speaker" instead of copying +
many read/write paths. High blast radius (identity is load-bearing) → own design
doc + phased rollout. Natural to fold into the **Multi-Tenancy** program above (a
tenant-scoped Person identity is needed there anyway). Effort: **L+**.

### Near-Term (Next 1–2 Months)

| Feature | Description |
|---|---|
| **Wave 4 Testing** | Repeat of waves 1–3 (Performance & Load + Security) covering everything shipped since wave 3. Scope: analytics endpoint + dashboard, on-demand barcode rendering (admin + registrant + inline-CID email), additionalEmail surface across attendee/speaker/MCP/registrant, DTCM toggle + bulk-import path, badge-print tracking + CSV exports, AuditLog composite index growth, MCP `get_event_analytics` + `additionalEmail`/`requiresDtcmBarcode`/speaker `bio`/`photo`/`country` additions, post-2026-05-18 remediation items still on the backlog. Scheduled separately from monthly stability passes — runs as a standalone wave. |
| **External REST API (Phase 3 of services refactor)** | Public-facing API for 3rd-party integrators. Each endpoint is a thin wrapper over a service. **Drives the `registration-service.ts` extraction** (Phase 2c was deferred for exactly this — the API spec is the forcing function that shapes the service). |
| **Abstract → Session Linking (UI)** | Link accepted abstracts to sessions directly from the abstract detail view |
| **Room Type Edit/Delete UI** | Complete the accommodation UI (API already exists) |
| **Accommodation Booking UI** | Full booking creation and management interface |
| **Registration Delete Button (UI)** | Surface the existing delete API in the admin panel |
| **Sent-email content preview ("see what was sent")** | The per-entity Email History card (registration/speaker/contact sheets) shows metadata only — `EmailLog` stores `to/cc/subject/template/status/timestamp` but **no body**. Add a `bodyHtml @db.Text` (nullable, additive) column populated by the `sendEmail` wrapper with the exact rendered HTML that went out (post-branding/CSS-inline/per-recipient tokens — the only accurate "what was sent"; re-rendering from the template would be wrong), plus a **"View"** action per history row → a preview dialog (reuse the desktop/mobile email-preview dialog). Pre-feature rows show "content not captured". **Decision needed:** store body for ALL sends (full auditability — recommended) vs scoped (transactional/cert/bulk only) and/or a retention sweep (bodies ~10–50 KB each; metadata kept regardless). Requested June 24, 2026. |
| **Analytics Dashboard** | Registration trends, revenue summary, check-in rate, abstract acceptance rate by event |
| **Waitlist Management** | Automatic waitlist promotion when registrations are cancelled |
| **Resilience helper (`src/lib/resilience.ts`)** | Shared `withTimeout` / `withRetry` (jittered backoff) / `CircuitBreaker`. Closes the audited gap: Stripe/Zoom/Anthropic SDK calls lean on default timeouts, no bounded-retry, no breaker (repeated failures each pay full timeout). **Decided design:** retry opt-in never default; only reads + idempotent writes; baked-in retryable classifier (5xx/429/network/timeout, never 4xx) with override; in-memory breaker state (same trade-off as `checkRateLimit`, pluggable interface for future Redis); centralized timeout table. **Phasing:** P1 ship helper + tests, no call-site changes; P2 wrap Zoom client / safe-fetch / email send / **Prisma client via `$extends` query middleware** (added 2026-06-01 — Sentry 111629996 ETIMEDOUT pattern is the canonical retryable DB case; the per-error classifier shipped in `67cc437` already exposes a `retryable` flag the wrapper would consume); Stripe idempotency-key retry is a separate, riskier PR — NOT in scope. **Cheap precursor mitigation (file-level, no helper needed):** add `?connect_timeout=15` to `DATABASE_URL` so a dead-pool-slot pickup fails in 15s instead of the 75s OS-kernel default — turns 75s user-perceived hangs into 15s recoveries while we wait on the helper. Full design discussion in session 2026-05-18. |

### Deploy / Infrastructure Hardening (deferred — added June 16, 2026)

Driven by **INC-001** (on-box `docker build` froze the swapless host; see
[docs/INCIDENTS.md](INCIDENTS.md)). Swap (4 GB) is already added as the cheap
insurance; these are the durable fixes, deferred for a future pass.

| Priority | Item | Detail |
|---|---|---|
| ✅ SHIPPED (2026-07-01) | **Build the Docker image in CI → push to ECR → box pulls** (incident action item #2) | **The actual fix for the OOM class + the ~8-min on-box build.** **AWS done:** ECR repo `803726282629.dkr.ecr.ap-south-1.amazonaws.com/ea-sys`, GitHub-OIDC push role `ea-sys-gha-ecr-push` (no stored keys), ECR-pull on the box instance role. **Step 1** (`a25cc35`): a `build-push` workflow job builds the **web** (`Dockerfile`) + **worker** (`Dockerfile.worker`) images on GitHub runners and pushes them to ECR (`:<sha>` + `:latest`, `worker-<sha>` + `:worker-latest`). **Step 2** (`e118830`): `docker-compose.prod.yml` (`image:` from `EA_SYS_WEB_IMAGE`/`EA_SYS_WORKER_IMAGE`, `build:` kept as fallback) + `deploy.sh` (ECR-login + `docker compose pull`, on-box-build fallback) + the deploy job now `needs: build-push` and passes `IMAGE_TAG=<sha>`; **migrations run from the pulled worker image** (`docker run --user root <worker-image> npx prisma migrate deploy` — it ships the Prisma CLI, so **DB creds stay in `.env`, never in GitHub**). **Net:** SSH deploy ~8 min → ~1–2 min; the box never runs a memory-heavy build; a pull failure falls back to on-box build; a migration failure aborts before the nginx swap (old slot keeps serving); rollback = `IMAGE_TAG=<old-sha> bash scripts/deploy.sh`. Source maps still upload from the CI `next build` step. **Image hygiene done same day (`7092f8a`):** `provenance: false` + `sbom: false` on both build steps (stops the ~4 untagged attestation manifests/deploy) + an **ECR lifecycle policy** (expire untagged after 1 day; keep the 10 most-recent tagged = ~5 deploys rollback) + `scripts/docker-prune.sh` now trims old pulled `:<sha>` images on the box (keep newest 3 web + 3 worker). Gotcha recorded in [AWS_OPERATIONS §5.x](AWS_OPERATIONS.md): you can't `batch-delete-image` an untagged **child of a manifest list** (`ImageReferencedByManifestList`) — the pre-`provenance:false` attestation children age out only when their parent `:<sha>` tag rotates past keep-10. **Remaining follow-up:** update the cold-standby runbooks (recovery becomes pull-not-build) + the LOW cross-region-replication item below. |
| LOW | **ECR cross-region replication → Singapore (DR)** | ECR lives in `ap-south-1` (Mumbai) — same region as the box + Supabase. A **box-only** loss is covered (replacement box pulls fast), but a **full Mumbai-region** loss also takes ECR down, so a Singapore recovery box couldn't pull. Enable ECR **registry replication** to `ap-southeast-1` (where the DR S3 bucket already is); every push then auto-copies images there. One-time registry setting + small storage cost. Pairs with the standby-box + Supabase-PITR DR plan. |
| MEDIUM | **`mem_limit` on the prod containers** (incident action item #5) | Hard-bound each container's memory in `docker-compose.prod.yml` so one container/build can't consume all host RAM. Belt-and-braces alongside the CI fix. |
| LOW | **Memory + disk metrics → CloudWatch + alarm** (action item #3) | The CloudWatch agent ships *logs* only; default EC2 metrics don't include memory. Add the mem/disk metrics + an alarm on `mem_available < 500 MB` so pressure pages *before* a freeze. |
| LOW | **External uptime check on `/api/health`** (action item #4) | Route 53 health check or UptimeRobot — catches a frozen-but-"running" box (EC2 status checks don't). |
| — | **Instance sizing — NOT recommended as the fix** | Bumping t3.large (8 GB) → t3.xlarge (16 GB) would give the build headroom, but it's **~+$60/mo (≈2×) of always-on RAM for a few seconds of transient build need**, and it doesn't fix the root cause (building on the prod host) — a future heavier build could still approach the higher ceiling. With swap already added (freeze → slow-down) and the CI/ECR fix above (box never builds), upsizing is unnecessary. Revisit only if the *runtime* footprint (not the build) genuinely outgrows 8 GB. |

### DR / backup + nginx hardening (added June 30, 2026)

Surfaced during the conference-readiness + backup review. None blocking; verified
context in [infra/dr/](../infra/dr/) and the DR memory.

| Priority | Item | Detail |
|---|---|---|
| MEDIUM | **nginx box ↔ repo reconciliation** | The live `/etc/nginx/sites-available/ea-sys` has diverged from `deploy/nginx.conf` — and the **box is the LEANER one** (Certbot-stripped). Exact live state captured in [`deploy/nginx.live-snapshot.conf`](../deploy/nginx.live-snapshot.conf) (2026-06-30). The box is MISSING vs the intended config: **HTTP/2** (`listen 443 ssl`, no `http2`) + **security headers** (`X-Frame-Options` / `X-Content-Type-Options: nosniff` / `Referrer-Policy`). Most other deltas (gzip, `/_next/static` caching, agent-SSE buffering) are already handled by Next.js itself, so low-impact. **Fix = targeted on-box edits** (add `http2 on;` + the `add_header` lines) — Certbot manages this file, so do NOT wholesale-replace it. Re-capture the snapshot after any change. |
| LOW | **nginx config → S3 DR backup cron** | The live nginx file is NOT in the scheduled S3 DR backup (only `db/` + `uploads/` + `env/` are). Add a daily `aws s3 cp /etc/nginx/sites-available/ea-sys s3://ea-sys-dr-singapore/nginx/$(date -u +%F).conf …` line mirroring the `.env` backup, so a box rebuild has the exact config. The repo snapshot is the interim backup. |
| ✅ DONE (2026-06-30) | **DB RPO tightening — 2h day / 4h night** | Applied: crontab now `0 2,4,6,8,10,12,14,16,18,22 * * *` UTC = ≤2h RPO Dubai 08:00–22:00, ≤4h overnight (10 dumps/day; script unchanged). Docs ([infra/dr](../infra/dr), AWS_OPERATIONS §2.4) + memory synced. |
| LOW | **Supabase PITR (true zero-RPO)** | Snapshot dumps still lose up to the window (2h/12h) of new rows on a Supabase-loss. PITR (~$25–50/mo) gives seconds-level recovery. Worth it for payment-critical events — though **Stripe is already the payment system-of-record** (the invoice-reconciliation worker recovers payments), so the real exposure is lost DB rows (registrations), not payments. |
| LOW | **DB pool burst headroom** | Verified `connection_limit=10&pool_timeout=15` on the box (fine for the authenticated-desk conference profile). For a heavy public registration-open burst, bump to 15–20 in the box `.env` + `scripts/deploy.sh` (env change needs a deploy, not a restart). Optional. |

### Audit Hardening Backlog (deferred from the May 18, 2026 multi-agent review)

The May 18 review (supervisor + React/Prisma/backend/architecture agents)
fixed the 6 source-verified BLOCKER/HIGH findings in commit `ff3b7e0`
(see CLAUDE.md "Recent Features"). The items below were **corroborated by
the reviewers but consciously deferred** out of that batch. Ordered by
severity; each is independently shippable. None is a product feature —
this is correctness / security / silent-failure debt.

| Severity | Item | Risk & recommended direction |
|---|---|---|
| ~~HIGH~~ ✅ | **Accommodation overbooking TOCTOU** — **CLOSED June 23, 2026** (audit Round 2 / DATA-2, commit `bfc7596`: atomic `updateMany` with `bookedRooms < totalRooms` predicate in the service + the PUT room-change/reinstate paths; test updated). Original detail kept for history: `accommodation-service.ts` (~210-255) and `accommodations/[accommodationId]/route.ts` (~188-222) read `roomType.findUnique`, check `bookedRooms >= totalRooms` in JS, then unconditionally `increment` — no row lock, two concurrent bookings on the last room both pass. The "can't double-book by construction" comment is false. Fix: `$executeRaw` conditional `UPDATE … SET bookedRooms = bookedRooms + 1 WHERE id = ? AND bookedRooms < totalRooms` and check affected rows (Prisma can't express a column-to-column `updateMany` predicate). |
| ~~HIGH~~ ✅ | **Registration DELETE destroys a shared Attendee** — **CLOSED June 23, 2026** (audit Round 2 / DATA-6, commit `bfc7596`: deletes the Attendee only when `registration.count({ attendeeId, id: { not } }) === 0`, inside the same tx). Original detail kept for history: `registrations/[registrationId]/route.ts` (~601) unconditionally `attendee.delete`s after `registration.delete`; Attendee can be shared across registrations (orphan-reuse + email-change clone). No `onDelete` on the FK → P2003 fails the whole delete, or orphans a still-referenced person. Fix: only delete the Attendee when `registration.count({ attendeeId, id: { not } }) === 0`, inside the same tx. |
| ~~HIGH~~ ✅ | **`PricingTier.soldCount` double-leak** — **CODE FIX SHIPPED June 29, 2026** (tier-aware seat model, see the ✅ entry in the priority list above; this table row had gone stale). The one-time data reconciliation remains deferred by owner decision (July 24: no past events need limits). Original detail kept for history: Bigger than first written. Public register increments **either** the tier **or** the ticketType (tier path skips ticketType); admin/service add always increments the ticketType (never the tier — documented). But cancel/delete/type-change/bulk-type/MCP **unconditionally decrement the ticketType**. So a **public + tier** registration cancelled = the tier counter leaks up (never released → phantom sell-out) **and** the ticketType counter leaks down (decremented for something it never counted → can go negative → oversell). Fix is a **routing** change (release the counter that was actually incremented), not an added decrement, applied across ~5 sites. **Full analysis + worked example + fix plan in the subsection right below this table.** |
| ~~HIGH~~ ✅* | **Stripe post-payment side-effects are fire-and-forget, handler returns 200** — **ADDRESSED June 23, 2026** (audit Round 2 / DATA-5, commit `09dab42`: a new `invoice-reconciliation` worker job — every 10 min, advisory-lock 1006 — recovers PAID registrations with a PAID `Payment` but no `INVOICE`, re-running `createPaidInvoice`+`sendInvoiceEmail`; idempotent). *The stronger in-tx **outbox** variant below remains OPTIONAL if you want guaranteed-at-source delivery rather than a reconciler. Needs the worker container redeployed to run. Original detail kept for history: `webhooks/stripe/route.ts` (~122-203): invoice + confirmation email run in a detached IIFE after the tx; failure = customer is PAID but never gets invoice/confirmation, permanently, Stripe won't retry, no reconciler. Fix: persist an outbox/intent row in the same tx that flips PAID; drain via an idempotent reconciliation cron (`createPaidInvoice` already promotes-in-place). |
| ~~HIGH~~ | ~~**Registrant invoice/quote routes missing `denyFinance`**~~ | ~~`registrant/registrations/[id]/quote`, `…/invoices`, `…/invoices/[invoiceId]/pdf` — the non-registrant branch scopes by org only; a MEMBER has an org so passes. Add `denyFinance(session)` on the non-registrant branch (registrant-owned access stays exempt).~~ **CLOSED — Core Stability Pass #1, June 1, 2026.** Three routes gated on the non-registrant branch with `denyFinance` + `apiLogger.warn`; REGISTRANT owner path stays exempt. Regression net: 7 tests in `__tests__/api/registrant-finance-routes.test.ts` pin MEMBER → 403 FINANCE_FORBIDDEN before any DB read. |
| MEDIUM | **`refreshEventStats` lost-update** | Fire-and-forget full recompute with no concurrency control; under a burst the last racing `upsert` wins and may have read a pre-burst snapshot → dashboard counts lag with no self-heal. Fix: serialize per-event (in-proc mutex/debounce) and/or a periodic reconcile; `await` where correctness matters. |
| ~~MEDIUM~~ ✅ | **~8 silent `safeParse`→400** — **CLOSED / not reproducible** (audit Round 2, June 23 2026: a sweep of ~110 `safeParse` sites found **0** missing an `apiLogger.warn` — the earlier "~8 remain" claim was stale). Original list kept for history: `abstract-themes` POST/PUT, `review-criteria` POST/PUT, `promo-codes` POST/PUT, `notifications/read` POST, `email-logs` GET, `registrations/[id]/email` PATCH (Zod branch). Add `apiLogger.warn` via the existing `zodErrorResponse()` helper. Violates the owner's #1 rule. |
| MEDIUM | **Money rounding/discount divergence** | Stripe `payment-confirmation` email recomputes `basePrice*taxRate` ignoring `discountAmount` and skips `round2` — disagrees with the invoice PDF and `computeRegistrationFinancials` by cents for promo+tax registrants. Fix: build the email totals from `computeRegistrationFinancials`. |
| MEDIUM (mostly ✅) | **Frontend silent failures** | ✅ **DONE June 26:** (a) registrant portal no longer renders "not registered" on a failed fetch — `e/[slug]/my-registration/page.tsx` branches on `isError` (red "your registration is safe" card + Try-again `refetch`) + logs; (b) `bulk-tag-dialog.tsx` `handleSubmit` now catches a failed `onSubmit` → `toast.error` + console.error + keeps the dialog open (covers both registrations + speakers callers); (c) **MEMBER write-button 403s:** new client-safe `canWrite(role)` ([src/lib/can-write.ts](src/lib/can-write.ts), {SUPER_ADMIN,ADMIN,ORGANIZER}) now gates the abstracts page's CSV-import / Email-All / Add-Abstract buttons (were `!isSubmitter && !isReviewer`, so MEMBER saw them → 403). The **registrations** list + detail-sheet half was already resolved by the June ONSITE/desk-allow work — MEMBER is a legitimate registration-desk role there (`REGISTRATION_DESK_ALLOW = [ONSITE, MEMBER]`) and management actions are gated by `isDeskOperator` (which includes MEMBER); (d) **GET-load swallows surfaced:** a triage sweep across ~13 client data-loaders added an `else`/`catch` `console.error` to every GET data-LOAD fetch that ignored `!res.ok`, plus a `toast.error` on the PRIMARY-content loads (content editor, event + org settings, hotels/bookings, payment-status, my-registration — log-only on secondary loads like the users list / branding banner / agreement card). Action/mutation handlers untouched. **FINDING CLOSED.** |
| MEDIUM | **Add-Registration dialog vs full-page drift** | The quick-add dialog never sends `pricingTierId`/`sponsorId`, silently producing tier-less registrations that break "Registrations by Tier" + finance reporting. Port the picker or extract a shared form component. |
| MEDIUM | **MCP finance boundary / OAuth role snapshot** | Finance/MEMBER redaction is enforced only in the in-app agent route; the MCP HTTP path has none, and OAuth access tokens snapshot role at consent and never re-check (a demoted ADMIN keeps a finance-exposing token up to 90 days). Bounded today (MEMBER can't mint keys; consent UI RBAC) but fragile. Fix: move the finance/read-only decision into `runTool` keyed off live role from `token.userId`; revoke tokens on role change. |
| MEDIUM | **Blue-green has no expand/contract guardrail** | `scripts/deploy.sh` runs `prisma migrate deploy` while the old container still serves traffic; safe only because every migration has been additive by convention. The reviewer migration proves destructive ones get written. Add a CI check rejecting `DROP`/`RENAME`/`SET NOT NULL`/enum-value-removal in migration SQL unless an explicit `EXPAND_CONTRACT_OK` marker is present; document the two-phase requirement. |
| LOW | **MCP CORS** | `mcp-cors.ts` reflects any `*.anthropic.com`/`*.claude.ai` origin with `Allow-Credentials: true`. MCP is token-auth (no cookies) so impact is bounded — drop `Allow-Credentials` for the MCP transport or use an exact-origin allowlist. |
| ~~LOW~~ ✅ partial `d5ba791` | **Doc drift** — SHIPPED June 26: fixed the `src/middleware.ts`→`src/proxy.ts` (Next 16.1 rename) references on the 4 current-description lines + the stale stdio-MCP "drifts" note (both now share `registerAllMcpTools()`). **Still open:** the "0 silent Invalid-input paths remain" claim is false (a separate sweep — not addressed in this pass). |

#### P1.1 detail — `PricingTier.soldCount` double-leak (investigated June 24, 2026; deferred for a dedicated pass)

Investigating the "one-way leak" row above revealed it's a **two-direction** bug, and the
naive fix (just add a tier decrement) makes it **worse**. Captured here so the implementer
has the full picture before touching **live capacity counters**.

**Two counters.** Each `TicketType` has `soldCount`; if it uses pricing tiers, **each
`PricingTier` also has its own `soldCount`**. A registration increments exactly **one** of
them — *which* one depends on the create path:

| Create path | Has a tier? | Increments |
|---|---|---|
| Public register | yes | **`PricingTier.soldCount`** (ticketType untouched) |
| Public register | no | `TicketType.soldCount` |
| Admin / service add | yes | **`TicketType.soldCount`** (tier untouched — intentional, documented in `registration-service.ts`) |
| Admin / service add | no | `TicketType.soldCount` |

**The decrement side** — cancel, delete, type-change, bulk-type, and the MCP
`update_registration` / `bulk_update_registration_status` paths — **all unconditionally
decrement `TicketType.soldCount`** and never touch a tier counter.

**So the only broken case is a PUBLIC + TIER registration**, and it breaks both ways.
Worked example — Physician type (cap 100) with an Early Bird tier (cap 30):
1. 10 register publicly on Early Bird → `EarlyBird.soldCount = 10`, `Physician.soldCount = 0`.
2. 3 cancel → cancel decrements **Physician** ×3 → `Physician.soldCount = -3`; `EarlyBird.soldCount` stays 10.
- **Tier leaks up:** Early Bird reads 10/30 though only 7 are active → 3 phantom seats burned → tier sells out early.
- **Ticket type leaks down:** `Physician.soldCount = -3` → wrong dashboard counts **and** the `soldCount < quantity` guard now permits oversell.

**Discriminator** for "this reg incremented the tier (so release the tier, not the type)":
`createdSource === "PUBLIC_REGISTER"` **and** `pricingTierId != null` **and** in-person
(`attendanceMode !== "VIRTUAL"` — virtual skips all capacity).

**Fix plan (own pass, NOT a loop tick):**
1. Shared helpers `releaseSeat(tx, reg)` / `reclaimSeat(tx, reg)` that pick tier-vs-ticketType from `(createdSource, pricingTierId, attendanceMode)` and adjust that counter, **guarded `soldCount > 0`** (via `updateMany`) so it can never go negative.
2. Apply at all ~5 sites in place of today's unconditional ticketType decrement/increment: registration PUT (cancel **+** reactivate **+** type-change), DELETE, bulk-type, MCP `update_registration` + `bulk_update_registration_status`. Type-change = release-old + claim-new through the same helpers.
3. Tests: public-tier cancel releases the *tier*; admin-tier cancel releases the *ticketType*; non-tier cancel unchanged; reactivate re-claims the right counter; type-change moves correctly; never goes negative.
4. **Follow-up (separate):** this stops *new* drift only. Counters already drifted from past cancellations need a **one-time reconciliation script** — recompute each `TicketType.soldCount` / `PricingTier.soldCount` from the row-truth (count of non-cancelled registrations, routed by the same discriminator) and reset. Run once after the code fix deploys.

**Risk:** live production capacity counters — a wrong discriminator corrupts counts the other way (oversell / false sell-out). Hence careful + fully-tested, not rushed.

### Seat capacity follow-ups (shipped v1 July 24, 2026 — commit `6a816ac9`)

v1 = type + tier seat limits settable from the Registration Types page (empty =
unlimited 999999 sentinel), sold/limit display, and the opt-in public "N seats
left" (gated by the now-wired **Show Remaining Tickets** toggle, default OFF).
Owner decisions locked: independent counters (tier caps public sign-ups; type
caps admin/desk adds + tier-less types — NO dual-count), no data repair, dormant
Maximum Attendees/Waitlist settings left as-is. Consciously deferred:

| Item | Note |
|---|---|
| ~~**Event-level total cap (Option B)**~~ ✅ **SHIPPED July 24, 2026** (commit `0b4be2f4` + review fixes) | `Event.maxAttendees` column + `Event.seatCount` counter; raw conditional-UPDATE claim; recompute-on-set under FOR UPDATE; hard-blocks public/single paths (`EVENT_FULL`), imports/bulk bypass with warn; HYBRID stays open for virtual; +10 real-Postgres tests. Adversarial review: HIGH-1 (bulk cross-event grouping) + MED-1 (CSV cancelled-row phantom seat, also closed old M6) fixed same day. **Review LOWs deferred:** L1 oversell-report race (log-accuracy only), L2 cap-tx commits before the main event update (matches the accepted split-PUT posture), L3 the recompute tx is a new `db.$transaction` site for the Phase-2 `tenantTransaction` sweep, L4 theoretical predicate footnote (PUBLIC_REGISTER row with tier but null ticketTypeId — no write path produces it). |
| **Waitlist** | "Enable Waitlist" toggle + `WAITLISTED` enum still advertise behavior that doesn't exist (no model/promote logic — Near-Term item 19). Owner: leave for now. |
| **True total-across-tiers cap** | Rejected for v1 (dual-count accounting change on live counters). Revisit only if organizers need "500 Physician total regardless of entry path". |
| **MCP `create_ticket_type`/`update_*` quantity param** | MCP tools don't expose `quantity` yet — agents can't set seat limits (dashboard-only, like prices). Add if asked. |
| **Legacy-row reconciliation (MED-1)** | `reconcile-soldcounts.ts --write` still held; pre-June-5 public+tier rows have `createdSource = NULL`. Re-run the dry-run before applying a limit to any pre-June-29 event. |
| **Admin-create ignores tier counters** | Deliberate (courtesy seats don't burn paid Early Bird inventory) — documented in `registration-service.ts` + both dialog helper texts. "Registrations by Tier" tile (row counts) stays the authoritative per-tier report. |

### Charge-to-another-account follow-ups (v1.1 — shipped v1 May 19, 2026)

v1 (reusable `BillingAccount`, 1-invoice-per-reg, optional PO ref,
per-reg guarantor) is live. Consciously deferred, each independently
shippable, none blocking v1:

| Item | Note |
|---|---|
| **Public "who pays" step** | Self-register lets the doctor say "my institution pays" → either pick an existing active payer **attached to this event** (via the EventBillingAccount junction, May 20 refactor) or create a `needsReview` row that auto-attaches to this event in the same tx so finance dedupes from Settings → Billing. Schema + routes ready; only the public form UI is missing. |
| **Quick-Add dialog picker** | The fast add-registration *dialog* still has no payer picker (consistent with its existing pricingTier/sponsor gap — the full-page form is the tier/payer surface). |
| **Standalone MCP `list/create_billing_account`** | Agent can already assign an existing payer via `create_registration`/`update_registration` `billingAccountId`; payer *creation* stays a Settings task. Add the two org-level tools if agent-driven payer creation is needed. |
| **Registrations-list "Payer" column + CSV** | Detail sheet shows the payer; list/export don't yet (mirror the pricingTier-column follow-up pattern). |
| **AR aging by payer** | Detail GET returns "registrations by payer"; full invoiced/paid/outstanding aging + a "send all to Pfizer" action is v2. |
| **VAT reverse-charge by payer** | v1 prints the payer `taxNumber` on the invoice but does NOT change the tax rate. Cross-border B2B reverse-charge / exemption needs explicit finance sign-off — finance-correctness landmine, do not auto-apply. |
| **Consolidated invoicing** | One invoice → many doctors → one payer. Breaks the 1:1 Invoice↔Registration model + `InvoiceCounter`; schema leaves room (group-by-payer is additive). |
| **Auto-revert on non-payment** | `attendeeIsGuarantor` stores intent; reverting an unpaid third-party reg to attendee-owed is a manual finance action in v1. A dunning/age-out cron is v2. |
| **Quote/confirmation email recipient** | v1 redirects the invoice/quote **PDF** bill-to to the payer, but the confirmation email is still addressed `to: <attendee>` (so the doctor gets a "please pay" quote). v1.1: when a payer is set, send the quote to the payer's billing email (and suppress the attendee "pay now" copy unless `attendeeIsGuarantor`). Flagged by the pre-commit review as a UX/flow nicety, not a correctness/security defect. |

### Hybrid attendance (in-person/virtual) follow-ups (v1.1 — shipped v1 June 12, 2026)

v1 is live: HYBRID events let registrants choose venue vs online; virtual gets
no barcode/badge, is uncapped (skips `soldCount`), is priced via the flat
`TicketType.virtualPrice`, and the confirmation email swaps the barcode for a
"joining instructions will be sent" message. Wired through the public form +
API, the service (admin REST + MCP), the admin full-page Add form, MCP
`create_registration`, and CSV import. Consciously deferred, each independently
shippable, none blocking v1:

| Item | Note |
|---|---|
| ~~**Admin mode-change qrCode minting**~~ ✅ SHIPPED June 26 | Switching a registration **virtual→in-person** left `qrCode` null (can't badge/check-in) **and** mis-handled `soldCount` (a virtual reg never consumed a seat, but cancel/reactivate/type-change still moved the counter). Fixed via a single seat-accounting model — [src/lib/registration-seat.ts](src/lib/registration-seat.ts) `holdsSeat`/`planSeatTransition`/`needsQrCode` (15 unit tests): a reg consumes a seat iff `status≠CANCELLED && IN_PERSON`. Both update paths (REST PUT + MCP `update_registration`) now route every `TicketType.soldCount` delta through it and lazily mint a barcode on virtual→in-person (in-person→virtual releases the seat, keeps the barcode for audit). Capacity-guarded (sold-out virtual→in-person hard-fails `CAPACITY_EXCEEDED`; reg stays virtual). New **Attendance** toggle on the registration detail sheet (HYBRID + non-reviewer). MCP `update_registration` gained `attendanceMode` (pkg 0.4.12). +3 integration tests. Adversarial review = no blockers; also closed a pre-existing REST IDOR (request `ticketTypeId` now event-scoped) + added `attendanceMode`/`qrCodeMinted` to the MCP audit. **Still deferred (review-flagged):** mode change does NOT recompute price/amount-owed (`virtualPrice` vs in-person — documented in the toggle + MCP description); the inline-Select TOCTOU (detail-sheet quick-actions don't send `expectedUpdatedAt`, so two concurrent seat-moving edits can double-release) is pre-existing + overlaps the P1.1 soldCount-reconciliation pass. |
| **Quick-Add dialog picker** | The fast add-registration *dialog* has no mode picker (consistent with its existing pricingTier/sponsor gap — the full-page form is the surface). |
| **Check-in UI for virtual** | Scanner already can't match a virtual reg (no qrCode), but the registrations-list "Check In" action should be hidden/disabled for virtual, and the check-in/attendance-rate KPIs should be computed over in-person only so on-site numbers aren't diluted. |
| **Dashboard in-person/virtual split** | Add an in-person vs virtual headcount tile (and "expected at venue" = in-person count). The `@@index([eventId, attendanceMode])` is already in place for the groupBy. |
| **Registrant self-service portal mode display** | `/my-registration` should show the attendee's mode (and any change is admin-only). |
| **Tier-windowed virtual pricing** | v1 virtual price is **flat** per ticket type (pricing tiers apply to in-person only). If virtual needs Early-Bird-style time-windowed pricing, that's a `PricingTier.virtualPrice` extension — scope separately. |
| **Virtual attendance certificates** | An *attendance* certificate for a virtual attendee should gate on **Zoom attendance** (the webinar attendance sync), not desk check-in — the cert eligibility assumption changes for virtual. |

### Webinar waiting room follow-ups (deferred from the June 23, 2026 code review)

The webinar **waiting room** shipped (June 23): producer-gated "Open the room"
admission, a branded lobby with a YouTube/Vimeo holding video + countdown,
per-event viewing mode (Zoom embed vs custom HLS stream), real-time presence
tracking (`WebinarPresence` + heartbeat + "Live now" console card + a "Joined"
registrations badge), and 5k-ready HLS-via-CDN wiring. A two-agent adversarial
review followed; the live/high findings were fixed in-band (commits `ebf766b`,
`9cdac92`, `517e1d4` — presence upsert race, LivePlayer auto-recovery, close/
re-open admit, hls-misconfig fallback, lobby-status micro-cache, MediaMTX probe
cache, admit signature re-mint, overrun cutoff). These remain deferred:

| Item | Note |
|---|---|
| ~~**Never-opened-room warning (#6)**~~ ✅ **SHIPPED July 27, 2026** | The LobbyCard shows a red **"The scheduled start has passed — the room is still closed"** alert (30s tick, hides once opened/closed or 30 min past the scheduled end) with the live **"N attendees are waiting in the lobby"** count via the presence poll; the public lobby's countdown label flips from "Starting any moment" to "Running a little late — you'll be admitted as soon as the host starts" 10 min past T-0. The manual-open model itself is unchanged (owner decision). |
| ~~**Operator visibility (#10)**~~ ✅ **SHIPPED July 27, 2026** | The webinar GET now returns `event.status`; on DRAFT events the LobbyCard shows an amber "DRAFT auto-opens the room for testing — published events wait for your click" note, and the open/close description states the room never opens automatically at the scheduled time. |
| ~~**Save-time hls/stream validation (#5 follow-up)**~~ ✅ **SHIPPED July 27, 2026** | Enforced at BOTH doors: the webinar settings PUT rejects **switching** viewingMode to `hls` unless the anchor's ZoomMeeting has `liveStreamEnabled` + `streamKey` (400 `HLS_STREAM_NOT_CONFIGURED`; an already-hls event saving its lobby message is not retro-blocked), and the room-open POST is the final gate — it refuses to open an hls room with no configured stream (closing is always allowed). 9 tests in `__tests__/api/webinar-hls-validation.test.ts`. |
| ~~**`lobby-status` eventType short-circuit (LOW)**~~ ✅ **SHIPPED July 27, 2026** | `computeLobbyBody` 404s any session whose event is not `eventType === "WEBINAR"`. |
| ~~**Stale `session.status` badge (LOW, cosmetic)**~~ ✅ **SHIPPED July 27, 2026** | For webinar events with lobby data loaded, the public page's Live/Ended badge derives from the FRESH `lobby.roomOpen` poll instead of the load-time `session.status` snapshot; "Ended" no longer shows while the producer keeps the room open past the scheduled end. |
| ~~**`LivePlayer` `onStreamStatusChange` ref (LOW)**~~ ✅ `d1999d9` | SHIPPED June 26 — the callback is read from a latest-value ref and dropped from the init-effect deps, so a non-memoized handler can no longer re-create the HLS player + 10s poll. |
| **Shared rate limiter (LOW, pre-existing)** | The in-memory `checkRateLimit` store resets on every blue-green deploy and is per-container — at 5k that briefly drops rate protection mid-deploy. Real fix is the long-deferred Redis-backed limiter; for now: don't deploy during a live 5k webinar. |

**Operational prerequisites (operator-run, not code):**
- **Phase 0 — Zoom embed Join:** flip the org's Zoom **Active SDK Mode dev → Production** and add `events.meetingmindsgroup.com` to the **prod** Meeting-SDK app's Marketplace **Embed allowlist** (the embed code/deps are verified sound; this is the one config gap behind the earlier Join error). Required only for the **Zoom-embed** viewing mode.
- **Verify the box's nginx `/stream/`** matches the now-committed `deploy/nginx.conf` block before any HLS-mode webinar (the live nginx is Certbot-managed and has diverged — the box is source of truth).
- **CloudFront + Singapore DR origin failover** before a real **5k streamed** event — exact steps in `docs/LIVE_STREAMING.md §13`. The app is CDN-ready (`HLS_CDN_BASE` unset = direct origin, fine for dev/small events).

### registration-detail-sheet.tsx — staged refactor remainder (trigger-driven, May 20, 2026)

Steps A–E of the staged refactor shipped (commits `8ad760b`, `25b3299`,
`9cdf002`, `5e3d486`, `64dc640`). The sheet went from 2,174 lines to
~2,063 (~−110 net), gained 22 new unit tests (`registration-edit-mapping`
+ `api-fetch`), and we squashed one latent prop-revert race + the React
19 setState-during-render warning along the way. Three remaining steps
were graded "quality investment, not bug fix" and are deferred until a
trigger fires:

| Step | What it does | Cost | Risk | Trigger that justifies doing it |
|---|---|---|---|---|
| **F — functional updates + `setField(name, value)` helper** | Replaces ~94 `setEditData({ ...editData, x: v })` spreads with `setField('x', v)` + a functional updater. Removes the theoretical stale-closure bug surface and saves one render per keystroke. | ~1 hr | ⚠️ medium — 94 mechanical changes, typo risk in the field-name string. | (a) profiling shows real input lag, or (b) you're about to start step H (RHF), in which case skip F entirely — RHF obsoletes it. |
| **G — split into sub-components** | Extract `<AttendeeInfoSection>`, `<BillingDetailsSection>`, `<ChargeToControl>`, `<SponsorPicker>`, `<PaymentSummaryCard>`, `<ActivityTab>`. Sheet collapses to ~500 lines + 5 children of 150–300 each. **Biggest maintainability win** of all remaining steps. | half a day | ⚠️ medium — many prop-drilling touch points; each child needs the right state + callbacks. | (a) the file passes ~3k lines, or (b) the next feature you add to this sheet would touch >2 sections and feels painful to navigate. |
| **H — react-hook-form + Zod migration** | The big one. Replaces the giant `editData` state + `onChange` spreads + `saveEdits` payload assembly with RHF. Per-field re-renders, dirty/error tracking free, validation hooks into the route's existing Zod schema. | 1 day | 🔴 highest — touches every input + the populate + the save path + the Cancel/dirty-state UI. | (a) a feature needs per-field control (autosave-on-blur, async field validation, optimistic updates), or (b) React/Next upgrade flags the form's controlled-input pattern as a build error. Do **after** G (the surface area shrinks; the migration becomes per-section instead of all-at-once). |

**Recommended sequence when a trigger fires**: G first (it's the prerequisite
for a clean H), then H if needed, then F is moot. Skipping straight to H
without G is possible but doubles the diff size of the single PR.

### Registration & finance UX follow-ups (deferred July 7, 2026)

Consciously deferred out of the July 7 "no-auto-save" refactor (commit `334d57a`)
and the adjacent finance-UX / registration work. None blocking; each is
independently shippable.

| Item | What it does | Cost | Trigger / notes |
|---|---|---|---|
| ~~**M2 — reset staged tier pick on Edit**~~ | **STALE (verified July 16)** — the tier picker no longer has a separate staged `pendingTierId`/Apply; it moved INTO the edit form (`editData.pricingTierId`, staged + committed by Save like every other field, with the `tierSelectionRequired` guard). The orphaned comment describing the old state was removed (`8757020d`). | — | Closed. |
| ~~**"Requires Approval" on the ticket-type form**~~ ✅ **SHIPPED July 16 (`8757020d`)** | "Requires approval" checkbox on the registration-TYPE add/edit dialog (create + update routes accept + persist it); a tier's own approval setting still overrides when a tier is picked. | — | Shipped. |
| **Quote/invoice PDFs — show `VAT (0%)` line** | The on-screen Payment Summary now **always** renders the tax line (`VAT (0%) 0.00` at 0%); the quote/invoice **PDFs** still omit it at 0%. Product call: match the screen (always show the line) or keep omitting a $0 tax row on print. | ~20 min | Only if the screen/PDF mismatch bothers finance. [quote-pdf.ts](../src/lib/quote-pdf.ts) / [invoice-pdf.ts](../src/lib/invoice-pdf.ts) `drawTotals`. |
| **Re-tier L1 — regenerate invoice/quote on re-tier** | Giving an unpaid reg a courtesy tier (Apply) re-stamps `originalPrice` and the live financials update everywhere, but any **already-generated** quote/invoice PDF isn't re-rendered. | ~30 min | When an admin re-tiers a reg that already had a quote/invoice issued. |
| ~~**Re-tier L2 — reject simultaneous type + tier change**~~ | **STALE (verified July 16)** — `resolveRepricing` (the shared re-tier resolver) explicitly VALIDATES a provided tier against the NEW type when both change, and the detail sheet's `tierSelectionRequired` guard makes the combined change the required flow for tier-priced types. Not ambiguous anymore; a guard would break the supported path. | — | Closed. |
| **Resident "official letter" — capture the file** | The public register form shows a Resident/Trainee "upload an official letter" **notice** (text-only, shipped July 7). Actually capturing + storing the file (additive `Attendee` column + upload UI + dashboard display) was deferred per the organizer's "text only" choice. | ~half day | If the organizer later wants the letter collected in-system rather than emailed/brought out-of-band. |

### Worker DB pool pressure: staggered, now a watch item (August 12, 2026)

Two database events on 12 August, **zero in the preceding four weeks** of
SystemLog history:

```
06:30:15  DB connection pool timeout   P2024, crm-reminders lease claim (ours)
06:45:50  DB connectivity timeout      code 110, Supabase side
```

Both were handled: the first is classified retryable so the tick skipped and
ran five minutes later, the second fired the one-summarized-alert-per-outage
email by design. Nothing was lost.

**Fixed:** the cadence convergence behind the first one. Nine sub-hourly
pollers were all bare step expressions, so eight jobs ticked on the same second
against a pool of ten. Phases staggered, peak now 4
(`7669bae2`), pinned by `__tests__/lib/worker-cadence-stagger.test.ts`.

**Watch, do not act yet (n=2):** whether the pair recurs. The plausible single
story is a slow database first, both symptoms after: queries hold connections
longer, the pool empties at the convergence, and a connection attempt times out
soon after. If it recurs after the stagger, that story is wrong and the next
levers are the pool size (`connection_limit=10`, `pool_timeout=15`; prod uses
~24 of `max_connections=90`, so there is headroom) and Supabase-side latency.
**Size the pool, keep the timeout modest**: a long timeout hides
under-provisioning behind slow hangs.

Useful query:

```sql
SELECT date_trunc('day',timestamp)::date, count(*) FROM "SystemLog"
 WHERE message LIKE '%DB connection%' GROUP BY 1 ORDER BY 1 DESC;
```

**Also settled this day, and recorded elsewhere rather than here:** production
was authenticating to AWS as an IAM user holding `AdministratorAccess`, via a
long-lived key in the box `.env` that overrode the instance role. The
`ses:env-credentials-in-use` warn line is what surfaced it. Full sequence and
the ordering trap (three documented IAM permissions had never actually been
attached, and were working only because the admin key covered them) are in
`docs/runbook-ses.md` §"Retiring an env credential" and `docs/INFRA_OPS.md` §1.

### Privileged maintenance lane review: live fix + all HIGHs SHIPPED; guard rails deferred (August 11, 2026)

Three-lens adversarial review of the multi-tenancy item 5 commits (`2b74dee4`,
`f763016c`, `fdf54c3c`): **0 BLOCKER / 4 HIGH / ~10 MED / ~8 LOW**. The live
finding and all four HIGHs shipped in `86e6da6e`. Owner-selected scope; the
rest is here.

**The meta-lesson, worth carrying:** two of the four HIGHs were surfaces I
missed because I enumerated the worker jobs by name rather than transitively
from `worker/jobs/*.ts`. Both misses were sibling modules inside jobs whose
main module I did find. That is the same "did anything actually call it?"
question that produced the optimistic-lock and `orgCtx` ternary findings on
Aug 10. **When rebuilding a surface list, walk the import graph, not the
directory listing.**

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| **M-B** | MED | **A revert of any `dbOperator.` back to `db.` passes everything.** The allowlist gate is one-directional: it fails on an *unlisted* file that imports the lane, but never checks an *allowlisted* file still uses it. Two modules now have distinct-fake tests that catch it; the other nine do not. **Fix:** add a reverse check so each `OPERATOR_LANE_ALLOWLIST` entry must still contain `dbOperator`, which forces a revert to be a deliberate two-file edit. | Deferred. |
| **M-C** | MED | **Nothing asserts at boot that the lane is genuinely privileged.** If `RLS_SET_LOCAL=1` but `DATABASE_URL_OPERATOR` is unset or equal to `DATABASE_URL`, `dbOperator` IS `db`, so it carries `tenant-set-local` and every wired scan runs in whatever lane it happens to be in (usually none, so zero rows). The instance boots green and nothing errors. **Fix:** mirror the existing `rls-assert` tripwire: under `RLS_SET_LOCAL=1`, refuse to boot unless the operator URL is set and distinct, and assert `row_security_active()` is FALSE for `dbOperator`. | Deferred. |
| **M-D** | MED | `getInfraSnapshot`'s `scope` defaults to `{ kind: "platform" }`. A fail-OPEN default in the one function choosing between the privileged lane and a tenant filter. Both callers pass explicitly today. **Fix:** make it required. | Deferred. |
| **M-E** | MED | **The two webinar sync functions read before entering the lane.** `webinar-recording-sync.ts:47` and `webinar-attendance.ts:139` do `db.zoomMeeting.findUnique` *before* their `runWithTenant`. ZoomMeeting is policied, so on the platform that read fail-closes and both jobs become permanent no-ops. Wiring the worker's candidate scan moved the death one statement later without curing it, and the comments I added to those workers claim otherwise. **Fix:** select the event org in the candidate scan and pass it down, or run the resolving lookup on `dbOperator`. | Deferred. |
| **M-G** | MED | The gate never scans `prisma/`, `tests/`, `e2e/`. `prisma/seed-*.ts` is on the platform-bootstrap path and `tests/tenancy/` connects to a real Postgres. **Fix:** add the roots; `tests/tenancy/` probably wants an explicit allowlist entry rather than exclusion by omission. | Deferred. |
| **M-H** | MED | The gate greps the identifier `dbOperator`, so a hand-built `new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_OPERATOR })` gets the same owner connection and passes CI. **Fix:** add the env var name to the same allowlisted-import check. | Deferred. |
| **M-I** | MED | Nothing pins that a scope-aware counter carries the org filter. Omitting it compiles, passes the route test (which asserts the argument, not the queries), and on master returns identical numbers. **Fix:** a test driving the three fetchers with an org scope against a mock client, asserting every captured `where` is scoped. | Deferred. |
| **M-F** | MED | `tenant:no-org-lane` fires on a routine path. `speakers/route.ts` is org-null by design for a linked SUBMITTER/REGISTRANT reader, so every submitter page view now writes a warn row that persists 30 days. **Fix:** an `{ expected: true }` opt-out that downgrades to debug where org-null is the designed case. | Deferred. |
| **M-2** | MED | The gate is an allowlist of swept files, not a detector of unswept ones. A scan found **20** `route.ts` files touching a policied model with neither `runWithTenant` nor `dbOperator`, several outside the documented identity deferrals (`events/[eventId]/tags`, `speaker-agreement-template`, `registration-types`, the main public event API). Pre-existing, but it is why "every cross-tenant surface is wired" cannot be verified from CI. | Deferred. |
| **L** | LOW | Doc arithmetic: PLATFORM_DECISIONS §4 says "45" where 33 converted + 15 untouched = **48**, and "Six models" lists eight. The stale `help-chat-queries:forbidden` log string (now `platform-operator:denied`) breaks saved `/logs` searches. Gate failure text still says "runWithTenant(". `aws-ops` cache Map has no eviction. `auto-issue`'s per-event org resolution uses a falsy check. `tenant-context.ts`'s docblock still claims only Contacts is swept. | Deferred. |

### Contacts review — H1 + H2 + H4 + M3 SHIPPED; H3 + rest deferred (July 13–14, 2026)

Full report: [docs/CODE_REVIEW_CONTACTS.html](docs/CODE_REVIEW_CONTACTS.html)
(**0 BLOCKER / 4 HIGH / 12 MED / 7 LOW**). Recorded first as a document-only round
(stabilization-first posture — see [docs/CRM_MODULE_PLAN.md](CRM_MODULE_PLAN.md)); the owner then
un-deferred the two live-impact HIGHs, **shipped July 14 in `a0744ef`**. 3 of 4 review angles
completed (RBAC/PII · concurrency/sync-integrity · drift/logging); the lifecycle angle died on an
infra error and was not re-run.

**Foundations verified clean:** cross-tenant IDOR (every lookup binds `organizationId`), MCP org
binding (injected from the API key), the May-18 write-guard fix, CSV formula-injection escaping, the
email-change P2002→409 race handling.

**Still open:** **H3** (mirror rename/merge/delete propagation — the riskiest, it touches the
external EU Supabase target; **plan written below**) and the duplicate-contact backfill H2 doesn't
perform. The enrich-only-sync bug class (H4 + M3) is now **closed on every single-write and bulk
path** — but note the same trap remains latent anywhere a `syncToContact` payload is hand-built:
a wrong-but-well-formed payload fails **silently and successfully**, so always test the *effect*.

| # | Sev | Finding | Status / note |
|---|---|---|---|
| ~~**H1**~~ | HIGH | **Read routes had no role gate** — `GET /api/contacts`, `/export`, `/tags`, detail authorized on `getOrgContext` alone (`denyReviewer` guards only writes), and ONSITE / internal-domain REGISTRANT are org-bound ⇒ either could export the entire org CRM (email, phone, bio, private `notes`), un-audited + un-rate-limited. Same class as check-in H7/H8. | ✅ **SHIPPED `a0744ef`.** Owner decision: **staff + MEMBER may read; ONSITE / REGISTRANT / REVIEWER / SUBMITTER may not.** New [src/lib/contact-visibility.ts](../src/lib/contact-visibility.ts) (`canViewContacts` + `denyContactAccess`, fails closed, logs its own refusal) — deliberately its own predicate (denyReviewer blocks MEMBER, FINANCE_ROLES includes ONSITE, BARCODE_ROLES is the inverse). Export also writes an `EXPORT` audit row + 10/hr/org limit. +51 tests. |
| ~~**H2**~~ | HIGH | **REST contact create never lowercased the email** while the other 5 writers do and the unique index is case-sensitive ⇒ **two contacts for one person**, one of which the central sync silently never mirrors. | ✅ **SHIPPED `a0744ef`.** Trim+lowercase via `z.preprocess` (before validation, so a pasted trailing space is accepted not 400'd); P2002 race → 409 instead of a 500 echoing the raw Prisma message. **⚠ No backfill run — existing duplicate pairs remain (see below).** |
| **NEW** | MED | **Case-variant duplicate-contact backfill** — H2 stops *new* duplicates but does not merge the pairs already minted. Needs a one-time script: find contacts differing only by email case within an org, merge (union tags + `eventIds`, enrich scalars), delete the loser. Dry-run default, `--write`, audited — same shape as `backfill-faculty-registration-type.ts`. **Check prod for existing pairs before adding any DB-level `citext`/functional-unique-index constraint** (it would fail the migration). | Deferred. |
| ~~**H4**~~ | HIGH | **MCP `update_speaker` synced name+email only** while the REST PUT synced ~13 fields ⇒ agent/n8n speaker edits never reached the Contact store (and, being enrich-only, the payload was a **silent no-op**). | ✅ **SHIPPED `5849962`.** Fixed by **extraction, not a patched payload**: new `speaker-service.updateSpeaker()` (cross-caller #6) owns the locked write + tag mirror + decline cascade + FULL contact sync + audit + stats; REST and MCP are thin delegations. Extra drift fixed in-flight: MCP audit now carries full before/after snapshots (was status-only), the write binds `{id, eventId}`, stats refresh the speaker's own event (was `ctx.eventId`), `photo` is coerced not blind-cast. +20 tests; all 2666 pre-existing tests pass unchanged through the delegation. No schema change → no pkg bump. |
| **H3** | HIGH | **The EU central mirror never learns about a rename / merge / delete** — it is email-keyed and POST-upsert-only. Fixing a typo'd email leaves the old address in `contacts_centralv1` **forever**, looking like a current, EA-maintained person (that table feeds `mailchimp_*`). The nightly reconcile only upserts, so it cannot heal it. | **Implementation plan below** (§"H3 — mirror retraction"). Owner decision (July 14): **never hard-delete — always `ea_synced = false`**; a row carrying `mailchimp_*` / `evenstair_customerid` belongs to another source and is no longer EA-SYS's concern. |
| M1 | MED | `syncToContact` is check-then-act on a unique index; the P2002 loser lands in a swallowed catch → an `eventId` **and all enrich data** are permanently lost, and the reconcile can't heal it (it recomputes *from* the corrupted `Contact.eventIds`). | Retry-once on P2002 + atomic array append. |
| M2 | MED | **Audit coverage is 2 of 9 mutation paths** — `DELETE` writes **no audit row** (destructive + unrecoverable); bulk-tags none (its registrations/speakers twins *are* audited); create/import/PUT none (but MCP `update_contact` *does* — inconsistent). | Start with DELETE + bulk-tags. |
| ~~M3~~ | MED | MCP `create_registrations_bulk` synced name+email only while the Attendee row got the full set ⇒ a 100-row agent import produced 100 **husk** CRM rows (and husks in the EU mirror, which enriches from Contact). H4's class; it survived that fix because bulk paths are deliberately NOT service-backed. | ✅ **SHIPPED `ba69eab`.** Fixed the drift **mechanism**: the row's optional fields were hand-rebuilt in **three** places (Attendee row, confirmation email, contact sync) — now one parsed `attendeeFields` object feeds all three, and the Prisma enum cast stays on the Prisma call instead of leaking `as never` into the shared payload. +3 tests, **verified to fail against the pre-fix code**; one pins Attendee-vs-Contact field equality so they can't silently drift again. |
| M4 | MED | **Tag normalization drift** — MCP `create_contact` and the CSV import skip `normalizeTag`; both tag filters are exact-match → agent-created `committee` is invisible to a `Committee` filter (the n8n/Webflow pain, at its source). | |
| M5 | MED | Two "import contacts" features with **opposite semantics**: CSV = `createMany({skipDuplicates})` (existing rows untouched — a re-import to enrich does nothing), EventsAir = enrich-upsert. Skips are never itemized, only counted. | |
| M6 | MED | Neither `import-contacts` → event path appends the event to `Contact.eventIds` → that person's attendance **never appears** in the mirror's `events_attended`. (The registrations one also writes no audit row.) | |
| M7 | MED | REST ⇄ MCP `update_contact` field drift: `role`/`registrationType`/`memberId`/… REST-only; `state`/`zipCode` **MCP-only (uneditable from the dashboard at all)**; `notes` capped **2000 (REST) vs 10000 (MCP)** → an agent-written 3k note makes every later dashboard save 400. | |
| M8 | MED | **13 post-auth 4xx paths log nothing** (409 duplicate, 403 protected, 4× 404, `EMAIL_IMMUTABLE`, `NO_CHANGE`, `CONTACT_EMAIL_TAKEN`, the P2002 race, bulk-tags 404, import 400). | The contacts instance of the known silent-rejection cluster. |
| M9 | MED | `bulk-tags` has **no rate limit and no cap** on `contactIds` (every sibling write is limited) — unbounded `$transaction`, and un-audited (M2), so abuse is invisible. | |
| ~~M10~~ | MED | **SSRF**: `downloadExternalPhoto` ([storage.ts:214](../src/lib/storage.ts)) `fetch`es an EventsAir-supplied URL with **no scheme/host allowlist** (reachable from the contacts EventsAir import) → metadata-service / internal-network probing. | ✅ **Verified FIXED (July 16, 2026 review round 2)** — it now routes through `safeFetchImage` ([safe-fetch.ts](../src/lib/safe-fetch.ts)): private/reserved-IP BlockList incl. IMDS, cloud-metadata hostname blocklist, scheme + embedded-credential rejection, per-redirect re-validation, 500KB cap, SVG rejected (stored XSS). Residual LOW: the `.supabase.co` *substring* fast-path in [storage.ts:235](../src/lib/storage.ts) should be a hostname parse (see round-2 table). |
| M11 | MED | The central-sync error path can log **attendee emails** into SystemLog/CloudWatch — they're inline in the PostgREST query URL, and Node `fetch` errors embed the URL. (The service key is *not* leaked — header-only.) | |
| M12 | MED | Both central-sync jobs are exposed to the **P3 pooler advisory-lock stall**: a lock stranded on one pooled backend makes every later tick skip at **debug** level with no `JobRun` row → the mirror silently stops. If the reconcile's lock wedges too, the safety net for every LOW here stops as well. | Durable fix = point the worker at `DIRECT_URL`. Interim = log the skip at `info` / use `pg_advisory_xact_lock`. |
| L1 | LOW | Central-sync summary logs at `info` even when `failed > 0` (per-chunk failures *do* log at error). |
| L2 | LOW | **ROADMAP drift:** the M9 note (line ~757) says the speakers CSV import lacks contact-sync — **it doesn't**; the real gap is narrower (omits `role`/`state`/`zipCode`/`photo`/`additionalEmail`). |
| ~~L3~~ | ~~LOW~~ | ~~Worker-job + backfill-script comments describe an `ea_upsert_contacts` RPC that **deliberately does not exist** (all merge logic is client-side); the job comment also states the wrong lookback (30 vs 45 min).~~ **✅ SHIPPED Aug 18, 2026** — all four references corrected (`worker/jobs/contacts-central-sync.ts`, `scripts/backfill-contacts-central.ts`, and two inside `src/lib/contacts-central-sync.ts` itself, incl. the 30→45 lookback). |
| L4 | LOW | `buildCentralRows` runs `db.registration.findMany` with **no `where`** — loads every registration in the DB on every tick, even a 2-contact incremental. |
| L5 | LOW | CSV import's `created`/`skipped` counts derive from two racing `count()` queries (`createMany` returns `{count}`). |
| L6 | LOW | `PROTECTED_EMAILS = ["krishna@meetingmindsdubai.com"]` hardcoded as policy inside a route handler (untestable, multi-tenant footgun; its 403 is also unlogged per M8). |
| L7 | LOW | `bulk-tags` reads tags **outside** its transaction → concurrent tag ops lose updates (tags drive email cohorts). |

**Flagged for the owner (not bugs today):** the **central sync is org-blind by design** — `buildCentralRows` has no `organizationId` filter and its registration join has no `where` at all, so a second org would silently mix contacts + registration types into one email-keyed EU table. **Hard blocker for white-label** → belongs in [MULTI_TENANCY_IMPACT.md](MULTI_TENANCY_IMPACT.md). Also: `CONTACTS_CENTRAL_URL` has no scheme/host assertion (an operator typo would POST the service key + all PII to the wrong host).

---

#### H3 — mirror retraction (rename / merge / delete): implementation plan

**Status: BACKLOG.** Not started. Owner decisions locked July 14, 2026 (below). Estimated ~1 focused day (schema + lib + worker + tests), plus one column added in the target project.

**The problem in one line:** `buildCentralRows()` reads contacts that *currently exist* and the only HTTP verb in [contacts-central-sync.ts](../src/lib/contacts-central-sync.ts) is `POST` — so when an email stops being current (renamed / merged away / deleted) it simply stops appearing in the payload, and **nothing ever tells the target**. The old row keeps its full profile, keeps `ea_synced = true`, and keeps feeding `mailchimp_*`. The nightly reconcile can't heal it (it is also upsert-only).

**Why the obvious fix is wrong.** "Diff the target against the source and delete what's missing" would be *dangerous*: `contacts_centralv1` is **shared with other sources** (it carries `evenstair_customerid` + `mailchimp_*`), and the design of record is *never remove another source's entries*. A prune would delete people EA-SYS never knew about. The fix cannot be "delete what's absent" — it must be "**retract our claim on a specific email**", which means we must *record* which emails we retracted, because that information is destroyed at the moment of the change.

**Owner decisions (July 14, 2026):**
1. **Never hard-delete a mirror row.** Retraction = `ea_synced = false`, always.
2. A row carrying **`mailchimp_*` or `evenstair_customerid`** belongs to another source — once we retract, **it is no longer EA-SYS's concern**. We do not clean it, delete it, or null its columns.
3. Consequence to communicate downstream: **`ea_synced = false` means "EA-SYS no longer vouches for this address — do not treat it as a current EA person."** Consumers must filter on it.

**Design: tombstones + a worker pass** (mirrors the rest of the worker tier — durable, ordered, idempotent, retry-safe).

**1. Schema (additive, blue-green safe).** New table:
```prisma
model ContactMirrorTombstone {
  id           String   @id @default(cuid())
  email        String                       // the OLD email — what we retract in the mirror
  reason       ContactTombstoneReason       // RENAMED | MERGED | DELETED
  newEmail     String?                      // set for RENAMED/MERGED — the surviving identity
  createdAt    DateTime @default(now())
  processedAt  DateTime?                    // null = pending; set when the target ACKs
  attempts     Int      @default(0)
  lastError    String?
  @@index([processedAt, createdAt])         // the worker's queue scan
}
enum ContactTombstoneReason { RENAMED MERGED DELETED }
```
Rows are kept after processing (audit trail of what we retracted + when).

**2. Write the tombstone at every point the identity dies** — all three inside the SAME transaction as the mutation, so a crash can't lose the retraction:
- `repointOrgContactEmail()` ([email-change.ts](../src/lib/email-change.ts)) — the `"updated"` branch → `RENAMED` (old → new); the `"merged"` branch (it `delete`s the loser) → `MERGED`.
- `DELETE /api/contacts/[contactId]` → `DELETED`.
- ⚠️ **Do not forget the cascade paths.** Audit whether any Contact rows are removed by Prisma cascade or a bulk delete; a DB-level cascade fires no application code (the accommodation H4 lesson) and would leave no tombstone.

**3. Target project — one additive column** (mirrors how `ea_synced` was added):
```sql
alter table public.contacts_centralv1 add column if not exists ea_merged_into text;
```
Optional but recommended: it lets a downstream consumer follow a rename instead of just seeing a dead row.

**4. New lib function** in `contacts-central-sync.ts` (keep it in the same module — it shares the base URL / service key / chunking):
```ts
export async function retractCentralRows(tombstones: Tombstone[]): Promise<{ patched: number; failed: number }>
```
Per tombstone: `PATCH {base}/rest/v1/{table}?email=eq.{email}` with body `{ ea_synced: false, ...(newEmail && { ea_merged_into: newEmail }) }`.
- **Only ever writes those two columns** — everything else (incl. `mailchimp_*`, `evenstair_customerid`) is preserved by omission, exactly like the existing upsert.
- A **404 / zero-rows-matched is a SUCCESS**, not a failure (the row may never have synced) — mark processed.
- Idempotent: re-PATCHing an already-retracted row is a no-op.
- **Ordering matters:** a RENAME must retract the OLD email *without* clobbering the NEW one. Since the two are different rows (different keys), there's no conflict — but if old and new somehow collapse to the same address (a case-only "rename"), skip the retraction. Guard for it.

**5. Worker.** Fold into the existing `contacts-central-sync` job (same advisory lock, so it can't race the upsert pass) — drain pending tombstones **before** the upsert, so a rename retracts the old row in the same tick that it creates the new one. Cap the batch (e.g. 200/tick), bump `attempts`, record `lastError`, and give up loudly after N attempts (error-level → the SES alert path). ⚠️ Note the **P3 pooler advisory-lock stall (M12)** applies here too: if the lock wedges, retractions stall silently at debug level — worth logging the pending-tombstone backlog count at `warn` when it grows.

**6. Backfill the damage already done.** Existing orphans predate the tombstones and are invisible to them. One-time script (dry-run default, `--write`): pull all `ea_synced = true` rows from the target, diff against the live `Contact` emails, and retract (`ea_synced = false`) any target row whose email **no longer exists in EA-SYS**. This is safe *specifically because* it only touches rows we already claimed (`ea_synced = true`) and only sets our own flag — it never deletes and never touches another source's row. Expect it to catch every rename/merge/delete since the mirror went live.

**7. Tests.** Tombstone written inside the mutation tx (rename / merge / delete); the PATCH body contains ONLY `ea_synced` (+ `ea_merged_into`) — the regression guard against ever widening it into another source's columns; zero-rows-matched → processed, not failed; retry on 5xx; the case-only-rename guard; worker drains retractions before upserts.

**Docs to update on ship:** [CONTACTS_CENTRAL_SYNC.md](CONTACTS_CENTRAL_SYNC.md) (the "Notes / limitations" section currently does NOT mention rename/delete non-propagation — that omission is why this shipped), plus the `ea_synced = false` contract for downstream consumers.

### Contacts review ROUND 2 — 2 HIGH + merge cluster + export gate SHIPPED; rest deferred (July 16, 2026)

A fresh 3-angle pass (security/RBAC · integrity/sync/concurrency · lifecycle/drift/logging) over the
post-`a0744ef` state. **The July 13–14 fixes all verified solid** (read gate on all 4 surfaces,
write boundary on every mutation incl. CRM_USER, email normalization on all 6 writers, IDOR
binding, CSV escaping, CRM module boundary clean — its only Contact touch is a read-only
org-bound `findFirst`). New findings: **0 BLOCKER / 2 HIGH / 8 MED / 12 LOW**.

**SHIPPED July 16:**
- **H-A (HIGH)** — `repointOrgContactEmail`'s "merge" was a bare `delete`: the losing Contact's
  curated `tags` (cert auto-issue + email cohorts + the people sync), private `notes`, and
  `eventIds` (feeds the mirror's `events_attended`) were destroyed with an audit row that read
  "merged". Now a real merge: blank survivor scalars filled from the loser (enrich-only),
  tags/eventIds unioned, notes appended with a provenance marker, then delete.
- **M-B (MED)** — the same delete fired the `CrmContact.contactId` `SetNull` cascade (a DB cascade
  runs no app code — accommodation-H4 class), silently severing the CRM "this rep is also
  registered" link. The merge now re-points `crmContact.updateMany` to the survivor BEFORE deleting.
- **M-C (MED)** — legacy mixed-case Contact rows (pre-H2, no backfill run) made the repoint a
  silent no-op (`"none"`): exact-case lookup missed, the stale row kept the dead email, the next
  sync minted a duplicate. Lookups are now exact-first then case-insensitive fallback (exact wins
  deterministically when a case-variant duplicate pair exists), with a same-row canonicalization
  guard.
- **H-B (HIGH)** — the full-page **Edit Contact** form (`/contacts/[id]/edit`, the list's Pencil
  action) sent `email` unconditionally in every PUT since the April 24 email-immutability change →
  **every save from that page 400'd `EMAIL_IMMUTABLE`** (no field saveable for ~3 months; the
  detail-sheet edit was the unnoticed workaround). Email dropped from the payload + the field is
  read-only with a pointer to the Change Email dialog; the server's `EMAIL_IMMUTABLE` branch now
  warn-logs (it was one of M8's silent 400s — which is why 3 months produced zero log lines).
- **M-A (MED, owner decision July 16)** — CRM_USER could reach `GET /api/contacts/export` (full org
  book CSV incl. private `notes`) via the read grant whose recorded rationale is per-record
  search/link. **Export is now its own, narrower boundary**: `canExportContacts`/`denyContactExport`
  in [contact-visibility.ts](../src/lib/contact-visibility.ts) (staff + MEMBER + API keys; CRM_USER
  reads but does NOT export; fails closed, logs its own refusal).

**NEW — deferred (round 2):**

| # | Sev | Finding |
|---|---|---|
| R2-M1 | MED | **EventsAir import `eventIds` lost-update**: the existing-eventIds map is snapshotted once before a loop that awaits an external photo fetch per row (`maxDuration=60`) — a registration landing mid-import has its just-appended eventId overwritten by the stale-snapshot upsert, and nothing heals it (the mirror recomputes *from* `Contact.eventIds`). Per-row re-read or atomic array-append. ([import-eventsair/route.ts](../src/app/api/contacts/import-eventsair/route.ts)) |
| R2-M2 | MED | **Residual `syncToContact` payload drift ×3** (the H4 class re-drifted, as the July-14 closing note predicted): (a) `speaker-service.updateSpeaker`'s sync omits `state`/`zipCode`/`customSpecialty` (its own create-path sync has them); (b) `create_speakers_bulk`'s sync omits `state`/`zipCode`/`additionalEmail`/`customSpecialty`; (c) the registrant self-edit sync omits `role` (self-editable). Structural fix: one shared field-set builder + an effect-pinning test, not three hand-lists. |
| ~~R2-M3~~ | MED | **Detail sheet "Additional Email" is a dead write** — `additionalEmail` was in neither contacts Zod schema, so Zod stripped it: success toast, value reverts. ✅ **SHIPPED July 16** — added to the update schema (empty string → null clears); +4 PUT tests. |
| ~~R2-M4~~ | MED | **Detail sheet cannot CLEAR half its fields** — some fields sent `\|\| undefined` (= unchanged) while siblings sent `\|\| null` (= clear), in the same function; an emptied phone/org/bio/notes showed a success toast and kept the old value. ✅ **SHIPPED July 16** — every optional field now sends `value \|\| null`; an emptied input clears. |
| R2-M5 | MED | **No frontend error states**: contacts list ignores `isError` → a failed GET renders "No contacts yet" (org CRM looks wiped); detail sheet `return null` on fetch error → row click does nothing. The contacts instance of the known frontend-silent-failure class. |
| R2-L1 | LOW | MCP `create_contact` P2002 race loser → opaque generic error (REST twin maps to 409); also no length caps on any field and a far narrower field set than REST (husk contacts by omission). |
| R2-L2 | LOW | MCP `update_contact` `photo` blind-cast (`as string \| null`) — the speaker-H4 class, fixed in speaker-service, still live here. |
| R2-L3 | LOW | HTTP-MCP `list_contacts` is a hand-mirrored inline copy of the executor (register-mcp-tools.ts) that **returns no contact ids** — clients can't feed `update_contact`. Cross-caller duplication rule hit. |
| R2-L4 | LOW | Contact emails logged on failure paths (contact-sync warn, import-eventsair error, create-route studentIdExpiry warn) — same PII-in-logs class as M11; needs the owner's no-emails-in-logs policy call. |
| R2-L5 | LOW | `.supabase.co` **substring** check in [storage.ts:235](../src/lib/storage.ts) returns a crafted external URL verbatim (`https://evil.example/x?p=.supabase.co/storage/`) → stored as `Contact.photo`, rendered as an `<img>` beacon. Parse hostname + path prefix instead. |
| R2-L6 | LOW | `import-eventsair` has **no rate limit** (CSV sibling: 10/hr/org) — each call is ≤100 contacts × an outbound photo fetch. |
| R2-L7 | LOW | `speakers/import-contacts` dedup compares emails **case-sensitively** against `Speaker.email` (legacy mixed-case rows) → possible duplicate Speaker + duplicate companion registration for one person. |
| R2-L8 | LOW | Export failure **navigates** the browser (`window.location.href`) to raw JSON on 429/403/500 instead of toasting. |
| R2-L9 | LOW | EventsAir **foreground** import toasts success even when every batch failed (the background variant branches correctly); delete-error toasts discard the server's reason (the protected-contact 403 message never reaches the operator). |
| R2-L10 | LOW | Single-contact tag edit is a client-side read-modify-write over possibly-stale React Query cache (concurrent tag writers clobbered) + case-sensitive remove (M4's pain, one more surface). |

Also recorded: `getOrgContext`'s SUPER_ADMIN `x-org-id` header override is a **cross-tenant bypass
primitive** (inert single-org) → noted for [MULTI_TENANCY_IMPACT.md](MULTI_TENANCY_IMPACT.md).
M8's count is now 11 (3 fixed in `a0744ef`, `EMAIL_IMMUTABLE` fixed in round 2).

### Certificates review — deferred findings (July 13, 2026)

Full report: [docs/CODE_REVIEW_CERTIFICATES.html](docs/CODE_REVIEW_CERTIFICATES.html)
(1 BLOCKER / 5 HIGH / 9 MED / 7 LOW). The BLOCKER + all 5 HIGHs + M1–M5
shipped in 4 gated phases (`2c32d21` B1 · `bc06124` H1/H2/H3 · `05f0695`
H4/H5 · `a4b080d` M1–M5); M7/M8/L5 fixed in docs. The items below were
consciously deferred — none blocks live events.

| Sev | Finding | Why deferred / trigger |
|---|---|---|
| MED | **M6 — send-phase crash windows** | `emailedAt` is stamped AFTER the send with no per-item conditional claim (a worker crash between send and stamp re-emails next tick); the thank-you sweep's cover suppression keys on the legacy 1:1 `issuedCertificateId` pointer, which a bundle item can lack (guaranteed duplicate in that branch). Needs the same at-least-once vs at-most-once decision the July-11 comms worker made — bundle with H1's conditional-transition work if picked up. |
| MED | **M9 — no `duplicate_certificate_template` MCP tool** | REST exposes duplicate; MCP doesn't (agent must re-create + re-patch every field). Adding it owes a package bump + client reconnect — fold into the next MCP-changing deploy. |
| MED | **`@@unique([eventId, serial])` durable fix (M1 follow-up)** | The July-13 M1 fix makes a cross-event serial collision *legible* (distinct error) but doesn't prevent it — `serial` is still globally unique with a non-unique `Event.code` prefix. Durable fix = scope the constraint per-event (or fold a unique event discriminator into the prefix). Additive-ish migration; do it when a recurring same-code event actually collides. |
| LOW | **M1 operator-facing 409 unreachable on the live per-person path (review LOW-2)** | The clean `SERIAL_COLLISION` 409 (with the "give this event a distinct code" hint) lives in `issueSingleCertificate`, which has NO live caller — the live per-person Issue path is `issueCertificateBundle` → `findOrIssueCertificate`, which THROWS, so `issue-single/route.ts` catches it into a generic 500. The `apiLogger.error` (`cert-bundle/deliver:serial-collision`) fires on ALL paths so diagnosis works, but the operator sees an opaque 500 not the actionable 409. Fix (fold in with the `@@unique` work): make `findOrIssueCertificate` return an errors-as-value `SERIAL_COLLISION` matching its `FindOrIssueResult` shape instead of throwing, and surface it as a 409 through the bundle/worker/bulk paths. Low value until collisions actually happen (needs two same-code events). |
| LOW | **L1 — legacy render path serial/PDF mismatch** | `renderAndStoreItem`'s P2002 branch reuses the old cert row but uploads a PDF baked with a NEW unrecorded serial. Reachable only for pre-2026-07-09 runs (empty `templateIds`). One more reason to delete the legacy pipeline (already a ROADMAP L). |
| LOW | **L2 — auto-run `failedCount` erased by retry-failed** | A bundle partial-render bumps `failedCount` without an item `errorMessage`, so retry-failed finds zero failed items and resets the counter, hiding the missed template. Cosmetic/analytics; detail survives in `run.errors` JSON + /logs. |
| LOW | **L3 — issue route concurrent-run guard not true mutual exclusion** | findFirst+create in a `$transaction` isn't a serialization point under READ COMMITTED; two simultaneous Issues can both pass. Bounded by per-recipient idempotency downstream. Needs a unique constraint / row lock / advisory lock. |
| LOW | **L4 — serial allocation outside the cert-create tx** | A failed render after allocation burns a serial number (benign gaps). Documented as accepted; chasing gapless sequences couples unrelated failures. Observation only. |
| LOW | **L6 — `revokedAt` has no write path** | Every send path refuses revoked certs, but nothing sets `revokedAt` (no route/tool/script), and the per-template unique index would block a corrected replacement if one were set via SQL (no unrevoke/supersede flow). Half-built guard machinery; pick up when revocation is actually needed. |
| LOW | **L7 — issued cert PDFs world-readable at UUID URLs** | `/uploads/[...path]` serves them unauthenticated with immutable caching. Capability-URL (128-bit UUID) is an accepted trade-off; revisit with signed URLs if certs ever carry sensitive data. |

### Certificates — operator-feedback round, deferred review findings (June 3, 2026)

The June 3 operator-feedback round shipped 4 features (canvas undo,
Y-axis nudge, per-recipient resend, EmailLog "Cert" pill) across
commits `0c56c9a` (implementation) → `1e9801a` (24 unit + 8 e2e cases)
→ `58168b4` (4 HIGHs from the independent review pass: H1 atomic
cross-event binding, H2 path-traversal + SSRF allowlist with
per-rejection structured logs, H3 setState updater purity in undo/redo,
H4 toast wording fidelity). The items below are **MEDIUM/LOW findings
the review surfaced and we consciously deferred** — none blocks the
deploy, each is independently shippable, pick up first whenever an
operator hits a related issue.

| Severity | Item | Risk & recommended direction |
|---|---|---|
| ~~MEDIUM~~ ✅ FIXED | ~~**`abstractTitle` token not HTML-escaped in cert delivery email body**~~ | **DONE** (verified July 13, 2026, M8). The resolver escapes the abstract title under `escapeDynamic` and every HTML-body caller sets `escapeDynamic: true`. Struck. |
| MEDIUM | **Confirm dialog leaks state on mid-mutation Escape / click-outside** | `src/components/certificates/issued-certificates-card.tsx` (~151, 86-94) — operator clicks Resend, dialog opens, SES round-trip starts (~1-2s). Escape or click-outside in those 2s closes the dialog; opening a new resend dialog right after means the in-flight toast from #1 lands while dialog #2 is open. Trigger: operator complaint of "ghost toasts" or visible state inconsistency. Fix: `onInteractOutside` + `onEscapeKeyDown` no-op while `resendMutation.isPending`. ~3 LOC. |
| ~~MEDIUM~~ ✅ `94048f6` | **`handleNudgeY` re-allocates closure ~30×/sec while holding ArrowDown** (SHIPPED June 26 — read `textBoxes` from a latest-value ref in `handleNudgeY` + `pushUndoSnapshot`, dropped it from both deps) | `src/components/certificates/certificate-canvas-editor.tsx` (~355-377) — `useCallback` deps include `textBoxes`. Each nudge mutates it → new closure → new keyDown handler → … On templates with many text boxes on a slow box, measurable allocation churn. Trigger: noticeable input lag during fast-positioning. Fix: read `textBoxes` from a ref inside `handleNudgeY` (already exists for `lastNudgeAtRef`). ~5 LOC. |
| MEDIUM | **`loadPdfBytes` + `escapeHtml` duplicated across worker + route** | `src/lib/certificates/issue-worker.ts` (57-64, 769-781) vs `src/app/api/events/.../resend/route.ts` (similar helpers). Comment in resend route flags it as intentional v1 debt to avoid touching the worker mid-feature. Trigger: next sweep of cert-email code OR any divergence (e.g., new XSS pattern added to one but not the other). Fix: extract `src/lib/certificates/cert-email-helpers.ts`, import from both. |
| MEDIUM | **EmailLogCard "Cert" pill baseline misaligned vs subject text** | `src/components/communications/email-log-card.tsx` (~82, 89-94) — parent is `items-baseline`, pill is `inline-flex items-center`. Pill renders slightly above the subject's typographic baseline on Chrome/Firefox/Safari. Cosmetic only. Fix: `align-self-center` on the pill OR `items-center` on the parent flex. 1 LOC. |
| MEDIUM | **Defensive `recipientEmail` chain doesn't `?.` through Attendee** | `src/app/api/events/.../resend/route.ts` (~251) — `reg?.attendee.email ?? null`. `attendee` is a required FK so won't trigger today, but optional-include semantics in Prisma can return null in edge cases. Trigger: 500 error on resend with stack pointing here. Fix: `reg?.attendee?.email ?? null`. 1 LOC. |
| MEDIUM | **Base64 PDF allocation 2× memory per resend** | resend route + worker — `Buffer.from(arr).toString("base64")` expands ~1.33× in memory. Fine at current 30/hr/user rate; spikes under sustained concurrent resend pressure on small EC2. Trigger: heap growth visible in CloudWatch. Fix: stream SES `RawMessage` attachment (SES v3 SDK supports it). |
| ~~LOW~~ ✅ `47c7fea` | **Dev-only sentinel renders to prod** (SHIPPED June 26 — returns null outside development) | `IssuedCertificatesCard` shows an amber "pass registrationId OR speakerId" panel when both are absent. Comment says "dev-only" but it ships to prod. Trigger: visible. Fix: gate on `process.env.NODE_ENV === "development"` or return null in prod. |
| ~~LOW~~ ✅ `5f0c3f0` | **`recipientLabel` template parity** (SHIPPED June 26 — registration variant now includes title like the speaker variant) | Registration variant doesn't include `title` even when present (`${firstName} ${lastName} <${email}>`); speaker variant does (`[title, firstName, lastName].filter(Boolean).join(" ")`). Cosmetic in the resend confirm dialog. |
| LOW | **`pluralize` helper would dedupe 3 ternaries** | `${count} time${count === 1 ? "" : "s"}` repeated 3× in `issued-certificates-card.tsx`. Style. |
| LOW | **`pushUndoSnapshot` on color-picker focus is unreliable on Chrome** | Native `<input type="color">` doesn't always fire `onFocus` (OS-level picker). A color change may skip the undo step. Known-bad UX of native color inputs; consider Tiptap color or react-colorful if/when this matters. |
| LOW | **`RecipientSnapshot` type inlined rather than imported** | `src/app/api/events/.../resend/route.ts` (~229-234) declares the shape locally; worker has the same shape. Drift risk over time. |
| LOW | **Legacy cert with no `issueRunItem` shows only "Issued X ago"** | `IssuedCertificatesCard` row hides "· sent X ago" when the run item is null. Operator might misread as "never sent". Only affects pre-feature legacy certs (none in prod today). |
| LOW | **Comment phrasing on cross-machine pdfUrl error** | `src/app/api/events/.../resend/route.ts` (~273-275) describes the failure mode imprecisely. Tighten to reference the `STORAGE_PROVIDER=local` pattern explicitly so the next reader doesn't need archaeological context. |

**Review verdict at deploy time**: SAFE TO PROCEED. The independent review agent's full report is preserved in this round's git history (review summary at `58168b4`).

### Abstraction cleanup backlog (June 5, 2026)

Surfaced during a codebase audit triggered by the question "do we need
Snowflake? any abstractions we don't need?". Snowflake: zero
references, not needed. The three items below are real abstractions
that exist today but are either incomplete extractions or premature
optionality. None blocks anything; each is independently shippable
under the "delete dead code" banner.

| Severity | Item | Risk & recommended direction |
|---|---|---|
| MEDIUM | **Email provider switch carrying ~150 LOC of dead code** | [src/lib/email.ts](../src/lib/email.ts) declares an `EmailProvider` interface designed for hot-swapping providers. Today there's only one implementation (`sesProvider`); ~150 lines of fully commented-out Brevo + SendGrid + Postmark providers live in the file with the header comment "kept commented for one release cycle in case we need to revert". `getProvider()` is a one-branch switch returning `sesProvider`. **Trigger**: the cleanup is pure delete with zero behavior change — pick up whenever someone touches email code for any reason. Fix: drop the commented Brevo/SendGrid/Postmark blocks (lines ~114-260), inline `sesProvider` into `sendEmail` or drop the `EmailProvider` indirection (one impl no longer warrants it), delete `getProvider()` + `resolveProviderName()` if it only returns `"ses"`, and drop `@getbrevo/brevo` + `@sendgrid/mail` + `postmark` from `package.json` if still listed. ~150-200 LOC removed, safest cleanup on the list. |
| MEDIUM | **`src/lib/ai/` AiProvider abstraction — incomplete extraction** | [src/lib/ai/](../src/lib/ai/) (3 files, 270 LOC) defines an `AiProvider` interface for "future provider-swap" but the bigger AI consumer ([src/app/api/events/[eventId]/agent/execute/route.ts](../src/app/api/events/%5BeventId%5D/agent/execute/route.ts)) bypasses it and imports `Anthropic` directly. The retrofit was deferred in `docs/HELP_CHATBOT.md` v1.1 and hasn't happened. **Trigger**: next time multi-provider becomes a real requirement (e.g. Ollama fallback for the privacy case the help-chat plan named), commit to the retrofit. Otherwise pick up as cleanup: collapse `getDefaultAiProvider()` + the interface, have help-chat use Anthropic SDK directly like the agent does. Half-extracted abstractions are worse than no abstraction — pick one direction. |
| MEDIUM | **Vercel-deployment vestiges — premature optionality** | The "would I still pick Next.js" reflection flagged "skip Vercel optionality from day 1" as the #1 hindsight call. The Vercel-conditional surface is still in code: [src/lib/logger.ts:7](../src/lib/logger.ts#L7) picks log destination via `isVercel`, [src/app/api/logs/route.ts:12](../src/app/api/logs/route.ts#L12) defaults log source on Vercel, [src/lib/env.ts:62-73](../src/lib/env.ts#L62) issues Vercel-specific warnings, [vercel.json](../vercel.json) is the full Vercel config, [src/lib/storage.ts](../src/lib/storage.ts) `STORAGE_PROVIDER=supabase` branch exists for Vercel's read-only fs. Production deploys EC2 only; the conditionals always evaluate the same way. **Trigger**: paying down the cognitive cost of "should this work on Vercel too?" every time touching env, storage, or logging code. Fix: delete `vercel.json`, hardcode EC2 paths in logger + env (or drop the warnings entirely), keep `local` storage path + delete `uploadSupabase`/`deleteSupabase` and the `PROVIDER` switch. ~5-10 files touched, each diff small. Bigger sweep than the email cleanup but the optionality cost is real. |

**Confirmed-justified abstractions** worth NOT touching (surfaced in the same audit, listed so a future review doesn't re-flag them):
- `src/services/` (5 services × 2 callers each — REST + MCP — exact "two callers → extract" rule)
- `src/lib/agent/tools/` (14 domain files, 7574 LOC — single file would be unmaintainable)
- `src/lib/certificates/email-tokens.ts` vs `email-tokens-resolver.ts` (client-safe vs server-only split)
- `STORAGE_PROVIDER=local|supabase` switch (documented DR-gap closer in `docs/EC2_HARDENING.html`)
- Worker advisory locks + dual-write window (real distributed-systems concern: Singapore DR + Mumbai both up)
- `src/lib/api-errors.ts` `zodErrorResponse()` (~45 callers, removes silent-failure mode)
- `src/lib/api-fetch.ts` `ApiError` (only 1 consumer but `STALE_WRITE` 409 → refetch branching is real value; lift inline only if it stays at 1 consumer for 6 more months)

### Automated security-scanning regime (June 8, 2026)

Drafted in a Claude Code mobile-app planning session over the weekend
as commit `f555808` ("docs: add comprehensive security scanning
strategy"). The commit never pushed (mobile-app sandbox session
ended without `git push`), so the files don't exist in this repo.
The configuration content is preserved verbatim below so it can be
adopted whenever the trigger conditions fire — no need to reconstruct
from scratch.

**Decision: deferred — not overengineering the underlying need, but
the proposed solution is two sizes too big for solo-dev maturity.**
Reasoning captured in the trigger criteria below.

**What was drafted:**
1. `docs/SECURITY_SCANNING.md` (~837 lines, content lost when the
   mobile session ended without push)
2. `.zap/rules.tsv` (62 lines, OWASP ZAP rule severity assignments —
   IGNORE/WARN/FAIL) — preserved below
3. `.snyk` (43 lines, dependency-scan policy file with quarterly-
   review discipline + comment-block enforcing reason/expires/
   approver on every ignore) — preserved below
4. `.github/workflows/zap-scan.yml` (workflow targeting a
   non-existent `staging.meetingmindsgroup.com` after a
   non-existent "Deploy to Staging" workflow) — preserved below
5. `.github/workflows/snyk.yml` (dep-scan + Snyk Code SAST, daily
   schedule + push + PR triggers) — preserved below

**Why deferred:**
- EA-SYS is solo-dev with mid-maturity security posture already (5
  past audit cycles shipped: `b933fda`, `004510c`, `6aed51b`,
  `2cb7af7`, `ff3b7e0`; independent code-review-agent process for
  every non-trivial change; `denyReviewer` + `denyFinance` +
  `buildEventAccessWhere` centralized guards; Stripe webhook HMAC
  verification; Sentry + admin-alert pipelines; org-bound queries
  with cross-tenant IDOR audits already-completed; PDPL-aware data
  residency via Mumbai S3 + Singapore DR).
- ZAP workflow targets a staging environment that doesn't exist
  (per saved feedback `feedback_dev_local_storage_prod_only_uat.md`,
  explicit "prod-only UAT" decision). Building staging just to run
  ZAP is 3-5 days of infra work for a tool that mostly catches what
  React default-escape, Tiptap content-sanitization, and past audits
  already address.
- ZAP workflow's `fail_action: false` directly contradicts the
  `.zap/rules.tsv` FAIL section claim "must block deployment" — one
  or the other has to change before commit.
- ZAP workflow rules.tsv has an internal contradiction: rule 10020
  ignores "X-Frame-Options not set" because "CSP frame-ancestors is
  used instead", but rule 10038 warns "CSP Header Not Set" — those
  two can't both be true.
- Snyk workflow pins `snyk/actions/node@master` (supply-chain risk
  per OWASP CICD-SEC-8 — should pin to SHA or tagged release).
- Snyk workflow emits a JSON report (`--json-file-output`) but never
  uploads it as an artifact — file evaporates at job-end.
- Snyk workflow doesn't emit SARIF, so findings stay siloed in
  Snyk's web UI instead of appearing in the repo's Security tab,
  PR annotations, or alerts feed.
- Snyk Code (their SAST) duplicates ~70% of what the code-review-
  agent process already catches contextually.
- Scanner triage time ≈ feature-development time. Solo dev with a
  feature backlog the size of EA-SYS's = wrong trade-off until
  external pressure forces the shift.

**Trigger to pick up — pick when ANY of these fires:**
1. **Team size > 2** (manual audit doesn't scale; SAST + DAST
   become real value when no one human reviews everything)
2. **Customer asks for SOC 2 / ISO 27001 / HITRUST** (auditors
   want to see scanner reports + suppression policies + cadence
   documentation; ship the whole thing as proof of due diligence)
3. **Regulator inquiry about PDPL / GDPR posture** (same)
4. **Adding ANY new feature that takes user-supplied HTML or
   markdown beyond what Tiptap already covers** (Tiptap is
   sanitized; a new content path may not be — worth a targeted
   ZAP active scan against that endpoint specifically as a
   one-off, NOT a full scanning regime)
5. **Stripe webhook handler refactor or any change touching the
   payment flow that's NOT covered by the existing HMAC + Sentry
   pipeline** (payment flow changes have outsized blast radius;
   worth a one-off Burp/ZAP active scan against that endpoint
   specifically)
6. **The lighter-weight alternative below ever produces noise
   the team can't keep up with** (counterintuitive trigger: if
   `npm audit` + Dependabot + secret scanning ARE catching real
   things and you're triaging them weekly, you've graduated to
   needing the heavier-weight regime)

**The lighter-weight alternative — IF you want SOMETHING shipped
without committing to the full regime (45 min total):**
- Verify Dependabot security updates are enabled (probably already
  on by GitHub default — Settings → Code security)
- Enable GitHub secret scanning + push protection (free for private
  repos; would have caught the `AWS_ACCESS_KEY_ID` in `.env` from
  Friday's CloudWatch test)
- Add `npm audit --audit-level=high` as a one-line CI step in the
  existing `.github/workflows/deploy.yml` (catches the same CVEs
  Snyk's free tier catches)
- Document the existing security posture in
  `docs/SECURITY_POSTURE.md` (auditors/customers ask for this; you
  have a sellable narrative already — past audit cycles, centralized
  guards, signed webhooks, Sentry + admin-alert anomaly detection,
  data residency, ad-hoc code-review-agent process). The narrative
  IS the deliverable. Don't conflate "we don't run automated
  scanners" with "we don't have security" — they're not the same.

**Preserved configuration content (verbatim from the mobile session,
do not re-engineer from scratch when picking up):**

`.zap/rules.tsv`:
````
# OWASP ZAP Rule Configuration for EA-SYS
# Format: RuleID	Action	Description
# Actions: IGNORE (suppress), WARN (report but don't fail), FAIL (block deploy)

# IGNORE — False positives or not applicable to EA-SYS
10096	IGNORE	Timestamp Disclosure - Timestamps in responses are intentional
10027	IGNORE	Information Disclosure - Suspicious Comments
10015	IGNORE	Re-examine Cache-control Directives — RECONSIDER: MEMBER finance routes use Cache-Control: no-store deliberately
10049	IGNORE	Non-Storable Content
10050	IGNORE	Retrieved from Cache
10020	IGNORE	X-Frame-Options Header Not Set — RECONSIDER: contradicts 10038 below
10037	IGNORE	Server Leaks Information via X-Powered-By — RECONSIDER: should fix (next.config.ts poweredByHeader: false)
90033	IGNORE	Loosely Scoped Cookie

# WARN — Monitor but don't block deploys
10038	WARN	CSP Header Not Set — RECONSIDER: contradicts 10020 above
10098	WARN	Cross-Domain Misconfiguration — intentional for /api/mcp/*
40025	WARN	Proxy Disclosure
90022	WARN	Application Error Disclosure
10021	WARN	X-Content-Type-Options Header Missing
10036	WARN	Server Leaks Version Information
40026	WARN	HTTP Parameter Pollution
90034	WARN	Cookie Without SameSite Attribute

# FAIL — Critical issues that should block deployment
40012	FAIL	Cross Site Scripting (Reflected)
40014	FAIL	Cross Site Scripting (Persistent)
40018	FAIL	SQL Injection
40022	FAIL	SQL Injection - PostgreSQL
90019	FAIL	Server Side Include
90020	FAIL	Remote OS Command Injection
40009	FAIL	Server Side Request Forgery — VERIFY: comment claims "safe-fetch" but no such lib exists in EA-SYS
40016	FAIL	Directory Traversal
40017	FAIL	External Redirect
40034	FAIL	.env Information Leak
40040	FAIL	CORS Header — Wildcard origin with credentials
````

`.snyk`:
````yaml
# Snyk Policy File for EA-SYS
# Quarterly review cadence. Every ignore MUST have: reason, expires, approved_by.
version: v1.25.0

ignore: {}
patch: {}

language-settings:
  javascript:
    excludeDevDependencies: true
````

`.github/workflows/zap-scan.yml` (DO NOT commit as-is — has 3
critical issues flagged in the review):
````yaml
# Has critical issues: depends on non-existent "Deploy to Staging"
# workflow; targets non-existent staging.meetingmindsgroup.com;
# fail_action: false contradicts rules.tsv FAIL section.
# Fix architecture before adoption (Option A: scheduled scan against
# prod; Option B: local CI scan with npm run dev; both detailed in
# the review).
name: OWASP ZAP Security Scan
on:
  workflow_run:
    workflows: ["Deploy to Staging"]
    types: [completed]
jobs:
  zap-baseline:
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    steps:
      - uses: actions/checkout@v4
      - uses: zaproxy/action-baseline@v0.12.0
        with:
          target: 'https://staging.meetingmindsgroup.com'
          rules_file_name: '.zap/rules.tsv'
          cmd_options: '-a -j -l WARN'
          fail_action: false
````

`.github/workflows/snyk.yml` (DO NOT commit as-is — pin `@master`
to SHA, add artifact upload, add SARIF):
````yaml
name: Snyk Security Scan
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: '0 8 * * *'
jobs:
  snyk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
      - run: npm ci
      - uses: snyk/actions/node@master   # FIX: pin to SHA
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          args: >-
            --severity-threshold=high
            --fail-on=upgradable
            --json-file-output=snyk-report.json
      # MISSING: artifact upload of snyk-report.json
      # MISSING: SARIF emission + upload to GitHub Security tab
  snyk-code:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: snyk/actions/node@master   # FIX: pin to SHA + add setup-node
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          command: code test
          args: --severity-threshold=high
````

**When picking up the full regime, address the review notes above
BEFORE first commit. Don't ship the configs with the contradictions
intact — that produces noise + erodes trust in the scanner output,
which is the failure mode that kills security regimes in solo-dev
shops.**

### Medium-Term (2–4 Months)

| Feature | Description |
|---|---|
| **Mobile App (PWA)** | Progressive Web App for on-site staff: check-in scanner, badge print, real-time stats — installable on iOS/Android without App Store |
| **Certificate Generation** | Automatic PDF attendance certificates with event branding, downloadable from the registrant portal |
| **Abstract Book / Programme PDF** | Auto-generated event programme PDF (sessions, speakers, abstracts) for download and print |
| **Multi-Event Dashboard** | Cross-event analytics and reporting for portfolio managers |
| **n8n / Zapier Integration** | Webhook triggers on registration, payment, and abstract events for no-code workflow automation |
| **Email Scheduling** | Schedule bulk emails for future send times (reminder emails, pre-event comms) |
| **Duplicate Detection** | Flag and merge duplicate contacts and registrations |

### Long-Term (4+ Months)

| Feature | Description |
|---|---|
| **Multi-Organization Support** | Support multiple independent organizations from a single deployment with isolated data |
| **Custom Registration Fields** | Organizers define custom questions per event (text, dropdown, checkbox) |
| **Networking / Matchmaking** | Attendee profile discovery and meeting scheduling between registered delegates |
| **Sponsor & Exhibition Management** | Manage sponsors, booth assignments, and exhibition floor plans |
| **Live Event Mode** | Real-time session management: live Q&A, polls, session switching, presenter timer |
| **API for Integrations** | Public REST API with API key auth for deep integration with EventsAir, association management systems, and third-party tools |
| **White-Label / Custom Domains** | Custom domain per event (register.myconference.com) with full branding control |

---

## Role & Access Summary

| Role | Access Level | Primary Use Case |
|---|---|---|
| **Super Admin** | Full platform access | Platform management, org setup |
| **Admin** | Full org access | Day-to-day event operations |
| **Organizer** | Assigned events only | Event coordinators and staff |
| **Member** | Read-only dashboard | Stakeholders needing visibility |
| **Reviewer** | Abstracts only | External academic reviewers (cross-org) |
| **Submitter** | Own abstracts only | Speakers submitting papers |
| **Registrant** | Own registration only | Attendees (self-service portal) |

---

## Technical Infrastructure

### Stack
- **Framework:** Next.js 16 (App Router, React 19, TypeScript)
- **Database:** PostgreSQL with Prisma ORM (20+ data models)
- **Authentication:** NextAuth.js v5 with JWT
- **Payments:** Stripe (Checkout, Webhooks, Refunds)
- **Email:** Brevo / SendGrid (switchable via environment variable)
- **AI:** Anthropic Claude API (claude-sonnet-4-6)
- **PDF:** pdfkit + bwip-js (server-side, no external service)
- **Storage:** Local filesystem (EC2) or Supabase Storage

### Infrastructure
- **Production:** AWS EC2 t3.large, Docker Compose
- **Deployment:** GitHub Actions CI/CD with zero-downtime blue-green deploys
- **Monitoring:** Sentry (client + server error tracking, session replay)
- **Logging:** Pino structured logging → `/logs` viewer (file, Docker, or database source)

### Security
- CSRF protection (Origin header validation on all mutations)
- XSS prevention (Zod input validation, content sanitization)
- Path traversal protection on file serving routes
- Role-based API guards on all 75+ endpoints
- bcrypt password hashing
- Rate limiting on public endpoints (registration, checkout, completion form)
- Audit logging for all admin actions
- API key authentication for external integrations

### Scale Benchmarks (Current)
- 75+ REST API endpoints
- 20+ Prisma data models
- 7 user roles with 3-layer enforcement (API, middleware, UI)
- Organization contact store tested to 100,000 contacts
- CSV import supports up to 5,000 rows per file
- Email templates support full WYSIWYG editing with inline CSS for all major email clients

---

## Documentation Index

| Document | Description |
|---|---|
| [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md) | Detailed feature checklist with API endpoints and implementation notes |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture, data flow, and design decisions |
| [HANDOVER.md](HANDOVER.md) | Full handover document for new developers |
| [SUPPORT_AND_MAINTENANCE.md](SUPPORT_AND_MAINTENANCE.md) | Leadership-oriented operational requirements: what's monitored, recurring tasks, vendor risks, decisions needed from management |
| [infra/cloudwatch/README.md](../infra/cloudwatch/README.md) | CloudWatch Logs runbook — agent setup, IAM policy, log groups + retention, optional alarm/SNS pipeline. Logs flowing live since June 8, 2026. |
| [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md) | Production environment audit and configuration |
| [SECURITY_AUDIT_FIXES.md](SECURITY_AUDIT_FIXES.md) | Security improvements and fixes applied |
| [agents.md](agents.md) | AI agent tool documentation |
| [PM2_DEPLOYMENT_GUIDE.md](PM2_DEPLOYMENT_GUIDE.md) | PM2 deployment guide |
| [DOCKER_LOGGING_GUIDE.md](DOCKER_LOGGING_GUIDE.md) | Docker logging setup |
| [VERCEL_COMPATIBILITY.md](VERCEL_COMPATIBILITY.md) | Vercel deployment notes and limitations |

---

*This document is intended for executive review. For technical implementation details, refer to DEVELOPMENT_STATUS.md and ARCHITECTURE.md.*

## RSVP review — deferred (Aug 14, 2026)

Post-ship 3-lens review of `cec1b775`. The 6 findings the commit *introduced*
were fixed in-band (see the CLAUDE.md entry). These 4 were **verified against
`cec1b775^` as carried over from the July 2026 Dinner RSVP build**, so they are
pre-existing behaviour, not regressions — recorded rather than fixed to keep the
remediation commit honest about what it changed.

- **Replace-all destroys un-addressed fresher answers.** The public submit deletes
  responses for ALL currently-open items but re-creates only the ones the payload
  named. A stale desktop tab (loaded before item C existed) that resubmits will
  delete the "yes" the invitee gave to C from their phone ten minutes earlier, and
  the response is `{ ok: true, ignoredItemIds: [] }` so nobody is told. The M3
  stale-form 409 doesn't fire because the payload still addresses ≥1 open item.
  **Not a quick patch**: narrowing the delete to `accepted` changes the July-2026
  "server-authoritative replace-all is the invitee's complete intent" contract,
  which is what kills ghost attendance. Wants a decision, not a diff. The
  alternative is to have the client send the item-id list it rendered and 409 when
  it differs from `openIds` — turning it into a STALE_FORM, which is arguably the
  honest shape.
- **`RsvpResponse.organizationId` is stamped from the host-resolved slug lookup,**
  not from `invite.event.organizationId`. Identical today; diverges only on a host
  with no verified `TenantDomain` row AND a cross-org slug collision, where
  `eventMatchesRequestTenant` passes unconditionally (`!res.orgId`). Under RLS the
  mis-stamped rows would be invisible on their owner's lane. One-line fix
  (`organizationId: invite.event.organizationId`), strictly more correct in every
  case; deferred only because it is not this commit's regression.
- **The form tells an invitee a recorded answer "was not recorded".** The client
  submits every loaded item including already-closed ones, so the server returns
  them in `ignoredItemIds` and the toast says "RSVP for Night 1 closed before you
  submitted and was not recorded. Please contact the organizer." It *was* recorded,
  last week. Generates support traffic. Fix: only warn for items that were NOT
  already `closed` at load time (the client knows that flag).
- **No rate limit on 3 writes + the PII-bearing roster GET.** `items/[itemId]` PUT
  and DELETE, `invites/[inviteId]` DELETE, and `invites?export=csv`. The export is
  the one that matters: bulk PII (names, emails, dietary), and the contacts export
  carries 10/hr/org for exactly this reason. Staff-only and audited, so traceable
  but not throttled.

Also deferred, lower: `registrationId`/`speakerId` on an invite are unvalidated
free strings (write-only today — nothing dereferences them); `denyReviewer` is
called without `route` so refusals log who but not what; the setup-hub
`db.rsvpCampaign.count` runs outside a tenant lane (shared with six sibling
counts on the same page, fail-closed and cosmetic); duplicate `itemId`s in a
submit payload aren't rejected (crafted-client only); an item deleted mid-submit
yields a bare 500 where a 409 STALE_FORM would let the form reload; the invite
DELETE audit doesn't snapshot the responses it cascades away; the per-event
rate-limit buckets (`rsvp-send`, `rsvp-invites-add`) are now shared across every
RSVP on the event and should key on `campaignId`.

## Document storage — S3 bucket (deferred, low priority)

Code is shipped and inert (`STORAGE_PROVIDER` unset on prod, so the S3 provider
and migration script never run). What is outstanding is one bucket.

- **Create `ea-sys-uploads` in `ap-south-1`** — Console runbook in
  [UAE_DOCUMENT_RESIDENCY_PLAN.md](UAE_DOCUMENT_RESIDENCY_PLAN.md) section 5.
  KMS key, block-all-public-access, versioning, IAM inline policy, then migrate
  and flip two env vars.
- **Why it is low priority:** the original justification was UAE residency and
  that is gone until `me-central-1` recovers. What remains is durability
  (versioning, KMS encryption at rest, 11 nines, off the unencrypted EBS root
  volume) plus being pre-staged for the UAE move. Section 11 of the plan argues
  both sides, including the honest counter: if encryption at rest were the only
  motivation, **enabling EBS encryption is free and more direct**.
- **UAE move** — blocked on AWS restoring `me-central-1` (evacuation notice,
  multi-month estimate, 2026-08-19). Revival is a bucket plus two env vars.
- **Permanent rule, do not lose it:** never delete the local
  `public/uploads/` copies, and the provider switch must stay reversible by one
  env var plus a redeploy (~22s). That is the regional-outage failover.

### Deferred from the same work

- **`storedFileExists` was removed** as speculative. If a caller ever needs it,
  it is five lines; do not re-add it "for completeness".
- **`storage-errors.ts` is a leaf module** purely so `api-errors.ts` does not
  transitively import the Supabase client. Marginal, kept, worth knowing why.
- **CloudFront in front of the public prefixes** — not needed at 2.5ms
  in-region. Would matter again if the bucket ever moves out of region.

### Analytics review (Aug 20, 2026): deferred findings

Self-review after the five-phase build. **H1 (full referrer left the browser
before being reduced) and M2 (rate limit sized for a person, not a venue) were
fixed in-band** (`8a1c...`); these are the rest, none of which blocks anything.

- **M3.** `MAX_HITS = 100_000` in the dashboard read.** One request could pull
  roughly 15 MB into a 3,500 MB container. Generous today by a wide margin
  (production's entire fortnight of public traffic is about 2,200 hits) but it
  is the number that bounds the worst case. Lower it, or move to a
  pre-aggregated daily table, when any single event approaches it.
  `src/analytics/store/event-traffic.ts`.
- **M4.** buffer overflow uses `Array.shift()` per hit**, which is O(n) element
  moves, in the state where the database is already unreachable and the process
  is least able to afford it. A ring buffer or dropping from the tail would fix
  it. Only reachable at 10,000 buffered hits, i.e. never in normal operation.
  `src/analytics/buffer.ts`.
- **M5.** the site-resolver cache holds 500 entries** and evicts oldest-inserted,
  not least-recently-used. Spraying unique slugs can evict the real entries and
  force a database lookup per legitimate hit. Bounded by the per-IP rate limit,
  so the cost is one indexed query, but an LRU would remove the vector.
  `src/analytics/store/site-resolver.ts`.
- **L1.** visitor counts are inflatable.** A script rotating its user agent
  produces unlimited distinct "visitors" from one address, because the identity
  is derived from IP plus user agent. This is inherent to every client-side
  beacon, Google Analytics included, and the alternative (a persistent
  identifier) is exactly what the design refuses. **Documented rather than
  fixed**; if a number ever looks implausible, this is the first thing to check.
- **L2.** up to 2 seconds of hits are lost on graceful shutdown.** The flush
  timer is `unref`'d so it cannot hold the process open, and there is no SIGTERM
  hook. A shutdown flush would close the window. Traffic measurement, not money.

Also deferred from the plan itself (§6.2, §7.4): country (needs a self-hosted
MaxMind database to avoid adding a third party), the org-level cross-event view,
and publishing `src/analytics/core/` as a package.

---

## `noUncheckedIndexedAccess`: measured, deliberately NOT flipped yet (Aug 25, 2026)

**Why it is on the list.** It would have caught a production outage at compile
time. The Travel Grants card was added to the Setup hub without a matching key
in the `statuses` map; `StatusPill` dereferenced `undefined` and the whole page
died with a Server Components render error, live. The compiler believed
`statuses["travel-grants"]` was a `SetupStatus` because indexing a
`Record<string, V>` is typed as always-present while this flag is off.

**Measured, not estimated** (flag on, `tsc --noEmit`, flag restored):

| Scope | Errors | Files |
|---|---|---|
| **Everything** | **1,527** | **272** |
| `__tests__/**` | 1,060 (69%) |, |
| **Shipped code** (`src/`, `worker/`, `scripts/`) | **~430** | ~180 |

By kind: 804 × TS2532 and 315 × TS18048 (both "possibly undefined") are the
class this is about; the remaining ~400 are knock-on assignability errors.
Worst single files: `speaker-agreement-pdf.test.ts` (110),
`speaker-agreement.ts` (54), `import/registrations/route.ts` (37).

### The recommendation: do NOT flip it globally right now

Three reasons, in order of weight:

1. **A rushed sweep would reinstate the bug with worse syntax.** Most of the 430
   are `arr[0]` where the author knows the array is non-empty. The mechanical
   fix is `!`, and 430 new non-null assertions is a codebase that has *told the
   compiler to shut up in 430 places* rather than one that is safer. The value
   only lands if each site is actually thought about, which is the expensive
   part and cannot be batched.
2. **Production is live.** A 430-site diff across the API surface, the services
   layer and the CRM carries real regression risk for a benefit that is
   preventative rather than corrective.
3. **69% of the noise is in tests**, where the bug class does not matter: a test
   indexing an array it constructed three lines earlier is not a hazard.

### The cheaper path, in cost order

1. **Class-specific guards where the class actually bites.** The Setup-hub
   coverage test (`setup-hub-status-coverage.test.ts`) is the template: compare
   the two lists in both directions, and make the runtime degrade rather than
   throw. Cheap, targeted, and it fixes the instance rather than the language.
2. **An app-only tsconfig as a NON-GATING CI job.** `tsconfig.strict.json`
   extending the base with the flag on and including only `src/`, reported but
   not blocking. That surfaces the ~430 number on every push so it can be burned
   down opportunistically, and it follows the precedent this repo already set
   with the tenancy job: non-gating first, promote to gating after enough
   consecutive green runs.
3. **Flip it globally** once (2) is at or near zero.

**Do not start (2) or (3) without an owner call.** (1) should just happen
whenever the class shows up.

### The narrower lesson, which applies regardless

`Record<string, V>` is the wrong type for a map that is *supposed* to be
exhaustive over a known key set. `Record<SlugUnion, V>` makes a missing key a
compile error today, with the flag off, and is a per-site change rather than a
project. Prefer it whenever the keys are known.
