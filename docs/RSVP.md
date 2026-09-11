# RSVP (customizable)

> An event runs **any number of independent RSVPs** — a gala dinner, a set of
> parallel workshops, a site visit. Each one owns its **own options** and its
> **own guest list**, and every invitee gets a **personalized link**. Reached
> from **Event → Setup → RSVPs**.
>
> Was "Dinner RSVP" (July 2026). Generalized **August 14, 2026** — plan and
> decisions in [CUSTOMIZABLE_RSVP_PLAN.md](CUSTOMIZABLE_RSVP_PLAN.md).

## The model

```
Event ──< RsvpCampaign ──< RsvpItem        ("Gala Dinner", "Workshop A")
                       └──< RsvpInvite ──< RsvpResponse
```

- **`RsvpCampaign`** — one RSVP. `name`, `description?`, `selectionMode`
  (SINGLE / MULTI), `allowGuests`, `collectDietary`, `isActive`, `sortOrder`.
- **`RsvpItem`** — one thing to say yes to: `name`, `startsAt`, `location?`,
  `description?`, `rsvpDeadline?`, `sortOrder`, `isActive`.
- **`RsvpInvite`** — one invited person **per campaign**: unique `token`,
  `inviteeName`, `inviteeEmail`, soft refs `registrationId?`/`speakerId?`,
  `dietary?`, `status` (`PENDING` → `RESPONDED`), `respondedAt?`.
  **`@@unique([campaignId, inviteeEmail])`.**
- **`RsvpResponse`** — the per-item answer: `attending`, `guestCount`.
  `@@unique([inviteId, itemId])`.

### The load-bearing line

`RsvpInvite` used to be **event-level** (`@@unique([eventId, inviteeEmail])`)
with one token covering every dinner on the event. That made a second audience
impossible: adding someone to a workshop list collided with their dinner invite,
and reusing the invite would have shown the workshop audience the VIP dinner
list. Moving the key to the **campaign** is the whole feature.

### Physical table names ≠ model names

`RsvpItem` is `@@map("RsvpDinner")` and `RsvpResponse` is
`@@map("RsvpDinnerResponse")`; `startsAt` is `@map("dinnerAt")`, `itemId` is
`@map("dinnerId")`. Deliberate: migrations run **before** the blue/green
container swap, so a real `ALTER TABLE ... RENAME` would leave the still-live
old container querying a table that no longer exists. Same call the Aug 13
supporting-document round made. Cost: the SQL table is called `RsvpDinner`
while holding workshops.

The token is **plaintext-in-DB** and unguessable (192 bits, base64url) — like
`Abstract.managementToken`, the dashboard re-displays the link, so it can't be
a one-way hash. Lookup is by the unique `token` column, then the invite's event
is asserted against the URL slug.

## Two links, not one hub

A person on both the dinner list and the workshop list holds **two invites and
two links**. Deliberate: the asks are separate (different deadlines, different
chase cycles), and a single hub link would re-expose the dinner every time you
reminded someone about workshops. A hub link is recorded as
deliberately-not-v1 in the plan §9.

## Per-campaign behavior

| Setting | Effect |
|---|---|
| `selectionMode: MULTI` | checkbox per option; tick any |
| `selectionMode: SINGLE` | radio group; **server 400s** a two-item POST (`SINGLE_SELECTION_ONLY`) |
| `allowGuests: false` | no guest field; a submitted count is **ignored (stored 0)**, never persisted |
| `collectDietary: false` | no dietary field; the stored value is left untouched |

Declining everything is valid in **both** modes — "none of these" must stay
expressible or a SINGLE-mode RSVP forces a false pick.

`allowGuests` and `collectDietary` are two booleans, not one `kind` enum: a site
visit collects dietary (packed lunch) but no guests; a workshop takes neither.
Collapsing them makes those unrepresentable.

## Flows

**Organizer** — `/events/[eventId]/rsvp`
([list](../src/app/%28dashboard%29/events/%5BeventId%5D/rsvp/page.tsx)) →
`/events/[eventId]/rsvp/[campaignId]`
([console](../src/app/%28dashboard%29/events/%5BeventId%5D/rsvp/%5BcampaignId%5D/page.tsx)).
The old `/events/[eventId]/dinner` is a permanent redirect (organizers have it
bookmarked).

