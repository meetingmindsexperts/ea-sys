# Sponsor attribution: sponsors, their promo codes, and reporting what they brought

> **Status: PLANNED, NOT BUILT (September 2, 2026).** Do not start without an
> explicit go-ahead. Three owner decisions are locked in §2; the open questions
> in §8 do not block phase 1.
>
> **Read first:** the current state is evidenced in §1. Every claim there was
> read in source rather than recalled.

---

## 1. The problem, and it is a missing join rather than a missing feature

An organiser signs a sponsor, gives them a promo code, and wants to know at the
end of the event **who that sponsor brought**. Two populations arrive under one
sponsor and today they are tracked by two different keys that nothing joins:

| Population | How it is attributed today |
|---|---|
| Exhibitor and sponsor staff | `Registration.sponsorId` plus `paymentStatus = INCLUSIVE`. The sponsor paid out of band, the attendee owes nothing. |
| Doctors the sponsor invited | A promo code they typed at registration. `Registration.promoCodeId` plus a `PromoCodeRedemption` row. |

**`PromoCode` has no sponsor column**, so a code is associated with its sponsor
only by being named `ABBOTT20`. Nothing in the system knows.

What follows from that, all four verified:

1. **The registrations list cannot filter by sponsor.** It filters on status,
   paymentStatus, ticketTypeId, groupId, free text, tags and date ranges. The
   sponsor is on every row and there is no way to ask for it.
2. **Neither CSV export carries a Sponsor column.** Both carry `Promo Code`.
   `grep Sponsor src/lib/registration-export.ts` returns nothing.
3. **The promo-codes page shows `_count.redemptions`**, a number, with no way to
   see who redeemed. The sales export is the only route, via Excel.
4. **So "everyone Abbott brought" is two manual pulls with no common field.**

### Two things that are already true and change the shape

**`sponsorId` is ALREADY allowed on a paying registration.**
`registration-service.ts` requires it only for INCLUSIVE and validates it for
every other status, with a comment saying attribution is deliberately preserved
across a status change. The **UI hides it**: the picker in the registration
detail sheet renders behind `isEditing && editData.paymentStatus === "INCLUSIVE"`.
One JSX condition is the whole gap, and unhiding it is the cheapest part of this
entire plan.

**Sponsors have no foreign key and no delete guard.** They live in
`Event.settings.sponsors[]` as JSON; `Registration.sponsorId` is a plain string
into that array. The sponsors PUT is replace-all with no in-use check, so
removing a sponsor silently orphans every registration pointing at it. The
detail sheet already renders `(sponsor removed)`, which means somebody has met
this. For a report an organiser invoices against, that is the difference between
a number that holds and one that quietly shrinks.

---

## 2. Owner decisions (locked September 2, 2026)

1. **One sponsor per promo code.** A sponsor may hold several codes; a code
   belongs to at most one sponsor. A single nullable column, no join table.
2. **Sponsors are promoted to a real table.** Not the smaller "keep the JSON and
   add a delete guard" option. This is the larger of the two and it is taken
   deliberately: reporting an organiser bills against should not rest on a
   string pointer into a JSON array with no referential integrity.
3. **A paying delegate can be tagged to a sponsor directly.** The picker is
   shown for any payment status, not only INCLUSIVE. **Consequence to state
   plainly: "sponsored by" stops meaning "this sponsor paid".** It becomes
   attribution, and the money question is answered by `paymentStatus`. The
   detail sheet's wording has to change with it, or the screen will read as a
   payment claim that is no longer true.

---

## 3. Schema

```prisma
model Sponsor {
  id             String   @id @default(cuid())
  eventId        String
  organizationId String?          // denormalized tenant key, the house convention
  name           String
  tier           String?          // the existing six-value SponsorTier
  logoUrl        String?
  websiteUrl     String?
  description    String?  @db.Text
  sortOrder      Int      @default(0)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  event         Event          @relation(fields: [eventId], references: [id], onDelete: Cascade)
  registrations Registration[]
  promoCodes    PromoCode[]

  @@unique([eventId, name])
  @@index([eventId])
  @@index([organizationId])
}
```

`Registration.sponsorId` becomes a real FK with **`onDelete: Restrict`**, which
is what decision 2 is actually buying. `PromoCode.sponsorId` is a new nullable
FK, `Restrict` for the same reason.

**Keep the existing ids during the backfill.** The JSON entries already have
`id` values that live rows point at, so the migration inserts `Sponsor` rows
carrying those same ids and every existing `Registration.sponsorId` resolves
without being rewritten. Minting fresh ids would need a second update pass over
registrations and a window where the pointer is wrong.

**`@@unique([eventId, name])` is a real constraint on existing data.** The JSON
model never enforced it, so a duplicate name is possible today. The migration
has to detect that and stop rather than silently merge two sponsors, because
merging is a decision about someone's money.

---

## 4. The sharpest design point: replace-all meets Restrict

Both writers of the sponsor list are **replace-all**:

- the dashboard `PUT /api/events/[eventId]/sponsors` sends the whole array
- MCP `upsert_sponsors` defaults to `mode: "replace"`, whose own description
  says it "deletes anything not in the passed array"

With an FK and `Restrict`, replace-all **starts failing** the first time a
sponsor has a registration or a promo code. That is not a bug to work around,
it is the guard doing its job, but it means both writers need reshaping in the
same phase rather than later:

