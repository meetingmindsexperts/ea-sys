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

**⚠ The email template slug stays `dinner-rsvp-invitation`.** Verified on prod:
**17 events already hold a materialised row** on that slug (the templates list
GET auto-seeds system defaults as editable rows). Renaming it orphans all 17 and
silently falls back to the default for anyone who edited theirs. A slug is a
**key**, not a label — the display label changed, the slug did not. Same rule
for the `{{dinnerWord}}` variable; `{{itemWord}}` is the alias new templates
should use.

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

`prisma/migrations/20260814120000_customizable_rsvp_campaigns` — additive and
idempotent except **one** statement, `DROP INDEX RsvpInvite_eventId_inviteeEmail_key`,
which is what actually permits a person on two audiences. It only *loosens*, and
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

## Not built

Per plan §9: **capacity / waitlists** (the one genuinely hard piece — a
contended claim needs a conditional write and collides with the replace-all
submit; additive later as a nullable `RsvpItem.capacity`), the hub link, an
auto-reminder cron (still the July 2026 owner decision: manual "Remind pending"
is enough), campaign cloning between events, and a decline *reason*.
