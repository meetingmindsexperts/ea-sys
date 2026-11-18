# Session roles an organisation can edit: PLAN (Nov 18, 2026), BUILT

**Status:** the owner accepted the six recommendations in section 6 on Nov 18,
2026 ("proceed building"). Step 1 built Nov 18 (`src/lib/session-roles.ts`,
pinned by `session-roles-ratchet.test.ts`). Step 2 built Nov 18, with one change
from section 3: the list is kept in `Organization.settings.sessionRoles` and an
assignment stores an added role's key in `SessionSpeaker.customRoleKey`, the way
sponsor tiers and person fields are kept, instead of a new table (no new row
policy, same deploy safety; `src/services/session-role-service.ts`,
`/api/organization/session-roles`). Steps 3 to 6 built Nov 18: the Settings card and
the event's choice (`Event.settings.hiddenSessionRoles`, the roles an event turns
off), every picker and badge, the Communications audiences by role and by duty,
and the agent taking a role by name (an unknown name is refused, it used to become
SPEAKER). The archive export keeps a built-in's code and names an added role. The
CSV import is unchanged (D6). Step 7 built Nov 18: `e2e/session-roles.spec.ts` (an admin adds a
Host and hides Panelist; the picker and the public agenda follow; an event turns a
role off and only new rows lose it). The rollback rehearsal is covered by design: an
older image reads the enum, which holds the duty's built-in.

**Ask (owner, Nov 18, 2026):** the agenda's session roles are fixed at Moderator,
Chairperson, Panelist and Speaker. An organiser should be able to add, rename and
remove roles, so that a tech conference can have a Host or an MC. The speaker
emails must keep working: "for our system we need moderator and presentation
details".

## 1. The idea in one paragraph

Every role, built in or added, has one of two **duties**: it **runs** the session
or it **presents** in it. The duty is what the system acts on; the name is only
what people read. Moderator and Chairperson run; Speaker and Panelist present. A
tech conference adds "Host" (runs) and "Keynote" (presents). The emails do not
change shape: **Your Moderation Details** lists every session the person holds a
*running* role in, and **Your Presentation Details** lists every session they hold
a *presenting* role in, plus the topics they present. A Host gets the run-sheet
exactly as a Moderator does today.

## 2. What the roles drive today (traced Nov 18, 2026)

Production holds 270 session assignments: Speaker 163, Moderator 83, Chairperson
24, Panelist 0. The role is the Prisma enum `SessionRole` on `SessionSpeaker.role`.

| Where | What it does with the role | Kind |
|---|---|---|
| `src/lib/speaker-agreement.ts` | `{{moderatorDetails}}` = Moderator or Chairperson sessions; `{{presentationDetails}}` = the rest plus topics; the `{role}` docx token is the joined labels | **behaviour** |
| `src/lib/email-preview-data.ts` | the preview's sample moderator = someone who is Moderator or Chairperson | **behaviour** |
| Communications page + `src/lib/bulk-email.ts` + `bulk-email-dialog.tsx` | "Moderators" and "Chairpersons" audiences; `sessionRole` filter validated against the enum | **behaviour** |
| `import/sessions/route.ts` | CSV columns `moderatorEmails`, `chairEmails` | **behaviour** |
| `src/services/session-service.ts` | the role list it accepts; one role per person per session | **behaviour** |
| Agent (`tools/sessions.ts`, `register-mcp-tools.ts`), `openapi-spec.ts` | role validated against the four values | **behaviour** |
| Agenda dialog, detail panel, speaker page | the picker (`SESSION_ROLE_OPTIONS`) | label |
| Public agenda, public session page, webinar panelists card, speaker page | the badge (`formatSessionRole`, `SESSION_ROLE_COLORS`) | label |

Zoom panelist sync and certificates do not look at the role.

## 3. How it is stored (recommended)

**A list table, and a pointer beside the enum, not a replacement of it.**

