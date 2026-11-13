# Person fields owned by the organisation

> Status: **IN BUILD.** Written Nov 13, 2026; the owner said to proceed with
> step 0 the same day. Step 0a is built (the declaration and its tests).
> Why now: preparation for multi-tenancy (owner, Nov 13, 2026). No event is
> waiting on it. A second organisation on the platform cannot launch while
> every form demands a medical profession and a medical specialty.
> An independent review of this plan against the code is run on step 0a's
> commit, before step 0b.

## 1. What the owner decided (Nov 13, 2026)

| # | Decision |
|---|---|
| D1 | The ORGANISATION holds the fields and their answer lists. An event reads them: it uses a field or does not, and says whether it is required. An event never defines a field of its own. |
| D2 | Role and Specialty stay for every industry. What differs between organisations is the label and the list of answers. Example given: a tech organisation still asks Role and Specialty, with its own answers. |
| D3 | An organisation may switch a field off entirely (an education organisation may not want Specialty). |
| D4 | Admins AND organisers may create and edit fields and answer lists. Not admins only. |
| D5 | A field the organisation has follows the person everywhere: registration, speaker, contact and account. Not the registration alone. |
| D6 | "Add a new field" is reachable from the event's form settings and saves into the organisation's list, so there is one list. |
| D7 | A starter set (Medical, Technology, Education, General) is offered when an organisation is set up, and is OPTIONAL: "even if they dont it is fine, because some small event agency does all industries events". |
| D8 | Title is on or off only, for now. |
| D9 | The event's topic uses the same list as the person's Specialty. |

Follows from D1 and D6, not yet said by the owner in these words: required or
not, and the order on the form, are the event's choice.

## 2. The fields that are medical today

Read from `prisma/models/` and the code on Nov 13, 2026.

| Field | How it is stored | Where | What is fixed in source | Used in a rule? |
|---|---|---|---|---|
| Role | Postgres enum `AttendeeRole`, 9 values (Academia, Allied Health, Medical Devices, Pharma, Physician, Resident, Speaker, Student, Others) | Attendee, Speaker, Contact, AccountProfile | The values, and the label "Others (Spouse)". Required at every public door. The list is typed out by hand in 7 files (`schemas.ts`, two services, two agent tool files, `register-mcp-tools.ts`, `openapi-spec.ts`). 39 files name it. | No. Nothing compares a role to a value. It is a label and nothing else, which is what makes it safe to open up. |
| Specialty (and the free text beside it) | Free text | Attendee, Speaker, Contact, AccountProfile, User, Abstract, Event | A list of 45 medical specialties in `src/components/ui/specialty-select.tsx`, used by 22 files. Required at every public door. | One rule: the answer "Others" demands the free text. That rule is written out at 7 server sites and 8 client sites, and one door (the event's self-edit) has none. |
| Title | Postgres enum `Title` (Dr, Mr, Mrs, Ms, Prof) | Attendee, Speaker, Contact, AccountProfile | The five values. 43 files name it; `{{title}}` appears 47 times in email code; it prefixes names on badges, certificates and agreements. | Display only. |
| Event topic | Free text `Event.specialty` | Event | The same medical list; the public catalogue's topic pages are keyed `specialty`. | The catalogue groups by it. |
| Presentation type | Postgres enum (Oral, Poster, Oral and Poster, Video, Workshop) | Abstract | The values. An event can only narrow the list. | Required to submit. |
| Credit hours and accrediting body | `Event.cmeHours`, a fixed list of health authorities | Event, certificates | The wording "CME" and the list (DHA, DOH, SCFHS, EACCME, ACCME, Other). | Shown only when set. |

Already flexible, nothing to do: association, member ID, student ID and the
supporting document are switches per registration type; the starting
registration types are an organisation setting (one leftover: the "seed
defaults" button on the Registration Types page still offers the medical five,
`tickets/page.tsx`); organisation, job title, dietary needs and address are
plain fields.

Role and Specialty are also required by two rules that are not form
validators, and both must go through the one refusal function or an
organisation that switches Specialty off (D3) locks its own people out:

- `submitter-profile-completeness.ts` demands both before an abstract or a
  session proposal can be submitted (four routes answer 403
  `PROFILE_INCOMPLETE`).
- `missingRequiredDetails` in `registrant-details.ts`, used by sign-up and by
  My Details.

`User.specialty` is a seventh place the answer is stored, written by sign-up,
My Details and the registrant account.

Not fields, so not in this plan: medical WORDING (placeholders such as
"Interventional Cardiology", "Scientific programme", the default legal texts,
the user guide). That is a separate sweep.

## 3. The obstacle is not size, it is repetition

`docs/ATTENDEE_FIELDS_REFACTOR_PLAN.md` (July 2, 2026, never built) already
found this. There is no one definition of "a person's fields". They are listed
by hand at:

- 9 places that create an attendee, 10 that update one
- 19 calls of the contact sync, in 15 files
- 15 places that write a speaker

When Role was added in July it had to be wired into each by hand, and a missed
one is silent: the answer is simply not saved. Every step below adds or changes
a person field, so that older plan is this plan's step 0.

### 3a. What the contact sync drops today (found Nov 13, 2026)

`syncToContact` can fill 19 optional columns. Its callers each build the
payload by hand, and of 19 calls exactly one sends all 19 (staff creating a
registration). Some gaps are right. These are not (table corrected by the
review of Nov 13):

| Caller | Dropped, although the record it copies from holds them |
|---|---|
| A person's own edit (`registrant-details.ts`, My Details and the event's self-edit) | Role, State, Zip, the free-text specialty, photo, bio |
| Staff edit of a registration (`registration-service.ts`, update) | State, Zip, the free-text specialty |
| Staff edit of a speaker (`speaker-service.ts`, update) | State, Zip, the free-text specialty |
| Registrations CSV import | Role |
| Speakers CSV import | Additional email, State, Zip |
| Complete registration (the public completion form) | Additional email |
| Adding a reviewer from a speaker | Role, additional email, State, Zip, the free-text specialty |
| Agent tool that creates speakers in bulk | Additional email, State, Zip |
| The speaker's own profile form (bio, photo) | Everything: it never calls the sync at all |

