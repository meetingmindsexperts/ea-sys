# Presentation types the organiser owns

**Status:** IN BUILD (November 24, 2026). Section 6 has the steps; step 1 is built. Sections 2 and 8 hold
the owner's decisions.

**Owner's request:** "give the complete control to organizer on what the list should be and if they want
to add new at one place. 2 things, CRUD presentation type and show which presentation type needed for the
event."

## 1. What is there today

An abstract has a presentation type. The list is fixed at five, as a Postgres enum
(`PresentationType` in `prisma/models/program.prisma`): Oral or Poster, Oral, Poster, Video, Workshop.

- Two columns on `Abstract` hold one: `presentationType` (the organiser's decision) and
  `requestedPresentationType` (what the author asked for). Both are written only through
  `src/lib/abstract-requested-type.ts`.
- Each event already chooses which of the five its form offers:
  `Event.settings.abstractPresentationTypes`, ticked on the event's Content page. With nothing saved, all
  five are offered. Rule: `src/lib/abstract-presentation-types.ts`.
- A reviewer recommends a format. That is a second enum (`RecommendedFormat`: Oral, Poster, Video,
  Workshop, Neither) on `AbstractReviewSubmission.recommendedFormat`, offered per event by
  `src/lib/recommended-formats.ts`.
- Three of the five carry behaviour, by their key:
  - **Oral or Poster** is the author's either-way choice. A reviewer cannot recommend it: it stands for
    Oral and Poster in the reviewer's list.
  - **Poster** decides who gets the poster certificate and its tokens
    (`src/lib/certificates/cert-context.ts`, `email-tokens-resolver.ts`).
  - Oral, Poster, Video and Workshop are what a reviewer may recommend.
- A new type today is a code change: a migration, a label and a list value.

**Production, read November 24, 2026:** 174 abstracts, 171 of them on MEHF2027, which is in review. Only
three types have ever been used: Oral or Poster 94, Poster 54, Oral 25 (one abstract has none). Video and
Workshop have never been chosen. Two events narrowed their list: MEHF2027 (three types) and BIGSKY2027
(Poster only).

## 2. Owner decisions (November 24, 2026)

| | Decision |
|---|---|
| **D1** | **One list per organisation.** Types are managed once and shared by all of the organisation's events. Each event ticks which ones it offers, on the same screen where types are added. |
| **D2** | **The five built-in types can be renamed and switched off, never deleted.** They keep their behaviour (section 1). A type an organiser adds is plain: an author can pick it and a reviewer can recommend it, nothing else. A type in use is retired, never deleted, so no abstract loses its type. |
| **D3** | **The full list editor**, not a longer fixed list. |

## 3. What the organiser gets

One card on the event's Content page, where the ticks are today:

- The organisation's types, each with a tick: **offered on this event**.
- **Add type**: a name. It is ticked on this event at once and is available, unticked, to every other event.
- **Rename** any type, the five built-ins included. Beside each built-in the card says what it does
  ("the author's either-way choice", "gets the poster certificate"), because the behaviour follows the
  type and not its name.
- **Retire** a type: it is offered on no event from then on, and every abstract that holds it keeps it,
  shown as "(no longer offered)". **Restore** undoes it.
- **Delete** a type the organiser added, only while no abstract holds it and no review recommends it.
  Otherwise the card offers Retire.

Rules the card states plainly:

- A rename applies to every event of the organisation, at once, everywhere the type is shown: forms,
  lists, exports, shared views, certificates and emails sent from then on. Emails already sent do not change.
- An event always offers at least one type (the type is required to submit).
- A type added for one event appears on no other event until someone ticks it there.

## 4. Approach

### 4.1 The list: `Organization.settings.presentationTypes`

An ordered array of `{ key, label, retired }`, the five built-ins included, read by one function that
repairs a damaged or missing list (a built-in that is missing is put back; an unknown shape is dropped).
No stored list means the five with today's labels, so nothing changes for anyone until somebody edits.

The same shape and the same reader pattern as Role answers (`src/lib/person-fields.ts`) and sponsor tiers
(`src/lib/sponsor-tiers.ts`). No new table, so no new row policy.

- **Keys.** A built-in keeps its key (`ORAL`, `POSTER`, `ORAL_POSTER`, `VIDEO`, `WORKSHOP`). A new type
  gets a key made once from its name (capitals, digits, underscores; a number is added if it is taken), and
  the key never changes afterwards: a rename changes the label only. `NEITHER` is reserved for the
  reviewer's "Neither".
- **Limits.** 30 types an organisation, 60 characters a name, names unique whatever the case.

### 4.2 The columns: text beside the enum, kept in step by a trigger

An organisation's own type cannot be a member of a Postgres enum. This is the problem Role had, solved on
November 16, 2026 (`prisma/migrations/20261116130000_role_key_text_column`), and the same solution:

- New text columns: `Abstract.presentationTypeKey`, `Abstract.requestedPresentationTypeKey`,
  `AbstractReviewSubmission.recommendedFormatKey`, backfilled from the enum columns.
- In the Prisma schema the NEW column takes the existing field name (`presentationType`, by `@map`) and the
  enum column becomes `presentationTypeLegacy`, which the app never reads or writes. Every reader keeps its
  field name.
- A trigger keeps the two in step for the previous image, which keeps serving during a deploy and for as
  long as a rollback lasts: a write to the enum column is copied to the key; a key that is one of the five
  is copied to the enum; a key that is the organisation's own empties the enum.
- Additive and idempotent: nothing is dropped or renamed. The enum columns and the trigger go in a later
  contract step, trigger first.

### 4.3 The event's ticks: unchanged storage, one rule changed

`Event.settings.abstractPresentationTypes` stays an array of keys. The rule for "what does this event
offer" becomes:

1. the keys ticked on the event, less any that are retired or no longer exist;
2. with nothing ticked or saved: the built-in five that are not retired, as today. **A type the organiser
   added is never offered by default**, only where ticked;
3. never empty: an event whose every ticked type was retired falls back to rule 2.

A clone already copies the ticks.

### 4.4 One rule module

`src/lib/abstract-presentation-types.ts` becomes THE rule for presentation types: the list, a label for a
stored key, what an event offers, whether a door may accept a key, and reading a written name (CSV, the
assistant) back to a key. Today the labels live in at least four places
(`abstract-enums.ts`, `submission-share.ts`, `recommended-formats.ts`, the help chat) and three routes each
carry their own list of five. All of them go through the module.

- The server loads the list by the event's organisation, inside the caller's tenant lane.
- A page is sent the list by its API and never keeps one of its own. An author's screens get it from
  `GET abstracts/my-profile`; the public shared view's route puts the label in each row.
- A door that takes a type (author create and edit, staff edit, bulk set type, set status with a type, CSV
  import, the assistant's tools) asks the module. An abstract may always keep the type it has.

### 4.5 The reviewer's recommended format

A reviewer may recommend any type the event offers, the organiser's own included, plus Neither. Oral or
Poster keeps standing for Oral and Poster. A recommendation already made keeps its value whatever happens
to the type later.

### 4.6 Who may edit

A new permission key, `abstracts.types.manage`, held by whoever holds "Abstract themes"
(`abstracts.themes.manage`) today. The list is the organisation's, so the route sits under
`/api/organization/presentation-types`, as sponsor tiers do. Ticking types for an event stays part of
editing the event, as today.

## 5. Every reader, by group

49 files name the type or the recommended format. Each one is moved in the step named in section 6.

| Group | Files |
|---|---|
| The rule | `abstract-presentation-types.ts`, `recommended-formats.ts`, `abstract-requested-type.ts`, `event-clone-settings.ts`, `event-visibility.ts` |
| Doors that take a type | `api/events/[eventId]/abstracts/route.ts`, `abstracts/[abstractId]/route.ts`, `abstracts/bulk-update/route.ts`, `import/abstracts/route.ts`, `abstracts/[abstractId]/submissions/route.ts`, `api/my-reviews/[eventId]/[abstractId]/route.ts`, `services/abstract-service.ts`, `agent/tools/abstracts.ts`, `agent/register-mcp-tools.ts` |
| Forms and lists | `abstracts/new/page.tsx`, `abstracts/[abstractId]/edit/page.tsx`, `abstracts/page.tsx`, `abstract-enums.ts`, `content/page.tsx`, `my-details/page.tsx`, `my-reviews/[eventId]/[abstractId]/page.tsx`, `bulk-status-dialog.tsx`, `csv-import-dialog.tsx`, `abstract-list-filters.ts`, `abstract-accepted-breakdown.ts`, `hooks/use-api.ts`, `abstracts/my-profile/route.ts` |
| Emails | `abstract-notifications.ts`, `bulk-email.ts`, `presenter-agreement.ts`, `email.ts` (sample), `email-template-registry.ts`, `email-preview/route.ts` |
| Exports and shared views | `submission-docx-export.ts`, `abstract-review-scores-report.ts`, `abstract-coauthors.ts`, `abstract-review.ts`, `submission-share.ts`, `shared/[token]/route.ts`, `submissions-view.tsx` |
| Certificates | `certificates/cert-context.ts`, `certificates/email-tokens-resolver.ts` (stay on the key `POSTER`) |
| Assistant and help | `help-chat/event-facts.ts`, `help-chat/system-prompt.ts` |
| Seeds | `prisma/seed-e2e-docs.ts`, `prisma/seed-e2e-golden.ts` |

**Not readers, same words:** `speaker-presentations.ts`, `speaker-presentation-service.ts` and
`presentation-uploads.tsx` are about the file types of a speaker's uploaded slides.

**Checked:** no raw SQL and no row policy names any of the three columns. **Still to check before step 2:**
anything outside the app that reads an abstract's type (the n8n workflows, saved reports), per the rule
"trace every reader before changing a field".

## 6. Steps

Each step is one change with its own tests, local browser check and one adversarial review. Step 2
changes nothing a user can see; step 1 changed only the wording of the names (section 6).

1. **The list and one label source.** BUILT Nov 24, 2026. The organisation's list (reader, defaults,
   repair), the rule module, and every reader in section 5 taking its label and its offered list from it.
   The list cannot be edited yet, so every event offers what it did. One visible change: the names were
   made one (the short form), so forms say "Oral" where they said "Oral Presentation". A test
   (`presentation-type-names.test.ts`) refuses a name or a list of keys outside the rule module.
2. **Text columns.** The migration (three columns, the trigger, the backfill), the Prisma mapping, and the
   doors validating by the rule in place of the enum. Still only five keys can exist. Rehearsed on the
   local copy of production: the count of abstracts by type must be the same before and after, and the
   trigger is tried in both directions.
3. **The editor.** The route and its permission key, and the card on the Content page: add, rename, retire,
   restore, delete, tick. From here an organiser's own type can be chosen by an author and set by staff.
4. **The reviewer's recommendation** takes the organiser's own types.
5. **The edges.** CSV import and the assistant read a written name; the assistant's tool descriptions and
   the help chat describe the list as the event's, not five fixed values; the user guide, `docs/ROLLBACK.md`
   and `CLAUDE.md`; a browser spec that adds a type, submits with it, reviews it and decides it.

Rough size: steps 1 and 2 are the bulk (about a day each with review), 3 about a day, 4 and 5 about half a
day each.

## 7. Foot guns

- **MEHF2027 is mid-review** with 171 abstracts. Steps 1 and 2 must change nothing it shows. The step 2
  rehearsal on the local copy is not optional.
- **Rollback.** An older image reads only the enum column. After step 3, an abstract on an organiser's own
  type shows no type to an older image, and a save from that image's edit form would write none back.
  `docs/ROLLBACK.md` gets the note, as it has for Role.
- **A database built by `prisma db push`** (the tenancy and integration harnesses) has the columns and not
  the trigger. Nothing in the new image may rely on the trigger.
- **Behaviour follows the key, not the name.** Rename Poster to "E-poster" and it still gets the poster
  certificate; add a new type called "Poster" and it does not. The card says so beside each built-in.
- **A rename is organisation-wide and immediate.** Renaming a type after decisions are announced changes
  what later emails and exports call it.
- **The assistant's tool list is cached by connected clients.** A deploy that changes a tool's description
  needs the usual reconnect note.
- **Three routes carry their own list of five today.** Any one left behind refuses an organiser's own type
  with a validation error. The step 1 test is what catches it.

## 8. Questions answered (owner, November 24, 2026)

The owner took the recommendation on each ("1, 3, 4, 5: your recommendations. 2: sure, proceed").

| | Decision |
|---|---|
| **D4** | **No reordering.** Built-ins first, then the organisation's own in the order added. |
| **D5** | **A new permission key**, `abstracts.types.manage`, given to whoever holds "Abstract themes" today (section 4.6). |
| **D6** | **An organiser's own type never gets the poster certificate and is never an either-way choice.** If a second kind of poster is wanted later, the behaviours become switches on a type. |
| **D7** | **Step 3 is released when it is ready**, not held for MEHF2027's decisions. |
| **D8** | **A built-in may be retired for the whole organisation**, the same as any type. |