**The campaign must not cost a step.** "New RSVP" is ONE form that creates the
campaign **and its first option** together (`firstItem` on the create payload),
and the config toggles sit behind an **Options** disclosure whose defaults
reproduce the historical dinner behavior. A single-dinner event is therefore:
New RSVP → add invitees → send. Three steps, same as before. Full reasoning in
plan §2a.

Then, per campaign:
1. Add options (name / date+time / venue / optional RSVP deadline).
2. Add invitees — manual rows, or **import from Registrations / Speakers /
   Submitters** ([ImportInviteesDialog](../src/components/rsvp/import-invitees-dialog.tsx)).
   Submitters are `Speaker` rows carrying `submitterSource`, so they are a
   filter over the speakers fetch, not a second endpoint. De-duped on
   `(campaignId, email)` — re-adding is skipped, not errored.
3. Send the links: **Email invitations** (all) / **Remind pending**
   (non-responders), the per-row **Send** button (one invitee), or **copy** an
   individual link.
4. Read the roster: per-invitee status + which options + guests + dietary,
   per-option **headcount tiles**, **CSV export** (guests/dietary columns appear
   only when the campaign collects them).

**Invitee** — `/e/[slug]/rsvp/[token]`
([page](../src/app/e/%5Bslug%5D/rsvp/%5Btoken%5D/page.tsx), public, no login):
name/email pre-filled read-only → a checkbox (or radio) per option, guests when
allowed → an explicit **"I won't be able to attend"** box → a dietary note when
collected → submit. Submit is gated on an explicit choice. **Re-editable until
each option's deadline** (server-authoritative replace-all over open options);
options past their deadline show closed and are ignored on submit.

## API

Organizer (session, org-scoped, `denyReviewer` on **reads too** — the roster
returns impersonation tokens — rate-limited):

- `GET/POST /api/events/[eventId]/rsvp-campaigns` — list (with item/invite/
  responded counts) · create (optional `firstItem`)
- `GET/PUT/DELETE .../rsvp-campaigns/[campaignId]` — DELETE cascades to items,
  invites and responses; the audit row snapshots the counts **before** the
  cascade, since afterwards they are unknowable
- `GET/POST .../rsvp-campaigns/[campaignId]/items` ·
  `PUT/DELETE .../items/[itemId]`
- `GET .../rsvp-campaigns/[campaignId]/invites` (roster + headcounts + campaign
  config; `?export=csv`) · `POST` (bulk add, ≤500) · `DELETE .../[inviteId]`
- `POST .../rsvp-campaigns/[campaignId]/invites/send` — **one route for single +
  bulk**. Body `{ inviteId?, target?: "all" | "pending", subject?, message? }`
  (Zod refine: `inviteId` OR `target`). Renders the
  **`dinner-rsvp-invitation`** system template with per-recipient vars
  `{{firstName}} {{lastName}} {{fullName}} {{email}} {{eventName}} {{rsvpName}}
  {{itemWord}} {{dinnerWord}} {{rsvpLink}} {{personalMessage}}
  {{organizerName}} {{organizerSignature}}`. Per-recipient try/catch, 10/hr/event.

Public (token-gated, per-IP + per-token rate-limited):
- `GET/POST /api/public/events/[slug]/rsvp/[token]`

Every lookup binds `{ id, campaignId }` and resolves the campaign against
`{ id, eventId }` first, so an id from another campaign or event cannot resolve
against this URL.

**⚠ `{{itemWord}}` is NOT an alias for `{{dinnerWord}}`.** They render different
words (`session`/`sessions` vs `dinner`/`dinners`) — an earlier version of this
file and of the route comment claimed otherwise, which would have silently
rewritten an organizer's copy the moment they swapped the token. All three of
`{{rsvpName}}`, `{{itemWord}}` and `{{dinnerWord}}` are registered in
`TEMPLATE_VARIABLES` and `getSamplePreviewVariables`, so the editor lists them
and **Preview renders them exactly as the send will**. The DEFAULT template now
uses `{{rsvpName}}` (correct for any RSVP); `{{dinnerWord}}` stays resolvable
because 17 events already reference it, but reads wrong on a workshop.