Gaps that are deliberate and must stay:

- A speaker's `registrationType` reaches the contact only through
  `contactCategoryOf` (`faculty-filter.ts`): "Faculty" must never overwrite a
  contact's category, which feeds `registration_type` in `contacts_centralv1`
  and from there Mailchimp. Five callers apply it; the public submitter door
  does not, which is an existing gap.
- `verify-details` sends only the evidence fields it changed.

Two rules the builders hold (review of `eb435b61`, Nov 13):

- **A contact's category is never read off a row.** The attendee builder takes
  it as a required argument: the type's name for a delegate, null for the
  Faculty type or when the write does not decide the type. Staff creating a
  registration already does this by hand (`asFaculty ? null : type name`);
  staff editing one, and the old self-edit, sent the row's own value, which on
  a Faculty registration is "Faculty".
- **An edit sends only what it changed.** The sync replaces a value with any
  other non-blank value, so re-sending a whole row puts its old photo, bio or
  phone over a newer one that reached the contact from another event. A row
  just created sends everything.
- A contact's tags are its own; event tags are not copied onto it.

The sync only ever fills, never clears, so the effect is a contact that stays
emptier or older than the record it came from, and the contacts feed to
Mailchimp carries that. Step 0b closes it.

### 3b. The callers still to move, and how (review of `831549cc`, Nov 13)

All moved by the end of Nov 13, 2026 (the tables below are kept as the record
of how each had to move). The speaker builder gained what the attendee builder
has: `only`, and the category said only when the write decides it. After the
review of the staff group, `only` no longer means "send nothing else": the
rest of the row is sent as fill-only.

Fresh rows, safe to move as they are:

| Caller | What moving it changes |
|---|---|
| `registration-service.ts` create | Nothing; it already sends everything. Keep `asFaculty ? null : type name` as the category. |
| `speaker-service.ts` create | Nothing. |
| `agent/tools/speakers.ts` bulk create | Adds additional email, State, Zip. |
| `agent/tools/registrations.ts` bulk create | Nothing; the transaction must hand the row out. |
| `group-registration-service.ts`, two calls | Rows must be carried out of the transaction. To check first: can a group member be on a Faculty type. |

