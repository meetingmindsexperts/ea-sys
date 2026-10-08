# Event Blueprint and Online Venue: integration plan

**Status: IN BUILD (Oct 8, 2026).** Written Oct 5 after reading both source
folders and the external developer handover. Step 1 of section 6 is built: see
"Progress" at the end.

## 1. Owner decisions (Oct 5, 2026)

| # | Decision |
|---|---|
| D1 | Blueprints are filled in by the MM Group team (staff accounts). No client-facing access in v1. |
| D2 | The EA-SYS event is created **automatically when a blueprint is approved**. Approval is refused while the blueprint is incomplete, so a half-done brief can never become an event. |
| D3 | The module ships dark behind `BLUEPRINT_MODULE_ENABLED`, like Budget & Procurement. |
| D4 | The approver is always **someone other than** the person who filled the blueprint in. Who may approve is set through roles in Settings (custom roles). |
| D5 | We change the vendor code ourselves (`platform.js`, `app.js`, the venue modules); no round trip to the external developer. |
| D6 | **Organisers set up the venue rooms** themselves when a venue is needed, so the venue becomes data-driven (section 5.6) instead of a developer build per event. They do it in the Blueprint's Spaces step and layout sketch, which the venue is generated from. |
| D7 | Venue safety reports go to **info@meetingmindsgroup.com**. |
| D8 | **Rooms stay editable after approval** (owner, Oct 8, 2026): venues change, rooms are added or removed. Edits are saved with the version check, can be sent as a numbered update, and, for the online venue, regenerate it. A non-owner who edits counts as an editor, so cannot approve that blueprint's preview. The EA-SYS event created at approval is not updated from later brief edits (its venue is changed in the event's own settings). |

## 2. What we received

Folders in `~/Downloads` (the `event-blueprint` and `event-blueprint 2` folders
and both zips are byte-identical copies):

| Project | Version | Source | Built page | Tests |
|---|---|---|---|---|
| `event-blueprint` | Blueprint v6 | 5 files: `part1.html` (markup, CSS), `data.js` (163 lines), `bench.js` (338), `platform.js` (106, the adapter), `app.js` (1,125) | `dist/index.html`, one file, ~235 KB, no libraries | 6 Playwright suites |
| `ehc-venue` | Venue v7 | 12 files: WebGL 2 engine, world, characters, physics, social, abilities, team tools, language filter (~3,100 lines) | `dist/index.html`, one file, ~275 KB, no libraries | 9 Playwright suites + a Node unit test |

Both are plain JavaScript with no framework or npm. `python3 build.py`
reproduces each published page byte for byte. Both run today as Claude
artifacts, using the hosting runtime (`window.claude.use(...)`) for sign-in,
shared data, AI, live presence and uploads.

## 3. How the two fit together and into EA-SYS

```
Blueprint (new, org level)                       Event (existing)                  Venue (per event)
team fills the 13-section brief  ── approve ──►  created automatically (DRAFT)  ──► online twin, built
(draft · submitted · in review)                  Setup hub · Readiness · regs        generated from the blueprint's
                                                                                     Spaces, at /e/<slug>/venue
```

- The **Blueprint** is the intake: it exists before any event does.
- Approval creates the **event**; from there the existing Setup hub,
  Readiness page, registrations, sessions and sponsors take over.
- The **venue** is a *deliverable* of a blueprint whose path is "Bring an event
  online" (the `twin` path). Today its layout, signage and dates are code in
  `world.js` (EHC 2026, Conrad Dubai, 4 September 2026). Per D6, organisers
  will set up the rooms themselves, so the venue has to become data-driven
  (section 5.6).

## 4. Event Blueprint

### 4.1 Hosting

Serve the built page as it is, inside EA-SYS, at **`/blueprint`** (outside the
dashboard shell; same origin, so the session cookie works). A small server
page injects `window.EVENT_BLUEPRINT_BACKEND = { api: '/api/blueprint', ai: true, files: true }`
before the script, which switches the page into its existing API mode.

Checked: our global headers set no `script-src`, so the page's inline scripts
run; the page does not use the microphone; pdf.js loads from cdnjs only when a
PDF is read. A React rewrite of 1,100 lines is not justified for v1.

The page is still the external developer's code. We vendor `dist/index.html`
plus `src/` into the repo (e.g. `vendor/event-blueprint/`) with its build
script, so a rebuild is reproducible and their test suites keep running.

### 4.2 Data model (new tables, tenant-correct from day one)

