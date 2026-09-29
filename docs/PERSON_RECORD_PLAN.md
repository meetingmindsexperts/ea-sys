# One person record per event: plan

> **Status: PLANNED, NOT BUILT (Sep 29, 2026).** Planning document only. No schema,
> code or data has changed because of it. The interim step (the details sync in
> [src/lib/person-details-sync.ts](../src/lib/person-details-sync.ts)) is shipping
> separately and is described here only so its removal is planned.
>
> Related: [ROADMAP.md](ROADMAP.md) "Speaker ↔ Registration identity unification"
> (Option B), [IDENTITY_AND_ROLES.md](IDENTITY_AND_ROLES.md),
> [SPEAKER_AS_ATTENDEE_PLAN.md](SPEAKER_AS_ATTENDEE_PLAN.md),
> [src/lib/speaker-companion.ts](../src/lib/speaker-companion.ts).

## In plain language

- **Today** a speaker who also has a registration at the same event is stored twice:
  once as a Speaker and once as an Attendee. Two copies drift. On production, 19 of the
  172 speaker/registration pairs already disagree on name, organisation or phone.
- **The fix** is a new "event person" record: one row per person per event holding the
  personal details (name, title, organisation, job title, phone, photo, address, bio,
  specialty). The speaker and the registration both point at it. Edit it once and the
  badge, invoice, certificate, agenda and emails all see the same value.
- **Per event, as you decided.** A correction at one event never touches another event's
  badge or invoice. That is why the hub is per event and not the org-wide Contact list.
- **Independent speakers keep working.** A speaker who never registers still gets an
  event person record; no registration is needed.
- **Nothing existing changes without your sign-off.** The work is split into five steps,
  each shipped and reversible on its own. The step that copies existing data into the
  new record runs first as a dry run that produces a spreadsheet for you to review; the
  19 disagreeing pairs and a few other cases need your ruling (listed in §6).
- **Size:** about 6 to 8 weeks of engineering spread over several deploys, most of it in
  the careful switch of about 110 screens and documents that read these fields today.
  You get the visible benefit ("edit once") after step 3, roughly halfway; steps 4 and 5
  are clean-up that removes the old copies.

---

## 1. Goal and non-goals

**Goal.** Store the shared personal fields once per (event, person). A Speaker and a
Registration for the same person at the same event reference the same row. All writers
go through one service; all readers read that row.

Shared fields (exactly `SYNCED_PERSON_FIELDS` in person-details-sync.ts): `title`, `role`,
`firstName`, `lastName`, `additionalEmail`, `organization`, `jobTitle`, `phone`, `photo`,
`city`, `state`, `zipCode`, `country`, `bio`, `specialty`, `customSpecialty`. Plus `email`
as the key (see §3.4).

**Non-goals.**

- Not a cross-event or org-wide identity. The org-level `Contact` store stays what it is
  (the marketing and search directory, fed from the event records).
- Not a change to login accounts (`User`, one role per login). See IDENTITY_AND_ROLES.md.
- Facet-only fields stay on their facet. Speaker keeps `website`, `socialLinks`, status,
  agreements, honorarium, `submitterSource`. Attendee keeps `dietaryReqs`,
  `associationName`, `memberId`, `studentId`, `studentIdExpiry`, `customFields`.
  `registrationType` is derived from the ticket type, not personal data, and stays put.
- Tags stay on the facets, synced by [person-tag-sync.ts](../src/lib/person-tag-sync.ts).
  Moving them is a possible follow-up, not part of this plan.
- Billing fields on Registration (`billingFirstName` and friends) are the payer, not the
  person, and stay where they are.
- Not a rewrite of MCP tool shapes. Tools keep returning flat `firstName`/`lastName`, so
  connected MCP clients need no reconnect.

## 2. What exists today