WRONG if moved mechanically, because the row can hold older values than the
contact, or the difference is deliberate:

| Caller | How it must move |
|---|---|
| Public register | The attendee may be a reused row holding an old photo and bio: `only` = the form's fields. |
| Complete registration | An edit of an existing row: `only`; adds the additional email it drops today. Category null unless this request picked a type. |
| Public submitter door | The upsert overwrites an existing speaker: build from the submitted profile, not the row. This also adds the missing `contactCategoryOf`. |
| `verify-details` | Deliberate: it sends the submitted evidence values while the row write is fill-if-empty. Leave by hand. |
| Adding a reviewer from a speaker | Neither a create nor an edit. Decide whether it should send more than the name and the event. |
| A submitter's own profile (`abstracts/my-profile`) | A self-edit: `only` = what was touched, no category. |
| `speaker-service.ts` update | Sends the whole row on every edit, a status change included: `only` from the computed delta. |
| `registration-service.ts` update | The row after the update, `only` = the patch's keys, category null unless the type changed. This ends "Faculty" as a contact's category from a staff edit. |

Left as it is: adding a reviewer by email (name and email only; no row behind
it).

Size on production (Nov 13, 2026, read-only): 57,835 contacts, 6,323 of them
with a registration, and 2,667 of those hold no Role although their
registration does. State is missing on 1 and Zip on 4. Step 0b stops new gaps;
it does not fill these. Owner, Nov 13, 2026: no bulk fill; it blocks nothing.
They fill as people are re-imported or edit their own details.

### 3c. The create sites and what each leaves out (scan of Nov 13, 2026)

The inventory for step 0c. A blank is right where the source has no such
value (a CSV with no photo column); it is a gap where the source record holds
it.

| Site | Record | Leaves out |
|---|---|---|
| `registration-service.ts` create | attendee | Nothing |
| `speaker-service.ts` create | speaker | Nothing |
| Public register | attendee | Photo, bio, tags (the form has none) |
| Registrations CSV import | attendee | Additional email, photo, typed-in specialty, student ID expiry (no columns) |
| EventsAir import | attendee | Everything EventsAir does not give: title, role, State, Zip, specialty and the rest |
| Group registration | attendee | Photo, bio, tags, dietary needs, association, member and student IDs |
| Registrations from contacts | attendee | The type, dietary needs |
| A speaker's companion registration (`speaker-companion.ts`) | attendee | **Bio and the typed-in specialty, which the speaker holds**; and the type and tags, on purpose |
| Speaker from a registration (`speaker-companion.ts`) | speaker | **Photo and bio, which the attendee holds**; tags, website |
| Event clone | speaker | **Role, additional email, State, Zip, typed-in specialty, which the source speaker holds** |
| Agent bulk create (speakers) | speaker | Typed-in specialty, website, social links |
| Contacts page create | contact | Additional email, State, Zip, typed-in specialty |
| Agent create contact | contact | Most fields |

The three in bold are real gaps: a record made from another record that does
not carry what the source holds.

## 4. Design

One module decides, and every form, validator, table, export and tool asks it.
Working name `src/lib/person-fields.ts`, client-safe, no database import.

- **The organisation's list** lives in `Organization.settings.personFields`.
  For each field: on or off, its label, its answers (each with a key that
  never changes, a label, and a retired flag), and whether "Other" with free
  text is allowed.
- **Nothing saved means today's form.** With no setting, the module returns
  the current lists exactly, so the deploy changes nothing for MM Group and is
  reversible. (The same approach as `default-registration-types.ts`.)
- **The event's choice** extends the existing `Event.settings.formFields`
  (`src/lib/registration-form-fields.ts`, which today hides State, Zip and
  Dietary): use the field or not, required or not, order.
- **One refusal function** replaces the static "Specialty is required" rules:
  every door asks it with the organisation's list and the event's choice. A
  test lists every door, as `reserved-type-name.test.ts` does, so a new door
  fails until it is added.
- **Stored values.** MM Group's role keys are the current enum values
  (`PHYSICIAN` and so on), so the API, the CSV, the Webflow sync and the
  contacts sync show no difference. A new answer gets its key once, when it is
  created. Specialty keeps storing its text, as today.
