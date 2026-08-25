# Travel Grant

An abstract author based **outside the UAE** is offered a travel grant. The offer
rides as a block inside their submission-confirmation email and lands on a
token-gated consent form where they confirm they are not a UAE resident, that
they wish to be considered, and accept the event's terms. A UAE-based author sees
nothing at all.

**This file is the reference: what exists and where it lives.** The decisions and
the reasoning behind them are in
[TRAVEL_GRANT_PLAN.md](TRAVEL_GRANT_PLAN.md), which is the record and should not
be duplicated here. Operator-facing instructions are user-guide § Travel Grants.

## Build status

| # | Piece | State |
|---|---|---|
| 1 | Residency predicate + tests | ✅ shipped |
| 2 | Schema, migration, RLS policy, harness test | ✅ shipped |
| 3 | Settings toggle + the two Content editors | ✅ shipped |
| 4 | `buildTravelGrantBlock` + the confirmation-email wiring | ✅ shipped |
| 5 | Public consent form + its routes | ⬜ not built |
| 6 | Organizer console | ⬜ not built |
| 7 | Docs | ✅ this file + the user guide |

**An eligible author now receives the message and a link.** What is still
missing is the page that link opens (step 5) and the console (step 6), so do
not enable this on a live event until those land.

## The decision surface

Nine decisions are locked in the plan's §2. The four that shape the code:

- **D1** captures eligibility and interest only. **No amounts, no bank details,
  no passport.** Speaker Reimbursement owns the money, and duplicating any of it
  here would create two places to look for one person's payment information.
- **D2** one record per person per event, not per abstract.
- **D3** a block inside the existing confirmation email, not a second send.
- **D6** residency is the country selection on the author's profile, full stop.

## Where things live

| Concern | File |
|---|---|
| Eligibility predicate | [src/lib/travel-grant/eligibility.ts](../src/lib/travel-grant/eligibility.ts) |
| Per-event on/off | [src/lib/travel-grant/settings.ts](../src/lib/travel-grant/settings.ts) |
| Model + enum | `TravelGrant` / `TravelGrantStatus` in [schema.prisma](../prisma/schema.prisma) |
| Migration | `prisma/migrations/20260825120000_add_travel_grant` |
| RLS policy | [prisma/rls/travelgrant.sql](../prisma/rls/travelgrant.sql) |
| Isolation test | [tests/tenancy/travelgrant-rls.test.ts](../tests/tenancy/travelgrant-rls.test.ts) |
| Organizer switch | Settings → Abstracts |
| Organizer copy | Content → Abstracts (two editors) |

## Eligibility: the part that is easy to get wrong

`classifyResidency(country)` returns **`"uae" | "overseas" | "unknown"`**.
`isTravelGrantEligible()` is true only for `"overseas"`.

Three properties, each pinned by a mutation-verified test:

1. **The UAE alias set is an explicit enumeration.** `Speaker.country` holds a
   display name (`"United Arab Emirates"`), but `CountrySelect` resolves stored
   values on either code or name and the CSV importers write the column as raw
   free text, so `"AE"` and `"ARE"` are reachable. A
   `country !== "United Arab Emirates"` check classifies those as overseas and
   mails a Dubai resident a grant offer.
2. **A substring match is not acceptable.** `includes("ae")` classifies Israel as
   the UAE.
3. **Unrecognised input is `unknown`, never `overseas`.** This is the load-bearing
   one. `"Dubai"` is a reachable free-text value and **Dubai is in the UAE**.
   Emirate and city names are deliberately not enumerated: adding `dubai` invites
   an endless list whose gaps fail OPEN, while falling through to `unknown`
   covers all of them and fails CLOSED.

**Why three states and not a boolean.** A boolean makes "we do not know"
unrepresentable, so it has to be folded silently into one of the other two, and
D4 ("do not send, but flag it") would not be expressible or testable.

**How common is `unknown` in practice?** Measured on the local prod copy on
2026-08-25: 41 of 117 speakers have no country, **but none of them has a
non-draft abstract**, and 38 are manually-added faculty who never went through
the submitter form. `country` is in the mandatory set in
[submitter-profile-completeness.ts](../src/lib/submitter-profile-completeness.ts),
which is a hard 403 on submitting an abstract, so a new author cannot reach us
without one. The console listing is a safety net, not a daily workflow.

## Configuration

`Event.settings.travelGrant = { enabled: boolean }`. Settings JSON, no column,
no migration.

**The reader fails CLOSED and the check is `=== true`.** An absent key, a
corrupted blob, the string `"true"`, a `1` and a `null` all resolve to disabled,
because this flag decides whether we email people and a malformed blob that
switches itself on cannot be un-sent. `registrationOpen` defaults the other way
for the mirror-image reason: a missing key there would close registration on
every existing event. **The direction is chosen per flag by asking which mistake
is cheaper.**

Two organizer-authored texts, both `Event` columns, both edited under
Content → Abstracts:

- **`travelGrantMessageHtml`** renders in the confirmation email.
- **`travelGrantTermsHtml`** renders on the consent form and is **snapshotted
  onto the row at consent**, so a later edit changes what future authors see and
  never rewrites what somebody signed.

## Gotchas for whoever builds steps 4 to 6

- ✅ **The saved-template trap is handled** in `sendAbstractSubmissionConfirmation`
  and pinned by [travel-grant-saved-template.test.ts](../__tests__/lib/travel-grant-saved-template.test.ts).
  24 events hold a materialised `abstract-submission-confirmation` row, so the
  shipped default reaches none of them; the block is appended when the resolved
  template lacks the token. Do not "simplify" that away.
- **Resolve the org before the token lookup.** `token` is globally unique and
  plaintext, so under RLS a `findUnique({ token })` in the wrong lane returns
  nothing. The public route must bootstrap the org from the Event by host+slug
  first, exactly as `resolveReimbursementEventOrg` does. Get it backwards and
  every link fail-closes on the platform while passing every test on master,
  where RLS is off.
- **The console shows people who must not be emailed.** D7 lists every abstract
  author including UAE and unknown, directly above a "remind everyone pending"
  button. **That action must key off `status = PENDING` on existing rows, never
  off the rendered list.** A UAE author has no row at all, so a correct
  implementation cannot reach them; one written against the list would email
  every one of them.
- **The block must be failure-isolated.** A travel-grant error must never stop
  an abstract confirmation from being sent.
- **Only `SUBMITTED` triggers it.** A draft is not a submission.

## Security and access

- Console is `denyReviewer`, so SUPER_ADMIN / ADMIN / ORGANIZER. **MEMBER is
  deliberately excluded** even though MEMBER is internal read-only staff: this is
  a list of who has asked to have their travel paid for, which is a
  financial-adjacent decision list rather than an operational one.
- The token is a credential. Stored unique, never logged.
- Born tenancy-compliant: org stamped from the Event at create, flat RLS policy,
  harness assertions covering cross-tenant read, write, delete, org re-homing and
  the org-less write.
