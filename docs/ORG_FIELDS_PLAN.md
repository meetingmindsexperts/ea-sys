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
| Specialty (and the free text beside it) | Free text | Attendee, Speaker, Contact, AccountProfile, User, Abstract, Event | A list of 45 medical specialties in `src/components/ui/specialty-select.tsx`, used by 22 files. Required at every public door. | One rule: the answer "Others" demands the free text. That rule is written out 10 times. |
| Title | Postgres enum `Title` (Dr, Mr, Mrs, Ms, Prof) | Attendee, Speaker, Contact, AccountProfile | The five values. 43 files name it; `{{title}}` appears 47 times in email code; it prefixes names on badges, certificates and agreements. | Display only. |
| Event topic | Free text `Event.specialty` | Event | The same medical list; the public catalogue's topic pages are keyed `specialty`. | The catalogue groups by it. |
| Presentation type | Postgres enum (Oral, Poster, Oral and Poster, Video, Workshop) | Abstract | The values. An event can only narrow the list. | Required to submit. |
| Credit hours and accrediting body | `Event.cmeHours`, a fixed list of health authorities | Event, certificates | The wording "CME" and the list (DHA, DOH, SCFHS, EACCME, ACCME, Other). | Shown only when set. |

Already flexible, nothing to do: association, member ID, student ID and the
supporting document are switches per registration type; the starting
registration types are an organisation setting; organisation, job title,
dietary needs and address are plain fields.

Not fields, so not in this plan: medical WORDING (placeholders such as
"Interventional Cardiology", "Scientific programme", the default legal texts,
the user guide). That is a separate sweep.

## 3. The obstacle is not size, it is repetition

`docs/ATTENDEE_FIELDS_REFACTOR_PLAN.md` (July 2, 2026, never built) already
found this. There is no one definition of "a person's fields". They are listed
by hand at:

- 9 places that create an attendee, 10 that update one
- 16 callers of the contact sync
- 15 places that write a speaker

When Role was added in July it had to be wired into each by hand, and a missed
one is silent: the answer is simply not saved. Every step below adds or changes
a person field, so that older plan is this plan's step 0.

### 3a. What the contact sync drops today (found Nov 13, 2026)

`syncToContact` can fill 19 optional columns. Its callers each build the
payload by hand, and of about 20 call sites exactly one sends all 19. Some
gaps are right (a speaker has no member ID). These are not:

| Caller | Dropped, although the record it copies from holds them |
|---|---|
| A person's own edit (`registrant-details.ts`, My Details and the event's self-edit) | Role, State, Zip, the free-text specialty, photo, bio |
| Staff edit of a registration (`registration-service.ts`, update) | State, Zip, the free-text specialty |
| Staff edit of a speaker (`speaker-service.ts`, update) | State, Zip, the free-text specialty |
| Registrations CSV import | Role, additional email, photo, the free-text specialty, student ID expiry |
| Adding a reviewer from a speaker | Role, additional email, State, Zip, the free-text specialty |
| Agent tool that updates a speaker | Additional email, State, Zip, the free-text specialty |

The sync only ever fills, never clears, so the effect is a contact that stays
emptier or older than the record it came from, and the contacts feed to
Mailchimp carries that. Step 0b closes it.

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

### Role needs a database change

An organisation's own answers cannot be members of a fixed database list. Two
ways, to be settled by a test on the local database before step 1, not by
opinion:

- **A. A new text column beside the old one** on the four tables, written
  together, the old one kept for rollback. Additive and reversible, which is
  the house rule. Cost: every write site must carry it, which is what step 0
  makes safe.
- **B. Change the column from the fixed list to text in place.** One migration
  and the compiler then points at every site. Risk: the previous image runs
  against the changed column during a deploy and after a rollback; and once an
  organisation adds an answer of its own, an older image cannot read that row
  (the same hazard `docs/ROLLBACK.md` records for the `BASE` role).

Recommended: A, unless the test shows B is clean on the previous image.