- **`Blueprint`**: `id`, `organizationId`, `ownerId`, `title`, `type`,
  `status` (enum, section 4.4), `ref`, `readiness`, `data` (JSON, the page's
  whole `v: 2` object minus the server-owned fields), `eventId` (nullable, set
  on approval), `approvedAt`, `approvedById`, `createdAt`, `updatedAt`.
- **`BlueprintTemplate`**: `id`, `organizationId`, `ownerId`, `name`, `data`.
- **`BlueprintStatusLog`**: one row per stage change or submission (who, when,
  from, to, readiness at the time). Replaces the page's own `statusLog` and
  `submissions` arrays as the record of truth.
- Uploads: stored through `src/lib/storage.ts` (S3), indexed in a
  `BlueprintFile` table (`blueprintId`, `storedPath`, `name`, `contentType`,
  `sizeBytes`).
- RLS policies in a new `prisma/rls/blueprint.sql`; the rls-coverage test
  enforces them. Migrations additive and idempotent.

Blueprints belong to the **organisation**, with an owner. The page's
owner-only listing becomes "the org's blueprints", filtered by permission.

### 4.3 API (`/api/blueprint/*`), mapped to EA-SYS

| Endpoint the page calls | EA-SYS implementation |
|---|---|
| `GET /me` | Session user; `isEditor` = has the `blueprints.manage` permission (custom-roles catalogue, `src/lib/permissions/catalogue.ts`). |
| `GET /blueprints`, `GET/PUT /blueprints/:id` | `blueprint-service` (new, `src/services/`). PUT validates with a Zod schema that mirrors the page's `sanitise()` (fixed types and lengths), strips server-owned fields, caps the body size and is rate-limited (the page saves the whole object on a 1 s debounce). |
| `GET/PUT /templates` | Same service, org-scoped. |
| `POST /ai/json` | **Changed contract** (section 4.6). Uses `src/lib/ai` (`getDefaultAiProvider()`), rate-limited per user, logged. |
| `POST /files`, `GET/DELETE /files/:id` | S3 via `storage.ts`, magic-byte type checks. The 20 MB cap needs this route excluded from the middleware body cap (`src/proxy.ts`). |
| `POST /events` | **Replaced** by explicit workflow endpoints (section 4.4). |

Every route: `auth()`, module flag, `requireOrgId`, permission check,
`runWithTenant`, every failure path logged.

### 4.4 Workflow: the server owns it

**Finding (must fix):** in the page, `status`, `approvals`, `statusLog`,
`submissions`, `ref` and `baseline` live inside the object the browser saves
whole, and the build-team stage control is only hidden, not enforced. Hosted as
written, anyone who can save could set their own blueprint to Live or approve
it.

So:

- `PUT /blueprints/:id` ignores those fields. The server keeps them in columns
  and `BlueprintStatusLog`, and returns them merged into the object on `GET`, so
  the page renders unchanged.
- New endpoints, each a permission-checked transition in `blueprint-service`:
  - `POST /blueprints/:id/submit`: draft to submitted; assigns `ref`; records
    the readiness snapshot; emails the team (SES via `sendEmail`).
  - `POST /blueprints/:id/stage`: build-team moves (submitted, in review,
    plan ready); `blueprints.manage` only.
  - `POST /blueprints/:id/approve`: section 4.5.
- The page's `Platform.notify` and stage control are pointed at these endpoints
  (a small change in `platform.js` and two call sites in `app.js`).

Stages (from the page): Draft, Submitted, In review, Plan ready, Building,
Preview, Live. They live on the **blueprint**, not on `Event.status`; once the
event exists, its own status (DRAFT, PUBLISHED, LIVE...) is the source of truth
for the later stages.

### 4.5 Approval creates the event (D2)

- **Completeness is checked on the server.** The page computes readiness and
  "blocking" items client-side (`score()` in `app.js`); the approval endpoint
  must not trust that number. Port the blocking rules (required fields per
  section) into `blueprint-service` and refuse approval (409
  `BLUEPRINT_INCOMPLETE`, listing what is missing) unless there are none.
- **One event, ever.** `eventId` is set in the same transaction as the
  approval; approving again returns the existing event. Re-submissions after
  approval update the brief, not the event.
- **Event creation goes through one service.** Today event creation lives in
  two places (`src/app/api/events/route.ts` and the agent's `create_event`;
  clone and the EventsAir import copy rather than create, and stay separate).
  A third caller would break the no-duplication rule, so step 1 is extracting
  `event-service.createEvent()` and pointing both existing callers at it.