- **Answers are retired, never deleted, once used.** A field is archived, never
  deleted, once it holds answers. Every change is in the audit log with who
  made it.
- **Permission.** A new key, working name `formFields.manage`, held by admins
  and organisers by default and tickable on a custom role. The precedent is the
  sponsor tier list: organisation-wide, edited under `sponsors.manage`, not
  under `org.settings`. Reading the list needs no key beyond seeing the event.
- **Accounts.** `/signup` and My Details belong to no event, so they read the
  organisation's list by host, as `public-brand-server.ts` does. Accounts are
  per organisation on the platform (PLATFORM_DECISIONS §6), so an account sees
  one organisation's lists.

### Rules the review of Nov 13 added

- **A stored answer that is no longer on the list stays valid.** Specialty has
  never been checked against its list on the server: every door takes any
  text, and the contacts hold about 70 different specialties against a list of
  45. So the refusal function refuses only a NEWLY chosen answer that is not on
  the list; an unchanged old or retired value is kept; imports and staff doors
  keep taking free text.
- **A Specialty answer's text is never edited once used.** Specialty stores
  its text, not a key, and the public topic addresses are built from it. To
  change one, retire it and add another.
- **Doors with no event** (`/signup`, My Details) have no event to say what is
  used or required. They ask every field the organisation has switched on,
  required as the organisation's default says. Today's rule that an account
  "always holds what a registration would need" becomes "what the
  organisation's default asks".
- **A new organisation with nothing saved must not get the medical form.**
  "Nothing saved means today's form" is the rule for master only. On the
  platform, creating an organisation writes the starter set it picked, or the
  General set when it picked none (D7). This cannot be a migration.
- **The event's choice applies to every door,** not only the attendee forms
  that read `formFields` today: group register, the presenter doors, the desk
  walk-in.

### Role needs a database change

An organisation's own answers cannot be members of a fixed database list.
Three ways. The review read the deploy path and the CI gates; nothing below
has been run against a database yet, and step 1b starts with that test.

- **A. A new text column beside the old one, written together.** Passes the
  migration gate. Weakness: the previous image knows only the old column, so
  rows it writes during a deploy or after a rollback leave the new one empty
  or stale, and "written together" depends on every write site, including the
  ones that pass a role inside a larger object.
- **B. Change the column to text in place.** Not available as planned:
  `scripts/check-migration-safety.sh` fails CI on `ALTER COLUMN TYPE` unless it
  is acknowledged as destructive, because the old slot runs against the changed
  column for the health-check window and for as long as a rollback lasts. If
  the database list were also dropped, every write from the old image that
  carries a role would fail, and Role is required at every public door.