**⚠ The email template slug stays `dinner-rsvp-invitation`.** Verified on prod:
**17 events already hold a materialised row** on that slug (the templates list
GET auto-seeds system defaults as editable rows). Renaming it orphans all 17 and
silently falls back to the default for anyone who edited theirs. A slug is a
**key**, not a label — the display label is now "RSVP Invitation", the slug did not move. Same rule
for the `{{dinnerWord}}` variable — kept resolvable, but the default template no
longer uses it.

Shared helpers: [src/lib/rsvp/rsvp.ts](../src/lib/rsvp/rsvp.ts) —
`generateRsvpToken`, `normalizeRsvpEmail`, `computeItemHeadcounts`,
`violatesSelectionMode`, `isAttendingAny`, `isDeadlineAfterItem`, the Zod
schemas. [src/lib/rsvp/server.ts](../src/lib/rsvp/server.ts) —
`loadRsvpEvent` / `loadRsvpCampaign` (six routes need the same two-step scope;
a hand-copied check is how one of them ends up org-scoped-only).

## MCP

`list_rsvps` ([tools/rsvp.ts](../src/lib/agent/tools/rsvp.ts), read-only) —
every RSVP on the event with its options, **per-campaign** headcounts, an
invited/responded/pending summary, and per-invitee responses. Optional
`campaignId` narrows to one. **Grouped by campaign deliberately**: summing a
30-person dinner and a 200-person workshop produces a number that briefs the
caterer wrongly. Renamed from `list_dinner_rsvps` (**MCP clients must
reconnect**; `package.json` bumped as the cache-invalidation hint). In
`ROSTER_PII_AGENT_TOOLS`, so the in-app agent refuses it for MEMBER.

## Migration

`prisma/migrations/20260814120000_customizable_rsvp_campaigns` — idempotent throughout. Not purely
additive, in full: two `SET NOT NULL` and two `DROP INDEX` — of which only
`DROP INDEX RsvpInvite_eventId_inviteeEmail_key` can change behaviour, and it is
what actually permits a person on two audiences (the other drops a superseded
performance index). It only *loosens*, and
it was verified collision-free first (prod held **1 item, 2 invites, 0
responses**). Precedent: `20260625140000_cert_per_template_uniqueness`. At real
scale the principled form is expand/contract — ship the additive steps, deploy,
drop the old index in the following deploy. Details and the blue-green note on
`SET NOT NULL` are in the migration's own header comment.

`prisma migrate diff` from the replayed chain: **No difference detected.**

## Access

`denyReviewer` on **every** organizer route including the reads: the roster
returns each invitee's `token`, which IS an impersonation credential (anyone
holding it can POST the public endpoint with no login and rewrite a named
professor's attendance). MEMBER / ONSITE / REGISTRANT / REVIEWER / SUBMITTER are
403. Event resolution goes through `buildEventAccessWhere` (assignment-aware,
and correct for an org-null SUPER_ADMIN). See
[rsvp-roster-access.test.ts](../__tests__/api/rsvp-roster-access.test.ts).

## Tenancy

