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
3. **Sponsor attribution is finance-redacted, like the payer already is.**
   `sponsorId` joins `FINANCIAL_KEYS`, so MEMBER stops seeing it. This resolves
   a **pre-existing inconsistency** rather than inventing a rule: `billingAccount`,
   `billingAccountId`, `payerReference` and `attendeeIsGuarantor` are all
   redacted today with the recorded reason "MEMBER never sees who funds a
   doctor, Mecomed-sensitive", and sponsor attribution is that same fact.
   **It is a behaviour change on a live system**: MEMBER can see this field
   today and will stop.

   **Only `sponsorId` on a registration, never the sponsor LIST.** Who sponsors
   an event is public, their logos are on the public session page. What is
   private is which sponsor funded which delegate. `redactFinancialFields` is a
   recursive strip by key NAME, so adding a bare `sponsors` would blank the
   public sponsor list wherever it appears. That file's own header warns about
   exactly this after `value` nearly blanked every survey answer.

4. **A paying delegate can be tagged to a sponsor directly.** The picker is
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

  @@unique([eventId, name, tier])
  @@index([eventId])
  @@index([organizationId])
}
```

`Registration.sponsorId` and `PromoCode.sponsorId` become real FKs, both
**`onDelete: SetNull`**, with the "do not delete a referenced sponsor" rule
enforced at the **application** layer.

**Corrected from `Restrict`, which the first draft proposed and which was
wrong twice over.** Deleting an Event cascades to `Registration` and `Sponsor`
as siblings, and SQL `RESTRICT` is checked immediately rather than deferred to
the end of the statement, so if the Sponsor rows go first the whole event
delete fails. And the precedent §4 cites, the abstract sub-theme, is
`SetNull` **plus an application-level refuse-while-in-use guard**. The draft
quoted the right precedent and then proposed the opposite mechanism.

**Keep the existing ids during the backfill.** The JSON entries already have
`id` values that live rows point at, so the migration inserts `Sponsor` rows
carrying those same ids and every existing `Registration.sponsorId` resolves
without being rewritten. Minting fresh ids would need a second update pass over
registrations and a window where the pointer is wrong.

**The uniqueness key is `(eventId, name, tier)`, not `(eventId, name)`.**
Corrected after audit: MCP `upsert_sponsors` merge mode already matches rows
"by case-insensitive (name, tier) composite", so the current model treats name
plus tier as identity and a constraint on name alone would reject data today's
writers can legitimately produce, and stop the migration on it. The JSON model
enforced nothing, so the migration must still detect a genuine duplicate under
the chosen key and **stop rather than silently merge**, because merging two
sponsors is a decision about someone's money.

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
nullable string against the existing JSON model **and validate it on write**
against `readSponsors(event.settings)`, exactly as the registration path
already does. The first draft said "a plain nullable string" with no
validation, which would have added a **second** unvalidated pointer, the very
defect this plan exists to remove. Given the stabilization-first posture phase 2
may not follow soon, so phase 1 has to be correct standing alone. add the `sponsorId`
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
where: {
  OR: [
    { sponsorId },                          // tagged directly, incl. INCLUSIVE
    { promoCode: { sponsorId } },           // used the sponsor's code
    { group: { promoCode: { sponsorId } } },// a group used it, see below
  ],
}
```

**The third arm is not optional, and the first draft omitted it.** A group
registration puts the promo code on `RegistrationGroup.promoCodeId`
([group-registration-service.ts](../src/services/group-registration-service.ts)),
and every member registration has `promoCodeId = null`. A two-arm query returns
**zero** members of a twenty-person sponsor delegation, which is precisely the
shape a sponsor delegation takes. It would have demoed correctly on a single
registration and under-reported the case the feature exists for.

**Precedence when two sponsors both have a claim.** A registration can carry
`sponsorId = Pfizer` and have used `ABBOTT20`. Both arms match, so naive
per-sponsor totals sum to more than the event and an organiser billing off them
over-bills. **The direct `sponsorId` wins**, because it is the only one a human
chose; the code is circumstantial. Reports state the two numbers separately
(tagged / by code) rather than one total, so the ambiguity is visible instead of
averaged away.

**A redacted field must not stay filterable.** Once `sponsorId` is stripped for
MEMBER, a sponsor FILTER would hand the same fact back: filter to Abbott, read
the names. The filter is gated on the same predicate as the redaction. The
export needs no separate gate, `canExportRegistrations` already excludes MEMBER.

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
4. ~~Is `@@unique([eventId, name])` right?~~ **Answered by the audit**: the key
   is `(eventId, name, tier)`, matching what `upsert_sponsors` already treats as
   identity. Residual question: the CSV importer resolves a sponsor by NAME
   alone and refuses an ambiguous match, so under this key a name held at two
   tiers becomes permanently ambiguous to the importer. Acceptable, and worth
   knowing before someone reports it as a bug.

---

## 9. Adversarial audit of this plan (September 2, 2026)

The first draft was re-audited against source rather than re-read. Six defects,
three of which would have shipped. All are corrected above; they are recorded
here because the failure mode is worth naming: **the current state was verified
carefully and the proposed design was then not stressed against it.**

| | Defect | Where it is fixed |
|---|---|---|
| HIGH | The union query missed every group registration, so a sponsor's 20-person delegation returned zero rows | §6, third arm |
| HIGH | Sponsor attribution was not finance-redacted while the payer is, and the plan widened access to it with a filter, an export column and a report | §2 decision 3 |
| HIGH | `Restrict` risks failing event deletion, and contradicted the sub-theme precedent the plan itself cites | §3, now `SetNull` plus an app guard |
| MED | `@@unique([eventId, name])` contradicted `upsert_sponsors`' own (name, tier) identity | §3 |
| MED | Phase 1 added a second unvalidated pointer, doubling the defect if phase 2 never lands | §6 |
| MED | Two sponsors could both claim one registration with no precedence rule, so totals over-count | §6 |

One thing the draft made sound more expensive than it is: `@@index([sponsorId])`
already exists on `Registration`, and the schema comment there already states
the intent is to group "all Abbott-sponsored attendees". The filter needs no
index work.

---

## 10. Verification

Per phase: `npx tsc --noEmit`, `npm run lint`, full vitest, `npm run build`.
Phase 2 additionally needs the tenancy harness green and a migration replayed
from empty, and the backfill rehearsed on the local prod copy with a count
assertion on both sides before `--write`. The refusals in §4 are the parts to
mutation-verify: a guard that cannot fail is not a guard.