- **What the event gets:**

| Blueprint | EA-SYS |
|---|---|
| `basics`: title, dates, venue; `format` | Event (In person / Hybrid / Virtual map to CONFERENCE / HYBRID / WEBINAR), created as **DRAFT** |
| `programme.rows` | Sessions, via `session-service.createSession()` |
| `people.hosts` | Speakers, via `speaker-service.createSpeaker()` (only rows with an email; the rest stay in the brief) |
| `partners.list` | Sponsors, via `sponsor-service.saveSponsors()` |
| `look.brand` | Event banner / email header, where a file was uploaded |
| `files.uploads` | Event media library |
| Avatars, 3D look, online features, delivery notes | Stay in the blueprint; linked from the event |

  Partial failures (a speaker row that fails) do not undo the event; they are
  logged and listed on the blueprint so the team fixes them by hand.

### 4.6 AI: named tasks, prompts built on the server

**Finding (must fix):** the page builds the whole prompt in the browser
(`qfPrompt()` for quick fill, `ask(prompt)` for concept options) and
`POST /ai/json` forwards it. Hosted as written, any signed-in user could send
anything to Claude on our key.

So the contract becomes `POST /ai/json { task, input, images? }` with a fixed
set of tasks (`quickfill`, `concept-options`, and the others found in
`app.js`), the prompt templates moved from `app.js` into the server, input
length capped, images capped by count and size, rate-limited per user. About 20
lines change in `app.js`.

### 4.7 Permissions

New catalogue entries: `blueprints.view`, `blueprints.edit`,
`blueprints.manage` (stages), `blueprints.approve`, granted through custom
roles in Settings (D4). The approve endpoint also refuses the blueprint's owner
and anyone who edited it since submission (409 `APPROVER_IS_AUTHOR`), using the
separation-of-duties helper in `src/lib/permissions/separation.ts`.

## 5. Online venue (EHC 2026)

### 5.1 What it is

A walkable 3D copy of EHC 2026 at Conrad Dubai: AI attendees you can talk to,
live colleagues as avatars, gestures, queues, four camera views, recordings on
screens, safety tools (mute, block, report, an English and Arabic language
filter), sponsor activity for the event team, and a device check.

### 5.2 Where it lives

`/e/<slug>/venue`, a public event page like `/e/<slug>/session/<id>`, gated the
same way: a registered attendee or org staff. The page is served with a small
`window.claude` **shim** that implements the methods it calls today
(`tests/mock.js` is the reference), backed by EA-SYS:

| Capability today | EA-SYS backing |
|---|---|
| `user` (who, is event team) | Session; event team = staff with access to the event |
| `db` activity (`analytics/<user>`) | New `VenueActivity` table, or the first-party analytics module (`src/analytics`) |
| `db` reports | New append-only `VenueReport` table; email to the event team |
| `db` filter and screen settings | `Event.settings.venue` |
| `EHC_SCREENS` | Recordings per screen from S3 or the Zoom cloud recordings we already pull |
| `EHC_CONTACT` | info@meetingmindsgroup.com (D7) |
| `sample` (AI attendees) | `POST /api/venue/ai`, section 5.3 |
| `room` (live colleagues) | A WebSocket service, section 5.4 |

### 5.3 AI attendees

Same finding as 4.6: `social.js` builds the persona prompt in the browser, and
the handover's `POST /venue/ai { persona, turns }` would forward it. The
server must own personas and venue facts; the page sends `{ npcId, turns }`,
turns capped in count and length, rate-limited per attendee. **Cost** is the
main risk: every attendee can hold open conversations on our key, so a per-
event budget and a per-user cap are needed before launch.

### 5.4 Live colleagues

Needs a WebSocket server. EA-SYS (Next.js route handlers) cannot hold
WebSocket connections, so this is a small separate container on the box (like
MediaMTX), checking the EA-SYS session. Capacity on the shared t3.large has to
be measured before a large event.

### 5.4a Why the AI attendees need limits

Every reply an AI attendee gives is one paid call to Anthropic on MM Group's
API key, billed by the amount of text sent and received. One reply is cheap,
roughly a fifth of a US cent on the quick model (approximate, to be confirmed
against current pricing): 1,000 attendees each exchanging 20 lines costs in the
order of USD 40. The limits are not about normal use; they are about the
abnormal cases:

