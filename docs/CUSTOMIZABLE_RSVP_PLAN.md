# Customizable RSVP — one RSVP mechanism, many uses

> **STATUS: BUILT 2026-08-14** (planned and shipped the same day, owner go-ahead
> mid-round). Live reference: [RSVP.md](RSVP.md). This document is kept as the
> decision record — the reasoning, the rejected alternatives, and what was
> deliberately left out.
>
> Generalize the Dinner RSVP domain so an event can run **several independent RSVPs**
> (a gala dinner, a set of pre-conference workshops, a site visit), each with its **own
> audience** drawn from anyone in the event: registrations, speakers, submitters.
>
> **Deviations from the plan as written**, all minor:
> - `ImportInviteesDialog` moved `src/components/dinner/` → `src/components/rsvp/`
>   (path references below are pre-move).
> - The organizer routes moved under the campaign
>   (`/api/events/[eventId]/rsvp-campaigns/[campaignId]/{items,invites}`) rather
>   than keeping `/dinners` + `/rsvp-invites` — the scoping is structural that way,
>   not a where-clause anyone can forget. The page moved `/dinner` → `/rsvp`
>   (list) + `/rsvp/[campaignId]` (console), with `/dinner` a permanent redirect.
> - `{{dinnerWord}}` is KEPT as an email variable name (17 materialised templates
>   reference it) — the same key-not-label rule §4 states for the slug. `{{itemWord}}`
>   and `{{rsvpName}}` were ADDED, and they are **not aliases** (a first pass called
>   them that and shipped a comment saying "both resolve to the same value" above two
>   lines producing different words; the post-ship review caught it). The DEFAULT
>   template now uses `{{rsvpName}}`, which is correct for a workshop as well as a
>   dinner; all three are registered in `TEMPLATE_VARIABLES` + the preview samples so
>   Preview and the send agree.
> - §2a's "Add another date" reveal became a permanently-visible **Options** panel
>   on the console; the one-form create + the Options *config* disclosure are as
>   planned.

---

## 0. The ask, and what it actually requires

Owner: *"repurpose Dinner RSVP to Customizable RSVP, so we can have dinner rsvp, workshop
rsvp… basically RSVP for anything, speakers, registration, submitters."*

Two halves, and only one of them is missing.

**The audience half is already built.** `RsvpInvite` carries soft refs `registrationId?` /
`speakerId?`, and [ImportInviteesDialog](../src/components/dinner/import-invitees-dialog.tsx)
already imports from **Registrations or Speakers**. Submitters *are* `Speaker` rows
(`submitterSource` set; 27 of them on prod), so they already arrive through the Speakers
picker. The only gap is a filter chip, not a model change.

**The "several RSVPs" half is the work**, and it is not a `kind` column. See §2.

---

## 1. Decisions

**Locked (owner, 2026-08-14):**

| # | Decision |
|---|---|
| D1 | **Campaign layer.** An event has many RSVPs; each owns its own items *and* its own invite list. |
| D2 | **Per-campaign config:** `selectionMode` (SINGLE / MULTI), `allowGuests`, `collectDietary`. Not a fixed `kind` enum. |
| D3 | **Capacity is NOT in v1.** No per-item seat limits. Additive later (§9). |
| D4 | **Abstract acceptance stays out.** It is already the Presenter Agreement, a different shape (§10). |

**Proposed here, needs a nod:**

| # | Proposal |
|---|---|
| P1 | Prisma-side rename via `@@map`; **no SQL table rename** (§7). |
| P2 | One token per (campaign, person) — a person invited to two RSVPs gets **two links** (§6). |
| P3 | Organizer-facing name is **"RSVPs"**; the internal model is `RsvpCampaign`. |
| P4 | **The campaign is invisible until a second item exists** (§2a). Step count for today's flow is unchanged. |

---

## 2. Why a `kind` column does not work