| Where | Shape | Notes |
|---|---|---|
| `Speaker` ([program.prisma](../prisma/models/program.prisma)) | per event, `@@unique([eventId, email])`, `organizationId` for RLS | `sourceRegistrationId?` points at the person's registration (import path + companion) |
| `Attendee` ([registrations.prisma](../prisma/models/registrations.prisma)) | **no eventId**; reached via `Registration.attendeeId` | can be shared by several registrations |
| `Registration` | per event, `attendeeId` required | companion registrations (`SPEAKER_COMPANION`) back most speakers since June 2026 |
| `Contact` | org-wide, one per (org, email) | synced from both facets by contact-sync.ts |

Measured on production, Sep 29, 2026:

- 205 speakers; 172 have a registration at the same event with the same email.
- 19 of those 172 pairs disagree on name, organisation or phone: 8 differ only by
  whitespace, about 7 have one side blank, about 4 are real conflicts.
- 78 Attendee rows are shared by registrations at **different** events (created
  Feb 25 to Mar 23, 2026 by older code). Today's public register path only reuses an
  Attendee with zero registrations ([register/route.ts](../src/app/api/public/events/%5Bslug%5D/register/route.ts) ~line 522), so no new shared rows are created.
- Invoice and quote PDFs read the name live from the Attendee at render time
  ([invoice-service.ts](../src/lib/invoice-service.ts) ~lines 806-912), so a shared Attendee
  edited for one event changes another event's invoice today. This is the concrete harm
  the per-event rule prevents.

## 3. Data model

### 3.1 Options compared

**Option A: new `EventPerson` table, pointed at by Speaker and by Registration (recommended).**
One row per (event, email). `Speaker.eventPersonId?` and `Registration.eventPersonId?`
(both nullable during rollout). The pointer is on Registration, not Attendee, because
Registration is event-scoped and Attendee is not.

- For: per event by construction; the 78 cross-event shared Attendees need **no data
  change** (each registration points at its own event's EventPerson, seeded from the same
  values); independent speakers get an EventPerson with no registration; clear name;
  the RLS column is clean (every row has an event, so `organizationId` is always set).
- Against: one new table plus RLS policy; an extra join for readers until the legacy
  columns go; Attendee keeps a thinner role (registration-only extras).

**Option B: make Attendee the shared record; Speaker gets an optional `attendeeId`.**

- For: no new table; most speakers already have a companion registration and therefore
  an Attendee.
- Against: Attendee has no eventId, so "per event" is not enforced by the schema; the 78
  shared rows must be split first (a data change on live registrations, with invoice
  risk); an independent speaker needs an orphan Attendee, which the public register path
  deliberately adopts (`registrations: { none: {} }`), so a stranger registering with that
  email would overwrite the speaker's details unless that path changes too; "Attendee"
  would now mean "person", a naming trap for every future reader.

**Option C: org-level `Contact` as the hub.**

- For: already deduped by (org, email) and already fed from both facets.
- Against: violates the per-event decision outright (a correction at one event rewrites
  every event); Contact is mirrored to the external marketing table with no filter
  (contacts-central-sync), so it is the wrong place for per-event corrections. Rejected.

**Recommendation: Option A.** It is the only option that is per event by construction,
leaves the 78 shared Attendees untouched, and keeps independent speakers independent. It
satisfies the ROADMAP constraint (`Speaker → Person` optional): the pointer is nullable,
and even when set it never requires a registration.

### 3.2 Proposed schema (Phase 1, additive)

```prisma
// prisma/models/registrations.prisma (beside Attendee)
model EventPerson {
  id              String        @id @default(cuid())
  eventId         String
  organizationId  String        // RLS key, always derivable from the event
  email           String        // stored trimmed + lower-cased
  title           Title?
  role            AttendeeRole?
  firstName       String
  lastName        String
  additionalEmail String?
  organization    String?
  jobTitle        String?
  phone           String?
  photo           String?
  city            String?
  state           String?
  zipCode         String?
  country         String?
  bio             String?       @db.Text
  specialty       String?
  customSpecialty String?
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  event         Event          @relation(fields: [eventId], references: [id], onDelete: Cascade)
  speakers      Speaker[]
  registrations Registration[]

  @@index([eventId, email])
  @@index([organizationId])
}

// Speaker:      eventPersonId String?  (@relation, onDelete: SetNull) + @@index
// Registration: eventPersonId String?  (@relation, onDelete: SetNull) + @@index
```