- New table `SessionRoleDefinition`: `id`, `organizationId`, `name`, `duty`
  (`RUNS` | `PRESENTS`, text), `builtIn` (the enum value for the four built-ins,
  null for an added role), `sortOrder`, `archivedAt`. Row policy from day one, like
  every new table. The four built-ins are created for an organisation the first
  time its list is read.
- `SessionSpeaker` gets a nullable `roleDefinitionId`. The existing `role` enum
  column **stays and is always written**: a built-in's own value, and for an added
  role the built-in of its duty (Moderator for *runs*, Speaker for *presents*).
- **Why not turn the enum into text** (as Role on people did, Nov 16): this way the
  migration is one additive column and one table, and an image from before it (a
  blue-green deploy, or a rollback) still reads a valid role with the right duty: a
  Host shows as "Moderator" and still gets the run-sheet. Nothing breaks while two
  images run.
- **One rule module**, `src/lib/session-roles.ts`: `roleDuty(assignment)`,
  `runsSession(assignment)`, `roleLabel(assignment, list)`. Every email, filter
  and badge asks it. **Never compare `role === "MODERATOR"` again**: a test lists
  the files that do, as other rules in this codebase are pinned.

## 4. What the organiser sees

- **Settings, Session roles** (organisation): the list with name and duty. Add a
  role, rename any role, change its order, hide it. A built-in can be renamed and
  hidden, never deleted. An added role can be deleted only while nobody holds it;
  after that it can be hidden (the people who hold it keep it).
- **Event settings, Agenda**: which roles this event offers (all by default), so a
  medical meeting never shows "Host" and a tech conference never shows
  "Chairperson". The organisation's list is the ceiling, as for person fields.
- The pickers in the session dialog, the detail panel and the speaker page offer
  the event's roles; every badge shows the role's name.
- **Communications**: one audience per role the event uses, plus "Everyone who
  runs a session" and "Everyone who presents".

## 5. Order of work

Each step ships on its own, behind the full gate, with tests alongside.

0. This plan and the owner's decisions (section 6).
1. **The rule module, no behaviour change.** Replace every `MODERATOR` /
   `CHAIRPERSON` comparison with `runsSession()` over the enum, and pin it.
2. **Table and column.** Migration (additive, idempotent), the built-ins created per
   organisation, the service writing `roleDefinitionId` plus the derived enum, the
   one-role-per-person rule unchanged.
3. **Settings pages.** The organisation's list and the event's choice.
4. **Pickers and badges** everywhere in section 2's label rows, the docx `{role}`
   token and the agenda export.
5. **Emails and audiences.** `{{moderatorDetails}}` and `{{presentationDetails}}` by
   duty, the preview sample, the Communications audiences and the bulk email filter
   (by role and by duty).
6. **Agent, public API, CSV import.** The agent takes a role by name (this changes
   the MCP tool list: every connected client must reconnect); the import keeps its
   two columns and gains a generic one only if asked.
7. **Proof.** Browser tests; a rendered email for an added *runs* role (a Host gets
   the run-sheet); a rehearsal of a rollback to the image before step 2.

Rough size: three to four working days, most of it in steps 4 and 5.

## 6. Decisions (accepted by the owner, Nov 18, 2026)

| # | Question | Decision |
|---|---|---|
| D1 | Where does the list live? | The organisation, with each event choosing from it |
| D2 | Can a role's duty change after people hold it? | No: only while unused. Changing it would silently move those people between the two email blocks |
| D3 | Delete or hide? | Built-ins: rename and hide only. Added roles: delete while unused, hide after |
| D4 | Do the email headings follow the role names? | No: keep "Your Moderation Details" and "Your Presentation Details" fixed; every running role gets the first, every presenting role the second |
| D5 | Who may edit the list? | Organisation admins (Settings); organisers choose per event |
| D6 | CSV import | Keep `moderatorEmails` and `chairEmails`; add a "role name, email" column later only if an import needs it |