- **Removing a referenced sponsor is refused**, naming the counts, the same
  shape as the abstract sub-theme delete and the DTCM ambiguity refusal.
- **The editor must show what is referenced** before the organiser presses Save,
  or the refusal arrives as a surprise at the end of an edit.
- **`upsert_sponsors` should default to `merge`, not `replace`.** An agent that
  omits a row currently deletes it, and once rows carry attribution that is a
  destructive default. Changing the default is an MCP behaviour change, so it
  needs the version bump and a note in `MCP_REFERENCE.md`.

---

## 5. Blast radius, enumerated

Every consumer of `readSponsors` / `settings.sponsors`, read from source:

| Site | What changes |
|---|---|
| `src/lib/webinar.ts` `readSponsors` | Becomes a query. Keep `SponsorEntry` as the shape so callers barely move. |
| `GET/PUT /api/events/[eventId]/sponsors` | Replace-all becomes a diff with a refusal, see §4. |
| `GET /api/public/events/[slug]/sessions/[sessionId]/detail` | Reads the table. Public path, so watch the query count. |
| `POST /api/events/[eventId]/import/registrations` | Resolves a sponsor by NAME from CSV. Keep the ambiguity refusal. |
| `src/services/registration-service.ts` | `sponsorId` validation becomes an FK check rather than an array scan. |
| Registrations `POST` and `[registrationId]` `PUT` | Same. |
| MCP `list_sponsors`, `upsert_sponsors`, `research_sponsor` | Table-backed; `upsert_sponsors` gains the merge default. |
| `/events/[eventId]/sponsors` editor | Referenced-count badges plus the refusal path. |
| Public session page `SponsorsTab` | Prop shape unchanged if `SponsorEntry` survives. |
| `/events/[eventId]/setup` readiness tile | Counts from the table. |
| Registration detail sheet | Picker un-gated (decision 3) plus wording. |
| `src/lib/event-clone-settings.ts` | **`"sponsors"` is in the clone allow-list.** Once it is a table, clone must copy ROWS. Miss this and cloning an event silently drops its sponsors. |
| `src/lib/agent/system-prompt.ts` | Describes replace-all semantics to the agent in three places. |

**Tenancy, non-negotiable and cheap if done at birth:** `organizationId` stamped
at create, `runWithTenant` on every route, `prisma/rls/sponsor.sql`, a
`check-tenant-als.sh` entry and harness assertions, all in the same phase.
`__tests__/lib/rls-coverage.test.ts` will **fail the build** if the policy is
missing, which is exactly what that gate was built for.

---

## 6. Build order

**Phase 1: the link and the report, no table.** Add `PromoCode.sponsorId` as a
plain nullable string against the existing JSON model, add the `sponsorId`
filter and the Sponsor column to both exports, and unhide the picker. This
delivers the whole of what was asked and is reversible. *Recommended as a
separate shippable step even though decision 2 is taken*, because it is small,
it answers the question today, and it de-risks phase 2 by proving the report is
the one the organiser actually wants before the schema moves under it.

**Phase 2: the table.** Migration and backfill, FKs, RLS, the §5 sweep, the §4
reshaping of both writers. Behaviour-preserving apart from the new refusals.

**Phase 3: the rollup.** A per-sponsor view: exhibitor seats taken, delegates
brought by code, discount given, revenue net of discount. Whether it lives on
the sponsors page or in analytics is §8.

The union query the whole thing exists for, available from the end of phase 1:

```ts
where: { OR: [{ sponsorId }, { promoCode: { sponsorId } }] }
```

---

## 7. Deliberately NOT in v1

- **Per-sponsor seat allocations** ("Abbott gets 10 comps"). A real feature with
  its own counter and race, and nothing has asked for it.
- **A sponsor portal.** No sponsor logs in. Reporting is for the organiser.
- **Splitting one redemption across sponsors.** Decision 1 forecloses it.
- **Sponsor contract value or invoicing.** That is the CRM's deal, literally.
  `CrmDeal` already carries value and links to an event; a later join between
  `Sponsor` and `CrmDeal` is the obvious follow-up and is not this.
- **Backfilling attribution for past events.** Nothing records who invited whom.

---

## 8. Open questions, none blocking phase 1

1. **Where does the rollup live?** The sponsors page reads naturally; analytics
   is where other reporting lives. Two clicks either way.
2. **Does the sponsor tag survive a cancellation** in the count? A cancelled
   delegate a sponsor brought is still someone they brought, but not someone who
   attended. The report probably needs both numbers.
3. **Does a promo code's sponsor auto-tag the registration?** Tempting, and
   rejected in this draft: it would write attribution nobody chose, and the
   union query in §6 gets the same answer without a write.
4. **Is `@@unique([eventId, name])` right**, or do two sponsors legitimately
   share a name at one event? It is the constraint that makes the CSV importer's
   name resolution honest, so dropping it has a cost.

---

## 9. Verification

Per phase: `npx tsc --noEmit`, `npm run lint`, full vitest, `npm run build`.
Phase 2 additionally needs the tenancy harness green and a migration replayed
from empty, and the backfill rehearsed on the local prod copy with a count
assertion on both sides before `--write`. The refusals in §4 are the parts to
mutation-verify: a guard that cannot fail is not a guard.