- `@@unique([eventId, email])` is **not** added in Phase 1. Same-event duplicate emails
  may exist in registrations (cancelled then re-registered, group edge cases); the dry run
  counts them first (§6, D4). The unique index is added in Phase 5 once data is clean.
- `prisma/rls/eventperson.sql`: the flat `organizationId = current_setting('app.current_org')`
  policy, same template as speaker.sql. Every writer stamps `organizationId` from the event.
- Migration: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, indexes
  `IF NOT EXISTS`, FKs guarded. No RENAME, no DROP. Passes `check-migration-safety.sh`.

### 3.3 Reading rule

A reader wants "the person's details for this speaker/registration":
`speaker.eventPerson ?? speaker` and `registration.eventPerson ?? registration.attendee`.
This lives in **one** helper (`src/lib/event-person.ts`: `personOf(facet)` plus a shared
Prisma `select` fragment `EVENT_PERSON_SELECT`), so the fallback exists in one place and is
deleted in one place.

### 3.4 Email

EventPerson is keyed by (event, email). The three PATCH `/email` routes
([email-change.ts](../src/lib/email-change.ts)) gain one step: update `EventPerson.email`.
If the target email already has an EventPerson at that event, the facet is re-pointed to
the existing row (merge), mirroring how `repointOrgContactEmail` handles Contact; the
old row is left if another facet still uses it. The rule "email is immutable via general
PUT" is unchanged.

### 3.5 Photo cleanup

[photo-cleanup.ts](../src/lib/photo-cleanup.ts) counts references across Attendee, Speaker
and Contact before unlinking a file (INC-004). **EventPerson must be added to that count in
Phase 1, before any row is written**, or deleting a speaker could destroy a photo the
EventPerson still shows.

## 4. Phased rollout

Each phase is its own deploy, passes the full gate, and can be reverted by reverting its
code without a data repair.

### Phase 0: interim sync (shipping now, not part of this plan's effort)

`person-details-sync.ts` copies only the fields that changed in an edit from speaker to
registration(s) and back, same event, best-effort, skips shared Attendees, logs every
skip and failure. Called from `updateSpeaker` and `updateRegistration`. Existing
disagreements are left alone. This is the behaviour Phase 2 absorbs.

### Phase 1: expand (schema only)