- **C. Recommended. A new text column, with the names swapped in Prisma and a
  small database trigger keeping the two in step.** The database change is
  additive (new column, backfilled). In the schema the new column takes the
  name `role` and the old one becomes `roleLegacy`, both by `@map`, which the
  schema already does elsewhere. A trigger copies old to new for writes from
  an old image, and new to old only when the answer is one of the nine, else
  empty. The compiler then points at every site (B's benefit), the migration
  passes the gate (A's benefit), no site writes twice, and an older image reads
  an empty role for a tenant's own answer and does not fail. Costs: it is the
  first trigger in the migration chain; a database built by `db push` (the
  tenancy test setup) has no trigger, so the new image must read and write the
  new column only; raw SQL must use the physical column name.

Until 1b is live, a role that is not one of the nine makes the contact sync
fail for that person, and only a warning says so. No door may accept such a
role before 1b.

## 5. Steps

Sizes are estimates, not measurements.

| Step | What | Changes behaviour? | Size |
|---|---|---|---|
| 0a | BUILT Nov 13, 2026. The one declaration of a person's fields and which of the four records hold each (`src/lib/person-field-contract.ts`). `person-field-contract.test.ts` fails when a column is added to Attendee, Speaker, Contact or AccountProfile and not declared, and holds the three hand-written copy lists (speaker and registration sync, contact sync, the account's details) and the public form's fields against it. | No | Done |
| 0b | BUILT Nov 13, 2026. No caller of the contact sync types its payload by hand: each builds it with `contactSyncFromAttendee`, `contactSyncFromSpeaker` or `contactSyncFromSpeakerInput` (`src/lib/contact-sync-payload.ts`), typed so that a row with fewer columns does not compile. Rules the builders and the sync hold: the category is said by the caller and is never "Faculty"; an edit replaces the fields whose value it changed and sends the rest of the row as fill-only (`fillBlanks`: written only where the contact's column is empty); a contact that does not exist is created with the whole row. `contact-sync-callers.test.ts` fails on a new hand-written payload. By hand on purpose: the evidence form (`verify-details`) and adding a reviewer (name and event only). | Yes: fields that were dropped reach the contact, and an old row no longer overwrites a newer contact | Done |
| 0c | NOT BUILT, and needed for step 2, not for step 1. The create paths: one all-required input, so a create that does not account for a field fails to compile (`ATTENDEE_FIELDS_REFACTOR_PLAN.md`, phase A). One caller per commit. A scan of Nov 13 (section 3c) lists every create site and what it leaves out. A test that reads the source instead was tried and dropped: half the sites build their data through a variable or a map, which a pattern cannot follow reliably. | No | Days |
| 0d | NOT BUILT, same standing as 0c. The update paths (phase B of that plan). | No | Days |
| 1a | STARTED Nov 13, 2026. Built: `src/lib/person-fields.ts`, which reads `Organization.settings.personFields` (for Title, Role and Specialty: asked or not, label, answers with a key that never changes, retired answers, "Others") and returns today's lists when nothing is saved; the specialty and title pickers take their default answers from it, so there is one copy of each list (`person-fields.test.ts` writes the 45 specialties out and holds the module to them). Still to do in 1a: every door, and the two rules in section 2 that are not forms, ask one refusal function; the hand-copied role lists and the scattered "Others" rules are deleted. No new check on a stored value (section 4). | No | Days |
| 1b | Role storage (C in section 4), starting with the test of the previous image against the changed database. `docs/ROLLBACK.md` gets its entry. | No for MM Group | Days |
| 1c | Every outside reader (section 6) reads the organisation's list. BEFORE any screen can add an answer: an answer added while a reader still holds the fixed list is refused by the Contacts filter, blanked by three CSV imports, sent as a raw key to the exports and to `contacts_centralv1`, and refused by the agent tools and the API. | No for MM Group | Days |
| 1d | The settings screen for labels and answers, the permission key (it will need the grants snapshot test, the roles document test and `check-permission-guards.sh` updated), the audit entries. Written through `updateOrganizationSettings`, read through a projection as `public-brand-server.ts` does. `docs/ROLLBACK.md` gets its entry. | Yes, new screen | Days |
| 1e | The event's switches: use, required, order, for Role, Specialty and Title, on every door. | Yes | Days |
| 2 | New fields created by the organisation, following the person everywhere (D5). Needs a place to store them on Speaker, Contact and AccountProfile (Attendee has `customFields`; the staff API can write it, and on production 0 of 7,496 attendees hold anything in it, counted Nov 13, 2026), and the copy sites from step 0 must carry them. Shown on the public forms, the registration sheet, the CSV export. | Yes | 3 to 4 weeks |
| 3 | Later, only when asked: new fields in filters, bulk email segments, badges and email tokens; an organisation's own titles; presentation formats and the credit-hours label per organisation. | Yes | Not sized |

Steps 0a, 0b and step 1 are what a second organisation needs to launch. Steps
0c and 0d guard the day a NEW column is added to a person, which is step 2;
step 1's one new column (Role as text, section 4) is found by the compiler,
because its type changes at every site. Step 2 can wait until a tenant asks.

## 6. Who reads these fields outside the forms

Each must read the organisation's list before a screen can add an answer (step
1c; the rule from INC-007). For MM Group every one of them must show exactly
what it shows today. The review of Nov 13 added most of the second half.

| Reader | What it reads | What changes for another organisation |
|---|---|---|
| Registrations CSV (`registration-export.ts`) | Title, Role (as its label), Specialty | The column headings follow the organisation's labels; a field switched off is an empty column or no column (decide in 1c) |
| Contacts CSV (`contact-export.ts`) | Title, Role, Specialty and its free text | Same |
| Event workbook (`event-export/sheets.ts`) | The event's topic; each speaker's specialty | Same |
| Contacts page filters and the contacts export that uses them (`contact-filters.ts`, `contacts/filter-options`) | Role checked against the FIXED list, Specialty | The filter offers and accepts the organisation's answers |
| CSV imports that read Role by its label (registrations, speakers, contacts) and their templates | Role | The label is looked up in the organisation's list |
| `scripts/import-contacts-central.ts` | A central label mapped back to a role key | Master only |
| Shared views (`registration-share.ts`, `submission-share.ts`) | Title, Specialty, the "Others" rule | The catalogue of shareable fields follows the list |
| Public API and its reference (`openapi-spec.ts`) | Role as a fixed list, Title as a fixed list, Specialty | Role becomes text checked against the organisation's list |
| Agent and MCP tools (`register-mcp-tools.ts`, `tools/registrations.ts`, `tools/speakers.ts`; `tools/contacts.ts` takes title and specialty only; `tools/events.ts` and `tools/abstracts.ts` read specialty; the system prompt names the field) | Role as a fixed list, typed by hand | The tools take text and the service refuses an unknown answer. Connected clients must reconnect to see the change. |
| Contacts sync to `contacts_centralv1` (`contacts-central-sync.ts`), which feeds Mailchimp through n8n | Role as its LABEL, Title as the raw value, Specialty with the "Others" rule, the event's topic | The label comes from the organisation's list. Master only; a tenant has no such sync. |
| Speakers API read by the n8n Webflow sync | `registrationType`, plus title and specialty if the workflow maps them | To be confirmed from the live workflow; the connector is not authorised here |
| Emails, badges, certificates, speaker agreement | `{{title}}` as a name prefix | Unchanged while Title keeps its five values (step 3 otherwise) |
| The event's topic: catalogue and topic pages, `seo.ts`, the event overview, `llms.txt`, the sitemap, the header's event search, the venue assistant's prompt, field permissions | `Event.specialty` | The topic label and list come from the organisation |
| Prefill and suggestions (`own-details-sources.ts`, `submitter-profile-suggestions.ts`) | Role, Specialty | Follow the list |
| Copies between records (`contact-sync.ts`, `person-details-sync.ts`, `email-change.ts`) | All of them | Covered by step 0 |

No bulk email segment on Role or Specialty exists. No badge, certificate,
email or analytics rule branches on a role value.

## 7. Left out on purpose

- Questions that appear only when another answer is given.
- Different questions per registration type.
- An event defining its own field (D1).
- Relabelling a stored answer so that one value means two things in two
  places. A new answer is a new key.

## 8. Still open

| # | Question | Recommendation |
|---|---|---|
| O4 | An agency that runs every industry under one organisation (D7) has ONE Role list and ONE Specialty list for all its events, because an event only uses a field or not (D1). Is that enough, or should an event later be able to pick which answers it offers? | Enough for now; "an event narrows the answers" is a small later addition and the abstract presentation types already work that way |

Answered on Nov 13, 2026 and moved to section 1: the starter set (D7), Title
(D8), the event's topic (D9), and when step 0 starts (now).

## 9. The review of Nov 13, 2026

An independent review of this plan and of step 0a's commit (`78a0b8a6`),
against the code. Six HIGH and eleven MED on the plan, all taken into the
sections above: the database options (section 4), readers before the settings
screen (section 5), the two required rules that are not forms (section 2), the
contact category rule (3a and step 0b), the corrected 3a table, the readers
the first table missed and the false "no filter on Role" claim (section 6),
and the four rules at the top of section 4. On the commit: no HIGH, four MED,
fixed in the commit that follows it.

Other hand-written lists of person fields the test does not hold yet, in the
order to bring them under the declaration:

1. `email-change.ts` `MERGE_SCALAR_FIELDS`, an exact twin of the contact
   sync's list.
2. The 19 contact sync payloads (step 0b).
3. Records made from one another: `speaker-companion.ts`, the two
   `import-registrations` and `import-contacts` routes, `grant-companion`,
   `presenter-registration.ts`, `presenter-signup.ts`, the event clone.
4. Create and update inputs in the registration, speaker and group services,
   the agent tools, the public doors and the CSV imports (steps 0c and 0d).
5. Exports and outside readers (step 1c).