- **One person or a script** sending thousands of messages runs up the bill
  with nothing to stop it, and the cost per reply grows as a conversation gets
  longer (the whole conversation is sent again each time).
- **Shared rate limits.** The venue would use the same Anthropic account as the
  AI agent and the Blueprint's AI. A spike in the venue can make Anthropic
  throttle all three at once, so the event team's own tools stall during the
  event.

So: a cap per attendee (for example 40 replies an hour), a daily cap per event,
and a switch for the event team. When a cap is hit, attendees get the
pre-written answers the venue already has, and the event team sees why.

### 5.5 Phasing

- **A. Walkable, no AI, no presence:** served at `/e/<slug>/venue` with the
  shim's `user`, `db` and screens. The page already falls back to pre-written
  answers without AI.
- **B. AI attendees** through the server endpoint, with the budget caps.
- **C. Live colleagues** through the realtime service.

### 5.6 Organiser-defined rooms (D6): the Blueprint is the room editor

The Blueprint already collects the venue. Its **Spaces** step stores, per room,
`name`, `purpose`, `layout` (theatre, classroom, cabaret, banquet, boardroom,
U-shape, exhibition stands, standing reception, open, online only), `cap` and
`area` (m²). Its **layout sketch** (`sketchModel()` in `bench.js`) turns that
list into a to-scale floor plan in metres: each room sized from its area (or
from its capacity and layout when no area is given), placed with 3 m corridors
between rows, and draggable and rotatable by the organiser, with positions
saved in `sketch.rooms` (`x`, `y`, `aspect`, `rot`). `roomContent()` then
lays out what is inside each room, also in metres: the stage, seat rows,
tables, boardroom table and exhibition stands (named from the partners list).
The vendor wrote it for this purpose ("the online venue is built from the
spaces list"), and the Programme step already ties each session to a space.

So there is **no separate room editor to build**. Organisers set the rooms up
in the Blueprint, and the venue is generated from it.

| Venue needs (`world.js` zone) | Comes from the Blueprint |
|---|---|
| `name`, `sub` | `spaces[].name`, `spaces[].purpose` |
| `rect` (floor rectangle) | sketch `x`, `y`, `w`, `d` after rotation |
| furniture (stage, seats, tables, stands) | `roomContent()` items, already in metres |
| screen and sign text | programme rows for that space, plus the event name and dates |
| exhibition stand names | partners marked as exhibiting |
| `ceil` (ceiling height) | not captured: derived from layout and size (e.g. 9 m for a hall over 300, else 6 m) |
| doors and corridors | not captured: generated on the side of each room facing the nearest corridor |
| `spawn`, floor finish, tint | not captured: derived defaults (inside the main door; carpet; a palette per room) |
| online-only spaces | skipped in 3D (no physical room) |

What remains to build:

1. **A generator** that turns the blueprint's `spaces` + `sketch` +
   `programme` into the venue layout, stored per event in
   `Event.settings.venue` (or a `VenueLayout` table if it grows), validated on
   the server.
2. **`world.js` builds from that layout** instead of fixed coordinates. Today
   it hand-places EHC's rooms and furniture (`world.js` lines 12 to 330). The
   physics, navigation grid and camera already work from whatever geometry the
   world produces, and their test suites (no wall penetration, every door
   passable, every room reachable) become the check that a generated layout is
   walkable. A layout that fails is refused with the reason, before anyone
   walks it.
3. **Signage and screens from EA-SYS data**: once the event exists, session
   titles come from the agenda, sponsors from the Sponsors table, recordings
   from Zoom or S3, so the venue follows the live event rather than the brief.
4. **Events with no blueprint**: the Blueprint already has a "Bring an event
   online" path for an event that happened or is booked. An organiser starts
   one for an existing EA-SYS event and fills only the Spaces step.

Changing rooms after approval: the spaces stay editable on the approved
blueprint (a change is logged, as every edit is), and the venue is
regenerated from it. Open question for the owner in section 7.

This is still the largest single piece in the plan, but smaller than it looked:
the editing, sizing and furniture maths exist; the work is the generator and
making `world.js` data-driven. It is scheduled after the Blueprint and after
venue phase A runs on the hand-built EHC layout.

Privacy (UAE PDPL, from the handover): counsel signs off the privacy notice,
the lawful basis for counting visits, retention and deletion **before** phase
A collects activity. Data is hosted in AWS Mumbai with DR in Singapore.

## 6. Order of work

1. Extract `event-service.createEvent()`; point the events route and the agent
   tool at it (no behaviour change; tests first).
2. Blueprint tables, RLS, permissions, module flag.
3. `/api/blueprint` storage, templates and files; host the page at
   `/blueprint` in API mode. Gate: the vendor test suites pass against it.
4. AI named tasks (their `app.js` change + server prompts).
5. Server-owned workflow: submit, stages, emails.
6. Approval with the server completeness check and automatic event creation.
7. Venue phase A on the EHC layout, then B (AI with limits), then C (live
   colleagues), each behind the same flag and after the privacy sign-off.
8. Organiser-defined rooms (section 5.6): a generator from the blueprint's
   spaces, sketch and programme to a venue layout, and a data-driven
   `world.js`. The Blueprint's Spaces step is the room editor.

Each step: lint, types, unit tests, a visible local browser check, independent
review before push.

## 7. Open questions

1. **AI limits for venue attendees** (section 5.4a): confirm the default caps
   (per attendee per hour, per event per day) before phase B.
2. **Privacy sign-off** (UAE PDPL) before venue phase A collects activity.
3. ~~**Room changes after approval**~~ Answered Oct 8, 2026 (D8): organisers
   keep editing the spaces on an approved blueprint, and the venue regenerates.

Answered Oct 5, 2026: approver (D4), who changes the vendor code (D5), venue
per event (D6), report inbox (D7).

## Progress

- **Oct 8, 2026, step 1 built.** `src/services/event-service.ts` is the one
  creation path; the dashboard route and the agent tool call it. Two owner
  rulings on the way: (a) every door gets the same result (templates,
  registration types, audit row, `-1`/`-2` slugs); verified on the local copy
  that only two test events were ever made through the agent, so nothing real
  changed; (b) the starting registration types are per organisation
  (Settings → General, `Organization.settings.defaultRegistrationTypes`,
  empty = none), because the five medical names are one tenant's vocabulary.
  Migration `20261008120000` gave existing organisations the old five. Front
  door ruling: the Blueprint is added beside the existing ways to create an
  event in v1, not instead of them.
- **Oct 8, 2026, step 2 built.** Tables, RLS, the four `blueprints.*` keys and
  `BLUEPRINT_MODULE_ENABLED`. Role defaults (owner): Admins view, edit, manage
  and approve; Organizers view and edit; Members view. User ids are plain
  strings (no foreign key), as in procurement. Note on the vendor workflow: its
  "Approve the plan / preview" buttons are clicked by the blueprint's OWNER
  (the client approving the build team's work). Under D1 and D4 that becomes
  the separate approver's step, so those buttons are rewired in step 5, not
  reused as they are.
- **Oct 8, 2026, step 3 built.** Vendored at `vendor/event-blueprint/`, served
  at `/blueprint`, storage API at `/api/blueprint/*`, verified end to end on
  the standalone build (create, save, reload from the server with local storage
  wiped, upload a floor plan, save a template). Departures from section 4: (a)
  the server checks structure (plain object, 256 KB, depth 8) and each field
  it reads where it reads it, instead of a TypeScript copy of `sanitise()`,
  which would drift from the vendor's; (b) uploads cap at 10 MB, nginx's
  limit, not the vendor's 20 (the page's wording is corrected in step 4), and
  are typed from their bytes and served under a sandboxing CSP; (c)
  `ai: false` until step 4 moves the prompts to the server.
  Also in step 3: the page's three fonts are self-hosted
  (`public/blueprint-fonts/`, Latin subsets, 80 KB) instead of loaded from
  Google, per the hermetic-build rule; and the page is built by either the
  vendor's `build.py` or the same join in Node (`npm run blueprint:build`,
  `-- --node`), owner's choice to keep Python with a Node fallback. Python
  runs only on the machine that rebuilds the page, never on the server.
  **Open for step 5:** when the server answers 404 for a blueprint the page
  remembers (`eb-cur` in local storage), the page falls back to its local
  copy, and its next save would re-create the row. `platform.js` should map a
  404 to "gone", drop the local copy and return to the list.