One line, [prisma/schema.prisma:3092](../prisma/schema.prisma#L3092):

```prisma
@@unique([eventId, inviteeEmail])
```

`RsvpInvite` is **event-level**, and one token covers every dinner on the event. Add a
`kind` column to `RsvpDinner` and:

- A person holds exactly **one** invite per event, so a 30-person dinner list and a
  200-person workshop list cannot coexist. The second add collides with the first.
- If it instead reuses the existing invite, the workshop audience opens their link and
  sees the **VIP dinner list**.

The audience is baked into the Event, not into the RSVP. That is the thing being fixed.
This is the *singleton-promoted-to-a-collection* shape, the same one
[MULTI_SURVEY_PLAN.md](MULTI_SURVEY_PLAN.md) addresses for surveys.

### The simpler model that was considered and rejected

Scope the invite directly to an item and drop the campaign entirely:

```prisma
@@unique([itemId, inviteeEmail])   // no campaign
```

Genuinely simpler, and it breaks something that already works. A three-night dinner today
sends **one** link asking "which nights are you coming?". Per-item invites turn that into
three invites and three links, one per night — worse than today.

The link has to answer *"which items do I show?"*, and today that answer is hardcoded to
"all of the event's dinners". Any generalization must name that set; once named and given
an identity, it is a campaign whether or not it is called one. The alternative is an
anonymous set, which is the same row with a worse API.

General test: **if removing a layer forces you to reinvent it without a name, it was not
gratuitous.**

---

## 2a. The campaign must not cost the organizer a step (P4)

The layer is right in the model and would be wrong as a visible extra screen. Naively:

| | Today | Naive campaign version |
|---|---|---|
| 1 | Add Dinner (name, date, venue) | **Create RSVP (name)** |
| 2 | Add invitees | Add item (name, date, venue) |
| 3 | Send | Add invitees |
| 4 | | Send |

The real smell is not the extra click, it is naming the same thing twice: campaign
"Gala Dinner" containing item "Gala Dinner".

**Fix is progressive disclosure — the campaign form IS the first item's form:**

1. **New RSVP** — name, date, time, location. Creates the campaign *and* its single item.
2. Add invitees.
3. Send.

Three steps, same as today. An **"Add another date"** action reveals the item list, and
only then does the UI present campaign and items as distinct things — which is exactly the
moment the distinction starts to mean something. A second RSVP (workshops) is one click
from the list.

Config (`selectionMode`, `allowGuests`, `collectDietary`) lives behind an **Options**
disclosure with today's behavior as the default (MULTI, guests on, dietary on), so an
organizer who only ever runs dinners never sees any of it.

Principle worth keeping: **model the general case, present the common one.** Schema shape
and UI shape need not match, and assuming they must is a common reason people under-model
— it is how `@@unique([eventId, inviteeEmail])` got there in the first place.

---

## 3. Schema

```
Event ──< RsvpCampaign ──< RsvpItem
                       └──< RsvpInvite ──< RsvpResponse
```

### New

```prisma
enum RsvpSelectionMode {
  SINGLE   // pick one (parallel workshop tracks)
  MULTI    // tick any (dinners across several nights)
}

model RsvpCampaign {
  id             String   @id @default(cuid())
  eventId        String
  organizationId String?              // tenancy key, born compliant (§7)
  name           String               // "Gala Dinner", "Pre-conference Workshops"
  description    String?  @db.Text    // shown above the items on the public form
  selectionMode  RsvpSelectionMode @default(MULTI)
  allowGuests    Boolean  @default(false)
  collectDietary Boolean  @default(false)
  isActive       Boolean  @default(true)
  sortOrder      Int      @default(0)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  event   Event        @relation(fields: [eventId], references: [id], onDelete: Cascade)
  items   RsvpItem[]
  invites RsvpInvite[]

  @@index([eventId])
  @@index([organizationId])
}
```

**Why two booleans and not one `kind` enum.** `allowGuests` and `collectDietary` are
independent in practice: a site visit collects dietary (packed lunch) but no guests; a
gala takes both; a workshop takes neither. Collapsing them into `kind: DINNER | WORKSHOP`
makes the in-between unrepresentable, which is exactly the mistake the
[per-type supporting document](PER_TYPE_DOCUMENT_UPLOAD_PLAN.md) round corrected
(two booleans so "ask but do not block" stays expressible).

`selectionMode` is genuinely a mode, not two booleans, because SINGLE and MULTI are
mutually exclusive by definition.

### Changed (Prisma names only, see §7)

| Today | Becomes | Note |
|---|---|---|
| `RsvpDinner` | `RsvpItem` `@@map("RsvpDinner")` | + `campaignId`; `dinnerAt` → `startsAt` `@map("dinnerAt")` |
| `RsvpDinnerResponse` | `RsvpResponse` `@@map("RsvpDinnerResponse")` | `dinnerId` → `itemId` `@map("dinnerId")` |
| `RsvpInvite` | unchanged name | + `campaignId`; **unique becomes `(campaignId, inviteeEmail)`** |

`RsvpInvite.eventId` **stays** (denormalized). The public route asserts the invite's event
against the URL slug, and every index and tenancy policy already leans on it.

---

## 4. What must NOT be renamed

**The email template slug stays `dinner-rsvp-invitation`.**

Verified read-only on prod: **17 events already hold a materialised
`dinner-rsvp-invitation` `EmailTemplate` row** (the templates list GET auto-seeds system
defaults as editable rows, so merely opening Communications → Email Templates creates
them). Renaming the slug orphans all 17, and any organizer who genuinely edited theirs
would silently fall back to the default with nothing failing.

This is the Aug 11 presenter-registration lesson exactly: *a slug is a KEY, not a label.*
The **display label** in [email-template-slugs.ts](../src/lib/email-template-slugs.ts)
can change to "RSVP Invitation"; the slug cannot.

Same reasoning applies to the `{{dinnerWord}}` template variable: keep the variable name,
widen what it resolves to (the campaign's item noun).

---

## 5. Audience — RSVP for anyone

Mostly existing behavior, re-pointed at a campaign:

- **Import picker** gains a third tab. Registrations · Speakers · **Submitters**
  (`Speaker where submitterSource != null`). All three land as `RsvpInvite` rows with the
  matching soft ref.
- **Manual add** (name + email) unchanged, for people who are in neither list.
- De-dup key moves from `(eventId, email)` to `(campaignId, email)`, which is the whole
  point: the same person can be on the dinner list *and* the workshop list.

No new model. The soft refs already exist and are already nullable, so a dangling id
after a registration is deleted stays harmless.

---

## 6. Public form and submit semantics

The existing form is close to right; it becomes campaign-driven.

| Behavior | Today | After |
|---|---|---|
| Item choice | checkbox per dinner | checkbox (MULTI) or **radio** (SINGLE) |
| Guests | always | only when `allowGuests` |
| Dietary | always | only when `collectDietary` |
| Decline | explicit "I won't attend" checkbox | unchanged |
| Deadline | `rsvpDeadline ?? startsAt` per item | unchanged |
| Submit | server-authoritative replace-all over **open** items | unchanged, scoped to the campaign |
| Stale form | 409 `STALE_FORM` when zero open items | unchanged |
| Just-closed item | reported via `ignoredDinnerIds` | renamed `ignoredItemIds` (response field, no consumers outside our own page) |

**SINGLE mode is enforced server-side**, not only by the radio group. A crafted POST
naming two items is a 400, not a silent first-wins.

**P2 — two links, not one hub.** A person on both the dinner and the workshop list gets
two invites and two tokens. A single hub link showing every campaign they belong to reads
nicer, but the asks genuinely are separate: different deadlines, different chase cycles,
and reminding about workshops would re-expose the dinner. Recorded as deliberately-not-v1
(§9) rather than rejected.

---

## 7. Migration and rollout

### The rename is Prisma-side only (P1)

No `ALTER TABLE ... RENAME`. Deploys are blue/green and migrations run **before** the
container swap, so a real rename leaves the still-live old container querying a table that
no longer exists. `@@map` / `@map` gives the honest model name at zero risk — the same call
the Aug 13 supporting-document round made for `Registration`'s two columns.

**The cost, stated plainly:** the SQL table is called `RsvpDinner` forever while holding
workshops. That is real naming debt for anyone reading the DB directly, and it is bought
with a schema comment rather than a risky DDL. The alternative (new tables + data move +
a later drop) is two deploys of pure cosmetics for a domain holding three rows.

### Migration steps

All additive except the final index swap:

1. `CREATE TABLE "RsvpCampaign"` + the `RsvpSelectionMode` enum.
2. `ALTER TABLE "RsvpDinner" ADD COLUMN "campaignId" TEXT` (nullable).
3. `ALTER TABLE "RsvpInvite" ADD COLUMN "campaignId" TEXT` (nullable).
4. Backfill: one campaign per event that has dinners (`name = 'Dinner'`,
   `allowGuests = true`, `collectDietary = true`, `selectionMode = MULTI` — today's exact
   behavior), then stamp `campaignId` on its items and invites.
5. `CREATE UNIQUE INDEX` on `("campaignId","inviteeEmail")`. Safe alongside the old one:
   `campaignId` is nullable and Postgres treats NULLs as distinct, so an old container's
   inserts cannot collide.
6. `DROP` the old `("eventId","inviteeEmail")` unique.

**Step 6 is the one non-additive statement**, and it must be justified rather than waved
through. It is safe here because it only *loosens*: an old container's writes still satisfy
the stricter shape it thinks is in force. The residual risk is that the bulk-add's
`createMany({ skipDuplicates: true })` leans on that index to de-dup, so during the swap
window a double-submitted bulk add could create a duplicate invite. With **2 invite rows on
prod and no live campaign**, that window is empty. Precedent: the
`20260625140000_cert_per_template_uniqueness` swap, described at the time as "the one
non-additive but verified-collision-free migration".

If this ever needs doing at scale, the principled form is **expand/contract** (parallel
change): ship steps 1–5, deploy, then drop the old index in the *next* deploy.

### Born tenancy-compliant

`RsvpCampaign` ships with `organizationId` stamped at create, `runWithTenant` on its
routes, a `check-tenant-als.sh` allowlist entry, and its policy folded into
[prisma/rls/rsvp.sql](../prisma/rls/rsvp.sql) — in the same PR, not retrofitted.

### Live state at planning (read-only prod, 2026-08-14)

```
RsvpDinner            1
RsvpInvite            2
  RESPONDED           1
RsvpDinnerResponse    0     ← the single response was a decline-all
events with dinners   1
```

Effectively unused. The backfill is mechanical at any size; what makes *now* cheap is the
absence of live tokens in inboxes, external MCP consumers pinned to the current response
shape, and organizers trained on "the Dinner page".

---

## 8. Work breakdown

| # | Step | Touches |
|---|---|---|
| 1 | Schema + migration + backfill + RLS policy | `prisma/` |
| 2 | Campaign CRUD routes + Zod + `RsvpCampaign` shape in [rsvp.ts](../src/lib/rsvp/rsvp.ts) | `api/events/[eventId]/rsvp-campaigns/*` |
| 3 | Re-scope items + invites + roster + CSV to `campaignId` | 5 existing route files |
| 4 | Public form: campaign-driven, SINGLE mode, conditional guests/dietary | `e/[slug]/rsvp/[token]`, public route |
| 5 | Organizer console: campaign list → campaign detail, **progressive disclosure per §2a** (one combined create form; item list + Options appear on demand); "Dinner" copy → "RSVP" | `events/[eventId]/dinner/page.tsx` → `.../rsvp/` |
| 6 | Import picker: Submitters tab | `import-invitees-dialog.tsx` |
| 7 | MCP `list_dinner_rsvps` → `list_rsvps` + `campaignId` filter; **package bump** | `tools/dinner.ts`, `register-mcp-tools.ts` |
| 8 | Docs: rewrite [RSVP.md](RSVP.md) → `RSVP.md`; user-guide section | `docs/`, `public/user-guide.html` |

Route path `/events/[eventId]/dinner` → `/events/[eventId]/rsvp` needs a permanent
redirect (the My-Details precedent), since organizers have it bookmarked.

**Tests to write, at minimum:** the `(campaignId, email)` de-dup allowing the same person
in two campaigns (mutation-verified — reverting the unique must fail it), SINGLE-mode
server-side rejection of a two-item POST, `allowGuests: false` ignoring a submitted
guest count rather than storing it, and campaign-scoped roster isolation (campaign A's
roster never returns campaign B's invitees).

---

## 9. Deliberately not in v1

- **Capacity / waitlists.** The one genuinely hard piece: a contended claim needs a
  conditional write (`updateMany ... WHERE claimed < capacity`, the
  [registration-seat-db.ts](../src/lib/registration-seat-db.ts) pattern), and it collides
  with the replace-all submit, which deletes then re-creates responses. Release and
  re-claim must sit in one transaction or a re-edit can lose a seat mid-submit. Additive
  later: a nullable `RsvpItem.capacity`.
- **Hub link** (one token per person spanning campaigns) — see §6.
- **Auto-reminder cron.** Still the July 2026 owner decision: manual "Remind pending" is
  enough.
- **Campaign templates / cloning between events.** Event clone currently copies nothing
  RSVP-related; leave it that way until asked (and note the webinar-clone bug as the
  cautionary tale for copying pointers wholesale).
- **A decline *reason*.** Today decline is a boolean.

## 10. Not this domain

**Abstract acceptance is already built, as the Presenter Agreement.** Per-author
per-event, token hashed and expiring, acceptance recorded with IP, timestamp and a frozen
`presenterAgreementTextSnapshot`. It is a consent record, not a preference, so folding it
into RSVP would either strip the evidentiary fields or push them onto every dinner
response that has no use for them.

Its real gaps are small and belong to *that* surface: **no decline path** (an author who
cannot come is indistinguishable from one who has not replied), and **no roster** (the
faculty agreement has a signed/unsigned filter and an MCP tool; the presenter one does
not). Prod shows **0** presenter-agreement acceptances and **0 of 5** abstracts ACCEPTED,
so that path has never run end to end — worth watching on the first real acceptance
before building on it.

If the intent was instead *delegates choosing which abstract or poster sessions to
attend*, that is the workshop shape and this plan covers it with no extra code.

---

## 11. Open questions

1. ~~**P1 naming debt**~~ — DECIDED at build: `@@map`, SQL keeps `RsvpDinner`. Revisit only
   if reading the DB directly becomes common.
2. ~~**P3 wording**~~ — DECIDED at build: shipped as **"RSVPs"**.
3. Should a campaign be able to **auto-invite a whole segment** (e.g. everyone with tag
   `committee`) rather than an explicit import, and re-evaluate as registrations arrive?