- Add `EventPerson`, the two nullable pointers, the RLS file, the photo-cleanup reference.
- No code writes or reads it yet (except photo-cleanup's count, which sees zero rows).
- **Revert:** revert the code; the empty table and null columns are harmless and stay.
- **Effort:** 1 to 2 days.

### Phase 2: single writer + dual write (new data only)

- New service `src/services/event-person-service.ts` (errors as values, `source` in the
  audit, no `next/server`, per [services/README.md](../src/services/README.md)):
  - `ensureEventPerson(tx, { eventId, email, details })`: find-or-create for a **new**
    facet (speaker create, registration create, companion create, imports, group
    registration, MCP create tools, event clone).
  - `updatePersonDetails(tx, facet, delta)`: the one update path. Writes the legacy
    columns exactly as today, applies the same delta to the EventPerson if the facet is
    linked, and (for linked pairs) the counterpart legacy row. Shared cross-event
    Attendees are skipped for the legacy mirror and logged, exactly as Phase 0.
- **The interim sync is folded in here.** Its logic (delta, not overwrite; same event;
  skip shared; best-effort for the counterpart) moves into the service; the two call
  sites in speaker-service and registration-service call the service instead;
  `person-details-sync.ts` is deleted in this phase. `computeDetailsDelta` survives as a
  service-internal helper.
- New rows get an EventPerson at creation, which changes no existing data. Existing
  unlinked rows stay unlinked until Phase 3.
- Companion creation and "import registrations as speakers" stop copying fields: they
  link the new facet to the existing EventPerson.
- A CI grep gate (`scripts/check-person-writes.sh`, same style as the other `check-*`
  scripts) fails the build if any file outside the service writes a shared personal field
  on `attendee` or `speaker`.
- Readers still read the legacy columns, so nothing a user sees changes.
- **Revert:** revert the code. EventPerson rows written meanwhile are not read by anyone.
- **Effort:** 5 to 7 days (about 20 writer files, see §5.2).

### Phase 3: backfill (existing data, owner-approved)

Script `scripts/backfill-event-person.ts`, run in the worker container, three modes:

1. `--dry-run` (default): writes nothing. Produces a CSV per event with one line per
   proposed EventPerson: the facets it will link, the value chosen per field, the source
   of each value, and a `needs_ruling` flag. Also a summary: counts per rule below.
2. `--apply --rulings=<csv>`: runs only after the owner has marked the CSV. Per event,
   in a `tenantTransaction`: creates EventPerson rows and sets the pointers. **Writes no
   legacy column.** Takes a `pg_dump` of Speaker, Attendee, Registration first.
3. `--undo --run=<id>`: nulls the pointers set by that run and deletes the EventPerson
   rows it created (recorded in an AuditLog entry per run).

Grouping rules, in order:

| Case | Rule |
|---|---|
| Speaker with `sourceRegistrationId`, same email | one EventPerson for both |
| Speaker and registration, same event, same email (case-insensitive, trimmed) | one EventPerson for both |
| `sourceRegistrationId` points at a registration with a **different** email | flagged, owner ruling D3 |
| Speaker with no registration (independent) | own EventPerson from the speaker row |
| Registration with no speaker | own EventPerson from its Attendee |
| Registration on a cross-event shared Attendee (78 rows) | own EventPerson **per event**, seeded from the shared Attendee's current values; Attendee untouched |
| Two registrations, same event, same email | one EventPerson if all fields agree, else flagged, owner ruling D4 |

Field rules when two facets are merged:

| Difference | Proposed value |
|---|---|
| Equal after trimming (8 pairs) | trimmed value |
| One side blank (about 7 pairs) | the non-blank value |
| Real conflict (about 4 pairs) | owner picks per pair (D2); the CSV proposes one |

After apply, a read-only parity check (`--verify`) compares every linked EventPerson with
its legacy rows and reports any difference. It is also added as a nightly worker job for
the duration of Phases 3 and 4 (logs `event-person:drift` at warn).

- **Revert:** `--undo`, or restore the three tables from the pre-run dump.
- **Effort:** 2 to 3 days engineering, plus owner review time.

### Phase 4: switch reads, one area at a time

Readers change from `attendee.firstName` / `speaker.firstName` to `personOf(...)`. One
area per deploy, in this order (lowest risk first, money last):

1. Dashboard lists, detail sheets, admin lookup
2. Agenda, public session and speaker pages, webinar and Zoom panelist sync
3. Exports and imports
4. Emails and templates (email preview, bulk email, agreements, notifications)
5. MCP and agent tools
6. Public forms and the registrant portal
7. Badges, check-in, certificates, survey
8. Invoices, quotes, payments, receipts, Stripe webhook

Because the fallback `?? legacy` stays, an unlinked row renders exactly as before. The
only visible changes are the owner-approved merged values from Phase 3.

Verification per area, on the local copy of prod (after `npm run db:snapshot`): render
the area's documents before and after (badge PDF, invoice PDF, CSV export, email preview)
and diff; the only differences must be the pairs in the approved rulings CSV. Visual pages
are opened in the browser (headed), per the "verify what you touched" rule.

- **Revert:** per area, revert that area's commit. Legacy columns are still written, so
  the old reads are still correct.
- **Effort:** 2 to 3 weeks (about 110 files, see §5.1).

### Phase 5: contract

- **5a (after every area has run through one real event):** stop writing the shared
  fields to Speaker and Attendee. The service writes EventPerson only. Legacy columns
  freeze as a historical snapshot. Make both pointers required at the application level
  (every create links one). Add `@@unique([eventId, email])` on EventPerson once D4 is
  resolved. Remove the fallback from `personOf`. Remove the nightly parity job.
  **Revert:** turning the legacy writes back on is a code revert, but edits made while
  they were off exist only in EventPerson; a one-off script copies them back if needed.
- **5b (months later, owner call D5):** drop the frozen legacy columns in a separate
  deploy, never the same deploy that stopped using them. This is the only irreversible
  step and is optional.
- **Effort:** 2 to 3 days for 5a; 1 day for 5b.

### Effort summary

| Phase | Engineering | Visible to users |
|---|---|---|
| 0 interim sync | shipping now | future edits copy across |
| 1 expand | 1-2 days | nothing |
| 2 single writer | 5-7 days | nothing (same behaviour as Phase 0) |
| 3 backfill | 2-3 days + owner review | nothing until reads switch |
| 4 read switch | 2-3 weeks | approved merged values appear, area by area |
| 5 contract | 3-4 days | nothing |
| **Total** | **about 6-8 weeks** | |

## 5. Surface inventory

Counted with grep on Sep 29, 2026 (`src/` and `worker/`). "Direct" = property access such
as `attendee.firstName` (99 files); "nested" = a Prisma `select` of these fields through
the `attendee`/`speaker` relation (about 10 more). `worker/` has no direct reads: its jobs
call into `src/lib`. Counts are approximate (a file can serve two areas); the per-area
commit will re-grep.

### 5.1 Readers (about 110 files)

| Area | Files | Examples |
|---|---|---|
| Invoices, quotes, payments, PDFs | 18 | invoice-service, invoice-export, quote-pdf, payment-confirmation-email, refund-reconciliation, stripe-webhook-handler, payment-service, checkout, group-checkout, invoice routes, payer dialog |
| Abstracts, proposals, program, reviewers | 15 | abstract-service, presenter-agreement, presenter-registration, presenter-signup, abstracts and session-proposals pages and routes, agenda page, session detail sheet |
| Public pages and forms | 14 | /e/[slug] agenda, session, my-registration, complete-registration, speaker/presenter agreement pages; public speaker-form, travel-grant, reimbursement, zoom-join routes; speakers-agenda-preview |
| Dashboard UI | 13 | registrations page, detail sheet and types, speakers page and detail sheet, communications, accommodation, reimbursements, audit-log display, event-analytics, admin lookup |
| Emails and templates | 10 | bulk-email, speaker-agreement (email context), abstract-notifications, session-proposal-notify, email-preview, completion emails, per-entity email routes, resend-confirmation |
| MCP and agent tools | 9 | agent/tools dashboard, registrations, speakers, sessions, abstracts, accommodations, invoices; register-mcp-tools; mcp/remote-client |
| Certificates and survey | 8 | cert-context, eligibility, survey-thankyou-sweep, auto-issue analytics, survey responses and export, public survey page |
| Badges and check-in | 5 | badge-pdf, badges route, check-in route, check-in page, kiosk |
| Imports and linking | 5 | speakers import-registrations route and dialog, RSVP invitee import, speaker-companion, grant-companion |
| Travel grant, reimbursement, speaker profile | 4 | travel-grants route, travel-grant console, reimbursements route, profile-form route |
| Webinar and Zoom | 3 | Zoom panelists, webinar panelist sync, webinar presence |
| Core services | 3 | registration-service, speaker-service, group-registration-service |
| Exports | 2 | registration-export, submission-docx-export (invoice and survey exports counted above) |
| Registrant portal | 2 | registrant/registrations, registrant/my-group |

### 5.2 Writers (about 36 files, about 20 write shared personal fields)

Files that create or update `attendee` or `speaker` rows: 18 for Attendee, 23 for
Speaker, 5 overlap. The ones that write **personal** fields and move to the service in
Phase 2:

- Services: registration-service, speaker-service, group-registration-service
- Creation paths: public register, complete-registration, speaker-companion,
  presenter-registration, event clone
- Imports: import/registrations, import/eventsair, import/speakers,
  registrations/import-contacts, speakers/import-contacts, speakers/import-registrations
- Self-service and public forms: registrant/registrations, abstracts/my-profile,
  public speaker-form (+ photo), speaker-agreement, presenter-agreement (where they write
  name fields)
- Email change: registrations/[id]/email, speakers/[id]/email
- MCP: agent/tools/registrations, agent/tools/speakers
- Reviewers route and organization/users route (where they create a speaker or rename)

The rest write only facet fields (honorarium, agreement, reimbursement types, tags,
survey, ticket type) and are unaffected; the CI gate in Phase 2 confirms that.

## 6. Owner decisions needed

| # | Question | Recommendation |
|---|---|---|
| D1 | The 78 cross-event shared Attendees | Leave them untouched. Each event gets its own EventPerson seeded with the same values, so nothing visible changes and future edits stay per event. No split needed. |
| D2 | The about 4 real conflicts among the 19 pairs | Owner picks per pair from the dry-run CSV. The 8 whitespace and about 7 one-side-blank pairs follow the rules in §4 Phase 3 unless you object. |
| D3 | A speaker linked by `sourceRegistrationId` to a registration with a different email | One person or two, per case; the dry run will count them. Default: one person, keyed on the speaker's email. |
| D4 | Two registrations at the same event with the same email and different details | Per case from the CSV. Needed before the unique index in Phase 5. |
| D5 | Drop the frozen legacy columns (Phase 5b) | Not before one full conference cycle after 5a; could be never. |
| D6 | Should merged values also be written back to the legacy rows at backfill? | No. Legacy rows stay exactly as they are; merged values appear only through the new record, area by area in Phase 4. |

## 7. Risks and how each is caught

| Risk | Caught by |
|---|---|
| A write path keeps writing the old columns only, so the two drift | Phase 2 CI grep gate; nightly parity job during Phases 3-4 |
| A correction at one event reaches another event | Pointer on Registration, EventPerson has `eventId`; test that editing a registration on a shared Attendee leaves the other event's invoice name unchanged |
| An independent speaker is forced to register | Pointer nullable; test creating a speaker with no registration still gets an EventPerson and no Registration |
| Backfill merges two different people | Dry run first; grouping by (event, email) only; flagged cases go to the owner; `--undo` |
| Photo file deleted while still shown | EventPerson added to photo-cleanup reference count in Phase 1, with a test |
| Cross-tenant read or write | `organizationId` on every row, RLS policy in `prisma/rls/eventperson.sql`, tenancy harness case in `tests/tenancy/` |
| A badge, invoice or certificate changes unexpectedly | Before/after render diff per area on the local prod copy; money surfaces switched last |
| Email change leaves the person under the old address | EventPerson step added to the three PATCH `/email` routes, with merge test |
| Silent failures | Every service error code logged at the route boundary; backfill and parity log per row; no empty catch (`check-no-silent-server-catches.sh`) |
| Deploy ordering (blue/green) | Expand, migrate, contract: no column is dropped in the deploy that stops reading it; migrations additive and idempotent (`check-migration-safety.sh`) |
| MCP clients see changed tool shapes | Tool outputs stay flat; golden agent tasks (`npm run agent:golden`) re-run after area 5 |

Tests added along the way: service unit tests (create, link, update delta, shared-Attendee
skip, email merge), backfill grouping tests on fixtures that reproduce each rule in §4,
one route test per switched area asserting the value comes from EventPerson, and the
tenancy isolation case.

## 8. How the interim sync is retired

1. **Phase 2:** `syncSpeakerDetailsToRegistrations` and
   `syncRegistrationDetailsToSpeakers` are replaced by `updatePersonDetails` in the
   service, which keeps the same rules (delta only, same event, skip shared Attendees,
   log every skip). `src/lib/person-details-sync.ts` is deleted in the same commit. Its
   tests move to the service.
2. **Phase 5a:** the counterpart legacy mirror inside the service is removed, because
   both facets read the same EventPerson and there is nothing left to copy.
3. `person-tag-sync.ts` is untouched (tags are out of scope).
