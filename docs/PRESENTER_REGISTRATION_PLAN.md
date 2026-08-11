# Presenter registration: abstract submitters pay like delegates

**Status: PLANNED, not built. Decisions complete (D1-D6), ready to build.**
Owner-driven, Aug 11 2026.

---

## 1. What the organizer asked for

> "Abstract submission should be the same registration. Abstract submission
> will have its own early bird, standard rates."
>
> "They can choose to pay later, but how do we get them early bird / standard
> like regular registrations. Accepted submissions, some can be complimentary,
> some can be paid, some can be discounted. Mostly it is pay later, but data
> has shown 1 out of 20-30 there are paid abstracts."

Two things in one: submitters should hold a **real registration** rather than a
free comp, and presenters should have their own **tier ladder** the way
delegates do.

## 2. Why the current setup is incoherent

There are two presenter paths and the free one wins automatically.

**The "Presenter" pricing tier does almost nothing.** It is a tier NAME with one
line of behaviour: the smart redirect at
[register/page.tsx](../src/app/e/%5Bslug%5D/register/page.tsx) picks the first
active tier in the order Early Bird -> Standard -> Onsite and skips anything
whose slug is exactly `presenter`, so nobody lands on it by accident and the
organizer shares `/e/{slug}/register/presenter` by hand.

Measured on prod, Aug 11 2026:

| | |
|---|---|
| Presenter tiers (auto-seeded on every registration type) | 69 |
| Currently active | 2 |
| With a non-zero price | 15 |
| **Registrations ever made on one** | **0** |
| Faculty comp registrations (`SPEAKER_COMPANION`) | **85**, all COMPLIMENTARY |

On the live MEHF 2027 it is not even a different price: `Physician` reads
`Early Bird=400, Standard=500, Onsite=500, Presenter=400`. Presenter equals
Early Bird and carries no meaning.

It is unused because the abstract door bypasses it: signing up at
`/e/{slug}/abstract/register` calls `ensureSpeakerCompanionRegistration` and
mints a **free Faculty comp**, so no presenter has ever had a reason to open a
paid presenter link.

## 3. Decisions taken

| # | Decision | Notes |
|---|---|---|
| D1 | Presenter rates are **tiers per profession**, not a separate registration type | `Presenter Early Bird` / `Presenter Standard` under Physician, Nurse, Student, ... Preserves per-profession pricing. Cost: ~6 tiers per type to maintain. |
| D2 | **The submitter picks their registration type at signup**, like a delegate | Deriving it from the `role` enum was rejected: events carry `Nurse` and `Member`, which the enum cannot express, and the enum carries `Pharma` / `Academia` / `Medical Devices`, which have no rate. |
| D3 | **Quote at submission, but NO Pay Now.** Pay-later only for now | Revised by the owner Aug 11 after the cost below was raised. The submitter learns the amount; the system does not invite immediate payment. |
| D4 | **No presenter tiers configured -> fall back to today's free comp** | Nothing breaks on any existing event until an organizer sets rates. Matches how `abstractLimits` and `abstractPresentationTypes` default. |
| D5 | **A presenter registration does NOT burn tier inventory** | Same posture as speaker companions, which `seatCounter` already excludes. Presenter counts are not capacity-managed. |
| D6 | **On rejection, nothing happens automatically** | The submitter decides: pay and attend, or do not pay and do not attend. The organizer may comp them. This is exactly what an unpaid registration already does, so there is nothing to build. |

### How D3 landed, recorded

The concern raised was that on the owner's own 1-in-20-30 figure roughly **29 of
every 30 submitters get comped after acceptance**, so inviting payment at
submission means 29 people are asked for money they will not owe, and refunds
for whoever pays anyway.

The owner's answer resolves it without holding the quote back: **send the quote,
offer no Pay Now.** The submitter sees the amount, which is what the quote is
for, and the system never invites a payment that is likely to be reversed.
Payment happens later, once the organizer has decided comp / paid / discounted.

**Interpretation to confirm at build time:** "no Pay Now" applies to the
submission confirmation email. The registrant portal's Pay Now is left in place,
because that IS the pay-later route; removing it too would leave no way to pay
at all except an organizer-sent reminder, which contradicts "pay later".

## 4. What already exists and needs nothing

- **Pay later** is simply an unpaid registration. The public register flow
  creates the row first and offers Pay Now on the confirmation page and in the
  registrant portal.