All four tables carry a denormalized nullable `organizationId`;
[prisma/rls/rsvp.sql](../prisma/rls/rsvp.sql) holds four flat policies, and
[tests/tenancy/rsvp-rls.test.ts](../tests/tenancy/rsvp-rls.test.ts) proves
per-lane scoping incl. the globally-unique-token cross-tenant miss (the public
route's bootstrap) and fail-closed across every table. `RsvpCampaign` shipped
tenancy-compliant in the same change rather than retrofitted.

## Tests

- [__tests__/lib/rsvp.test.ts](../__tests__/lib/rsvp.test.ts) — helpers,
  schemas, the SINGLE/MULTI truth table.
- [__tests__/api/rsvp-routes.test.ts](../__tests__/api/rsvp-routes.test.ts) —
  **three mutation-verified guards**: the campaign-scoped de-dup (revert the
  where to `eventId` and it fails), the SINGLE-mode server rejection (remove the
  guard and it fails), and `allowGuests:false` ignoring a submitted count (pass
  it through and it fails). Plus the carried-over M1/M2/M3/M6/M8/M10/L7/L15
  regressions.
- [__tests__/api/rsvp-roster-access.test.ts](../__tests__/api/rsvp-roster-access.test.ts)
  — the role matrix + campaign-to-event binding.
- [__tests__/lib/rsvp-mcp-headcounts.test.ts](../__tests__/lib/rsvp-mcp-headcounts.test.ts)
  — H4 (headcounts over ALL invites) + the never-sum-across-campaigns guard.

## Review history (carried over)

Independent adversarial review (2026-07-08) — **no BLOCKER/HIGH**. Round 1
([CODE_REVIEW_SURVEY_RSVP.html](CODE_REVIEW_SURVEY_RSVP.html)) shipped B2, H2
(roster token exposure), H5 (timezone drift on save), H4, L3. Round 2
([CODE_REVIEW_DINNER_RSVP_R2.html](CODE_REVIEW_DINNER_RSVP_R2.html)) shipped 12
MEDs — M1 (a deadline-less item closes at its start, not never), M2
(`ignoredItemIds` rather than a silent drop), M3 (409 `STALE_FORM`), M4/M5/L9
(access alignment), M6 (batch sends skip anyone emailed in the last 10 min), M7,
M8, M9, M10 (the public submit writes an AuditLog row with IP). **Every one of
those behaviors is preserved by this generalization and still pinned by test.**
Remaining LOWs in [ROADMAP.md](ROADMAP.md) §"Dinner RSVP — backlog".

## The RSVP link inside any bulk email (Sep 10, 2026)

An organiser asked for `{{rsvpLink}}` in a general email sent from the Communications page, for example joining instructions that carry the "confirm your seat" button. Before this the link existed only in the console's own send.

- **How**: the bulk-email dialog (registrations or speakers audiences) has an **RSVP link** picker listing the event's open RSVPs. Picking one carries `filters.rsvpCampaignId`, which rides inside `filters` so a scheduled send reconstructs it from the persisted `ScheduledEmail.filters` JSON, the same reason `surveyExpiryDays` does. `{{rsvpLink}}` then resolves per recipient in a custom message, a saved template, or any built-in type; `{{rsvpName}}` carries the RSVP's name.
- **Who gets it**: only people on that RSVP's guest list. The send reads the campaign's invites once and matches on the normalised email (the invite's own unique key). A recipient with no invite is **skipped and counted** (`skippedCount`, `skippedReason` on the result, the worker's notification and the audit row). Nothing is minted and nobody is auto-invited: the console's guest list stays the only place a roster grows, so a bulk send to all registrations cannot put 400 people on a 40-seat dinner. Add people on the console (Import, now with Select all) first.
- **Refused up front** (400 `INVALID_FILTER`, at the enqueue route and again at fire time): a campaign that is not this event's, a closed campaign, or an audience that cannot hold an invite (reviewers, abstracts).
- **Security**: unchanged. The link is an impersonation credential, which is why the roster and the campaign list are staff-only; bulk email sits behind the same guard and sends each link only to that person's own address.

Tests: `__tests__/lib/bulk-email-rsvp-link.test.ts` (skip-not-mint, email normalisation, all-skipped, no-campaign), the precheck suite (event-bound lookup, closed campaign, wrong audience) and the schema suite.

## The console can send one of the organiser's own templates (Sep 10, 2026)

The other direction of the same request: the console's send dialog (Email invitations / Remind pending) has an **Email template** picker. The default is the RSVP invitation (stored as "Dinner RSVP Invitation", a name the list shows verbatim); the other entries are the organiser's **own saved templates**, so joining instructions written as a saved template can carry the button. The POST takes `templateSlug`; the route accepts only a custom slug or the RSVP one (400 `TEMPLATE_NOT_ALLOWED` for any other system template, whose tokens this route does not build), refuses a saved template that is no longer active (400 `TEMPLATE_NOT_AVAILABLE`, never a silent swap), renders `{{subject}}` and `{{message}}` (the two slots a saved template is built on) beside `{{rsvpLink}}`, and logs and dedups under the slug it actually sent. The dialog refuses to send a saved template whose body lacks `{{rsvpLink}}`. The per-row **Send** button opens the same dialog in single mode (title names the person, sends `inviteId`), so template, subject and note apply to one invitee too; a single send is never skipped as a recent resend. Tests in `__tests__/api/rsvp-routes.test.ts`.

## Not built

Per plan §9: **waitlists** (a capacity cap shipped Sep 10, 2026, see below; a
waitlist did not), the hub link, an auto-reminder cron (still the July 2026
owner decision: manual "Remind pending" is enough), campaign cloning between
events, and a decline *reason*.

## The link in a per-person send (Sep 11, 2026)

The registration detail sheet's and the speaker page's "Send Email" with a
saved template used to render `{{rsvpLink}}` literally: those two routes had
no RSVP resolution (the bulk dialog has a picker, the console mails an invite).
Found on OOPVF2026 the day before the forum: three joining-instruction emails
went out with `{{rsvpLink}}` in the body. Both routes now call
`resolveRsvpLinkForPerson()` in `src/lib/rsvp/personal-link.ts` when the
template (or a typed custom message) carries either exact token: the person's
own invite on the event is looked up by normalised email plus their
registration or speaker id; exactly one OPEN RSVP resolves to `{{rsvpLink}}`,
`{{rsvpButton}}` and `{{rsvpName}}`. Anything else is a **400 before sending**, with a message the
organiser can act on: `RSVP_NO_INVITE` (add them on the console),
`RSVP_CLOSED` (reopen it), `RSVP_AMBIGUOUS` (more than one open RSVP, so send
from Communications where the picker chooses). Nothing is minted on this path,
the bulk rule. A template test-send still renders a sample link.

## `{{rsvpButton}}`: the link as a button (Sep 11, 2026)

The bare `{{rsvpLink}}` is a URL the organiser has to wrap in their own
markup, and the editor's link tool will not take a token as an href, so what
shipped in practice was a raw URL pasted into a sentence. `{{rsvpButton}}`
renders the same personal link as a ready-made "RSVP now" button with a
personal-link note under it, built once in `src/lib/rsvp/button.ts` (link and
name escaped, so it joins the raw-HTML key set like `{{paymentBlock}}`) and
set wherever `{{rsvpLink}}` is: the bulk pipeline, the console send, both
per-person sends, and the template preview. `templateUsesRsvpToken()` in the
same file is the one predicate the two editors use to warn when a message or
saved template carries neither token.

## Close automatically at N attending (Sep 10, 2026)

**Sep 11, 2026:** the seat limit is also on the **New RSVP** form (it carried
only the option's name, date and venue, so the cap could only be set by editing
the option afterwards, whose button was an unlabelled clock icon; it is now a
labelled **Edit**). The campaign POST's first-item create had accepted
`firstItem.capacity` in its schema and dropped it on write, so a cap typed at
creation was silently unlimited; fixed and pinned.


An organiser with 109 invitees and 35 seats asked for the RSVP to stop taking
yeses by itself. `RsvpItem.capacity` (nullable, additive migration
`20260910120000`; the physical table is still `RsvpDinner`) is the option's
seat cap, entered on the console's option dialog as **Close automatically at
(seats)**. Seats are attendees plus their guests, the number the console tile
already shows.

- **What full means**: the public form marks the option full and refuses a
  NEW yes for it (`409 ITEM_FULL`, the whole submit rolls back so the previous
  answer stands, the form reloads and says so). People already attending keep
  their seat and can still change to no, which frees it. Raising or clearing
  the cap reopens the option. Unlimited (null) is never full.
- **Why it is safe under two people racing for the last seat**: the cap is
  checked INSIDE the replace-all transaction, after the invite's own rows are
  deleted (so a re-submit never counts against itself) and under a
  `SELECT ... FOR UPDATE` on the option's row, items locked in id order. This
  is the "contended claim needs a conditional write" piece the July review
  parked; the row lock is what makes the count-then-insert atomic.
- **Surfaces**: the console tile reads "N of 35 seats" with a "Full, closed to
  new yeses" badge; the public form shows "N seats left" or "This option is
  full"; the roster CSV is unchanged; MCP `list_rsvps` carries `capacity` and
  `full` per item (output only).
- Tests in `__tests__/api/rsvp-routes.test.ts` (refused at the cap, guests
  count as seats, an attendee keeps their seat, a no never consults the cap,
  unlimited never locks) and `__tests__/lib/rsvp.test.ts`.