- **Oct 8, 2026, step 4 built.** AI as named tasks with server-held prompts,
  verified live (quick fill from typed words: 16 items found, Haiku, about
  1,400 tokens). The vendor's prompt text stays in `app.js` only for its
  artifact mode, which their own test suites run; in our API mode the page
  sends `{ task, input }`. Also: the step 3 page module timed out a repo-wide
  source scan in CI (unit job of run 37743218212, so step 3 did not deploy);
  the page is now JSON.
- **Oct 8, 2026, step 5 built.** Owner rulings: the approver signs off both
  the plan (creating the event) and the preview; emails go to the build team on
  submit and update, and to the writer on progress. Verified on the standalone
  build with AWS credentials disabled (the local database holds real
  colleagues' addresses): submit minted `EB-261008-SFJ`, nine build-team sends
  failed safely without blocking it, a Submitted-to-Building move was refused,
  Submitted-to-In-review succeeded, and a deleted blueprint was not revived.
  For step 6: the page's acknowledgement still says "Nothing is built until
  you approve it here"; reword for the approver.
- **Oct 8, 2026, step 6 built: phases 1 to 3 of the proposal are complete.**
  Approval runs the VENDOR'S OWN `sanitise()` and `score()` on the server
  (generated slice of `app.js`, sandboxed), not a port, so section 4.5's
  "port the blocking rules" became "run them". Walkthrough on the standalone
  build with two people (Organizer writes and submits, Admin reviews and
  approves): the writer saw no approve button; approving created a DRAFT
  conference on 4 to 5 March 2027 at the brief's venue with three sessions at
  the right Dubai times and the organisation's five starting registration
  types; the preview's approval made it Live. It also found the sponsor tier
  mismatch, now fixed and re-checked against the database. Still open:
  "Room changes after approval" (section 7), and the venue phases (step 7 on).
- **Oct 8, 2026, independent review of steps 3 to 6, all findings fixed**
  (owner: "fix all"). H1: every non-owner who edits, at any stage, is recorded
  and refused as approver. H2: the event is written onto the blueprint the
  moment it exists, so no later failure can lead to a second one. M3: a claim
  with no event after ten minutes can be taken again. M4/M5: every save and
  approval names the server version it saw; a stale one is refused (409
  `STALE_VERSION`). M6: viewers never try to save, and a final refusal stops
  the retry loop. M7: the page scales a picture to 1600 px before the AI reads
  it. L8: every sandbox call has its own timeout. L10: approval also needs
  `events.create` for the resulting event type. L11/L12: files belong to one
  blueprint (upload and delete name it, both count as edits), documents
  download, a ZIP must really be Office, a failed row removes its stored file,
  and the picker offers only accepted types. L13: a foreign id is 404 under
  RLS. L14: the final status write is guarded. L15: malformed submit refused
  and logged, stage moves rate-limited, editors see no approve button.
  **L9, documented, not built:** staff can steer the AI tasks to return other
  JSON by writing instructions into their own brief. Accepted for internal
  staff: writers only, 40 calls an hour per person, token usage logged per
  call. A per-organisation daily budget is the follow-up if the module is
  opened beyond staff or usage grows.
- **Oct 8, 2026, venue phase 4 (plan's venue phase A) built: staff preview.**
  Owner rulings: staff first (anyone who can see the event; the event team,
  who can edit it, also sees everyone's activity and reports and sets the
  language filter); name, dates and venue from EA-SYS; visits recorded now.
  Served at `/e/<slug>/venue` only for slugs in `VENUE_EVENT_SLUGS` (unset =
  nowhere: the rooms are EHC's). EHC 2026 in EA-SYS is `ehc26`, 10 to 12 April
  2026, where the vendor's signs said 4 September. The vendor code runs
  unchanged against `public/venue-runtime.js`, a stand-in for its host runtime
  backed by `/api/venue/<eventId>/*`; AI attendees answer from their
  pre-written lines and live colleagues are off. Tables `VenueActivity` (one
  row per person per event) and `VenueReport` (append-only, emailed to the D7
  inbox), RLS from day one.
  **Gate before attendees are let in:** the privacy notice (UAE PDPL) is
  signed off, because visits are recorded per person. Today only staff can
  reach it. Attendee sign-in is also needed then: only 1 of EHC's 88
  registrants has a login.
- **Oct 8, 2026, Blueprint redesign.** Owner: "not user friendly, no visual
  hierarchy". Two directions were shown side by side (a drafting-table look
  and the dashboard's own); the owner chose the dashboard. Same flow and data:
  the steps are grouped in four phases with a done, part-done or not-started
  mark, the side panel lists what is left with the step each item is in, the
  section header carries a quiet owner and "Talk it through" toolbar, and the
  home page leads with the blueprints. Class names and button text the vendor
  suites use are unchanged, and all six suites pass.