- **"Some complimentary"** is a payment-status flip to `COMPLIMENTARY`, already
  admin-settable from the registration detail sheet.
- **"Some discounted"** is the July 1 promo-code-on-an-existing-registration
  flow, organizer or registrant side.
- **Minting a payable registration for a speaker** is the Aug 5 payable branch
  of [grant-companion](../src/app/api/events/%5BeventId%5D/speakers/%5BspeakerId%5D/grant-companion/route.ts),
  which already calls `registration-service.createRegistration` and gets seat
  claim, payment-status defaulting, and the confirmation email with quote PDF
  for free. **This is the reference implementation to reuse**, with two
  deliberate departures: no seat claim (D5) and no Pay Now (D3).
- **Picking the tier that is on sale now** is `pickCurrentPricingTier`
  ([current-pricing-tier.ts](../src/lib/current-pricing-tier.ts)).

The build is therefore mostly composition, not new machinery.

## 5. The change

### 5.1 Tier naming and the one place that knows about it

Replace the dead single `Presenter` in `DEFAULT_TIER_NAMES`
([tickets/route.ts](../src/app/api/events/%5BeventId%5D/tickets/route.ts)) with
`Presenter Early Bird` and `Presenter Standard`.

Three surfaces need "is this a presenter tier?" (the redirect filter, the
submitter form's rate list, the abstract door's tier pick), so it becomes one
exported predicate rather than three string comparisons. The redirect filter
changes from an exact `!== "presenter"` to a prefix test, so any
`Presenter *` tier stays off the delegate path.

`DEFAULT_TIER_NAMES` is duplicated in
[tickets/page.tsx](../src/app/%28dashboard%29/events/%5BeventId%5D/tickets/page.tsx)
(twice) and the route. Consolidate while here.

### 5.2 Submitter signup gains a registration-type step

[submitter-register.tsx](../src/components/public/submitter-register.tsx)
(`variant="abstract"` only) gains a type picker listing each registration type
with its **current presenter rate**, resolved by `pickCurrentPricingTier` over
that type's presenter tiers. Session proposals are untouched.

### 5.3 The door creates a real registration

The abstract paths in
[submitter/route.ts](../src/app/api/public/events/%5Bslug%5D/submitter/route.ts)
and [abstract-start/route.ts](../src/app/api/public/events/%5Bslug%5D/abstract-start/route.ts)
stop calling `ensureSpeakerCompanionRegistration` for a comp and instead call
`createRegistration` with the chosen type and the active presenter tier, then
link the result as the speaker's `sourceRegistrationId`. Same shape as the
payable grant.

### 5.4 What does NOT change

- **Invited faculty stay free.** Organizer-added speakers (createSpeaker, CSV
  import, import-contacts, MCP bulk) keep the Faculty comp. Only *self-signup
  abstract submitters* pay. An invited speaker is not an abstract submitter.
- **Session proposals** stay `linkOnly` with the per-person grant (Aug 5).
- **The 85 existing comp companions** are left alone. Forward-only.

## 6. Open questions

All four are now answered; see D3 to D6 above. The only one left open is the
mechanical one:

- **The 69 dead `Presenter` tiers.** Leave them, rename them to
  `Presenter Early Bird`, or delete? Recommended: leave. Renaming a tier that
  carries a price is a pricing change we should not make on an organizer's
  behalf, and the new pair is seeded only onto newly created registration types.
  Organizers add presenter rates per event when they want them, and until they
  do, D4 keeps that event on today's free comp.

### Consequences of D5 worth building deliberately

A presenter registration must not touch either seat counter. The existing
mechanism is `seatCounter` in
[registration-seat.ts](../src/lib/registration-seat.ts), which already excludes
`SPEAKER_COMPANION`. This needs its own `RegistrationCreatedSource` value
(additive enum migration) rather than reusing `SPEAKER_COMPANION`, because these
are payable registrations and every faculty-exclusion rule keyed on
`SPEAKER_COMPANION` or the `isFaculty` ticket type would otherwise sweep them
out of the delegate counts they belong in.

## 7. Not in scope

- Automatic refund on rejection.
- Any change to how accepted abstracts are comped or discounted; the existing
  payment-status and promo flows cover it.
- A presenter-specific email template. The standard registration confirmation
  carries the quote.