## 5. Steps

Sizes are estimates, not measurements.

| Step | What | Changes behaviour? | Size |
|---|---|---|---|
| 0a | BUILT Nov 13, 2026. The one declaration of a person's fields and which of the four records hold each (`src/lib/person-field-contract.ts`). `person-field-contract.test.ts` fails when a column is added to Attendee, Speaker, Contact or AccountProfile and not declared, and holds the three hand-written copy lists (speaker and registration sync, contact sync, the account's details) and the public form's fields against it. | No | Done |
| 0b | The callers of the contact sync stop building its payload by hand (section 3a): one builder per source record, so every caller sends every field the record has. | Yes: fields that were dropped start reaching the contact | Days |
| 0c | The create paths: one all-required input, so a create that does not account for a field fails to compile (`ATTENDEE_FIELDS_REFACTOR_PLAN.md`, phase A). One caller per commit. | No | Days |
| 0d | The update paths, same treatment (phase B of that plan). | No | Days |
| 1a | `person-fields.ts` with today's lists as the default; every door validates through it; the hand-copied role lists and the ten "Others" rules are deleted. | No | Days |
| 1b | Role storage (A or B above). | No for MM Group | Days |
| 1c | The settings screen for labels and answers, the permission key, the audit entries. | Yes, new screen | Days |
| 1d | The event's switches: use, required, order, for Role, Specialty and Title. | Yes | Days |
| 1e | Every outside reader, in the same change (section 6). | No for MM Group | Days |
| 2 | New fields created by the organisation, following the person everywhere (D5). Needs a place to store them on Speaker, Contact and AccountProfile (Attendee has `customFields`, unused today), and the copy sites from step 0 must carry them. Shown on the public forms, the registration sheet, the CSV export. | Yes | 3 to 4 weeks |
| 3 | Later, only when asked: new fields in filters, bulk email segments, badges and email tokens; an organisation's own titles; presentation formats and the credit-hours label per organisation. | Yes | Not sized |

Step 0 plus step 1 is what a second organisation needs to launch: about three
weeks. Step 2 can wait until a tenant asks.

## 6. Who reads these fields outside the forms

Each must be checked in the same change that opens a field up (the rule from
INC-007). For MM Group every one of them must show exactly what it shows today.

| Reader | What it reads | What changes for another organisation |
|---|---|---|
| Registrations CSV (`registration-export.ts`) | Title, Role (as its label), Specialty | The column headings follow the organisation's labels; a field switched off is an empty column or no column (decide in 1e) |
| Shared views (`registration-share.ts`, `submission-share.ts`) | Title, Specialty | The catalogue of shareable fields follows the list |
| Public API and its reference (`openapi-spec.ts`) | Role as a fixed list, Title as a fixed list, Specialty | Role becomes text checked against the organisation's list |
| Agent and MCP tools (`register-mcp-tools.ts`, `tools/registrations.ts`, `tools/speakers.ts`, `tools/contacts.ts`) | Role as a fixed list, typed by hand | The tools take text and the service refuses an unknown answer. Connected clients must reconnect to see the change. |
| Contacts sync to `contacts_centralv1` (`contacts-central-sync.ts`), which feeds Mailchimp through n8n | Role as its LABEL, Title as the raw value, Specialty, event specialty | The label comes from the organisation's list. Master only; a tenant has no such sync. |
| Speakers API read by the n8n Webflow sync | `registrationType`, plus title and specialty if the workflow maps them | To be confirmed from the live workflow; the connector is not authorised here |
| Emails, badges, certificates, speaker agreement | `{{title}}` as a name prefix | Unchanged while Title keeps its five values (step 3 otherwise) |
| Public catalogue and its topic pages | `Event.specialty` | The topic label and list come from the organisation |
| Contact sync between records (`contact-sync.ts`, 16 callers) | All of them | Covered by step 0 |

Not found anywhere: a list filter or a bulk email segment on Role or Specialty.

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
