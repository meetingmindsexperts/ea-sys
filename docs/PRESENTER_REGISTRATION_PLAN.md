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
| D3 | **Quote at submission, no Pay Now BY DEFAULT**, with a per-event organizer toggle to turn it back on | Revised twice on Aug 11: first to drop Pay Now, then to make that a default rather than a rule. `settings.presenterRegistration.payNowEnabled`, off by default, confirmation dialog on the way up. |
| D4 | **No presenter tiers configured -> fall back to today's free comp** | Nothing breaks on any existing event until an organizer sets rates. Matches how `abstractLimits` and `abstractPresentationTypes` default. |
| D5 | **A presenter registration DOES count, on its tier**, exactly like `PUBLIC_REGISTER` | Reversed Aug 11 after the owner asked what was consistent with the platform. Reasoning below. |
| D7 | **One email, not two: the fee rides in the submitter WELCOME** | Taken Aug 11 after seeing the real inbox: a presenter received the welcome AND, seconds later, the delegate `Your registration for X` carrying the quote. At that point nothing has been accepted, so the delegate wording claims a settled place at the event. The confirmation is suppressed on the `/submitter` door only. |
| D8 | **A presenter registration burns the presenter TIER's seat, capped** | Taken Aug 11 when running the flow showed the tier counter stuck at 0. Consistent with the Aug 6 group-registration ruling: a public self-service door sells the tier, so price carries allocation and a `Presenter Early Bird: 20 seats` limit is real. A staff GRANT still claims the ticket type, because a courtesy seat must not burn a paid one. |
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

**Interpretation, now built:** "no Pay Now" applies to the submission
confirmation. The registrant portal's Pay Now is left in place regardless,
because that IS the pay-later route; removing it too would leave no way to pay
at all except an organizer-sent reminder, which contradicts "pay later".

**Made an option, not a rule (owner, Aug 11).** Some events do want payment up
front, so `settings.presenterRegistration.payNowEnabled` turns it back on.
Off by default; enabling it is behind a confirmation, because the consequence
lands on every future submitter before their abstract has been read. The reader
is strict `=== true`, so a malformed blob resolves to "do not ask for money"
rather than to invoicing everyone.

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
  for free. **This is the reference implementation to reuse**, with one
  deliberate departure: no Pay Now (D3). Seat claim now applies (D5).
- **Picking the tier that is on sale now** is `pickCurrentPricingTier`
  ([current-pricing-tier.ts](../src/lib/current-pricing-tier.ts)).

The build is therefore mostly composition, not new machinery.

## 5. Build phases

- **Phase 1 (shipped, `f6e0d7d4`)** presenter tier family + predicate,
  `DEFAULT_TIER_NAMES` consolidated from three copies, redirect filter,
  `PUBLIC_SUBMITTER` into `TIER_CONSUMING_SOURCES`. Inert: nothing writes that
  source yet. **No migration needed**, the enum value has existed since June
  for exactly this path and had never been written once.
- **Phase 1b (shipped, `96b136c0`)** the Pay Now toggle + confirmation dialog.
  Inert until the doors land.
- **Phase 2a (shipped, `96f3a1c2`)** extracted the payable-create-and-link
  operation out of the grant-companion route into
  [presenter-registration.ts](../src/lib/presenter-registration.ts) and
  refactored that route onto it; `suppressPayNow` threaded through the
  confirmation email.
- **Phase 2b + 2c (shipped, `2cb325ae`)** the signup form's rate step and both
  abstract doors routed through
  [presenter-signup.ts](../src/lib/presenter-signup.ts), with the D4 comp
  fallback.
- **Phase 3 (shipped, `4c950a2a`)** the three defects that only appeared when
  the flow was RUN. See §9.

## 9a. D9: a presenter rate is not bookable as a delegate (Aug 12, 2026)

Found by the owner asking a plain question: what happens if I share the
Presenter tier's link?

**What happened.** Every pricing tier has its own public form URL
(`/e/<slug>/register/<tier-slug>`) and the Registration Types page has a
**Copy registration form link** button on each tier row. So
`/register/presenter-early-bird` rendered a fully working DELEGATE
registration form at the presenter price. The person got no abstract, no
speaker record, and consumed the presenter tier's seat allocation. Presenter
rates are usually set BELOW the delegate ones, so a forwarded link behaved like
a discount code with no code on it.

The auto-redirect at `/e/<slug>/register` had excluded presenter tiers since
Phase 1, which is exactly what made this easy to miss: the exclusion was real,
it just only covered the path nobody needed to be protected on.

**Decision (owner):** presenters register through the abstract signup. Three
layers, in the order that matters:

1. **The register API refuses the tier** (403 `PRESENTER_TIER_NOT_PUBLIC`,
   logged). This is the gate. The endpoint takes a `pricingTierId` directly, so
   a page-only refusal would have been theatre.
2. **The public page signposts** rather than dead-ending: a short branded page
   offering *Submit an abstract* and *I am attending as a delegate*.
3. **The copy-link button is hidden** on presenter tier rows, so the URL is not
   handed out by accident in the first place.

Delegate tiers are untouched, verified both ways against the running app:
presenter tier POST -> 403, delegate Early Bird POST -> 201.

**Doc correction.** The user guide claimed presenter tiers "never appear on the
public delegate registration link, so nobody can accidentally book a presenter
rate". Only the first half was true. Corrected.

## 9. What running it locally found

The build passed its gate three times before any of this surfaced. Each defect
was correct code that nothing reached, or two correct halves that disagreed.

**1. The tier's seat was never burned.** The row claimed the ticket type's seat
and would have released the presenter tier's, because the door never stamped
`createdSource` (so the service derived `ADMIN_DASHBOARD` from `source: "api"`)
*and* the service hardcoded a `ticketType` increment while the release path
picks its counter with `seatCounter()`. A guarded release floors at 0, so the
tier no-oped and the ticket type leaked upward forever: exactly the drift class
the June 29 fix existed to kill. Both sides now derive from `seatCounter()`, so
they cannot disagree again. Pinned in both directions, mutation-verified.

**2. Two emails, one of them wrong.** See D7.

**3. The welcome CTA pointed at the internal staff login.** `${appUrl}/login`
is the MM Group sign-in; a submitter landing there sees a different product
with no route back to their event. The identical defect was fixed Aug 6 for the
session-proposal confirmation and this door was missed.

**A trap worth remembering, from fix 2.** Adding `{{presenterFeeBlock}}` to the
DEFAULT template reached nobody: **24 events already had a saved
`submitter-welcome` row**, so the quote would have arrived attached with nothing
in the body explaining it. The token is therefore appended when the resolved
template does not carry it. *Editing a default template does not reach an event
that has already materialised its own copy.*

## 6. The change

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

## 7. Open questions

None. All decisions are recorded as D1 to D6. Retained for the record:

- **The 69 dead `Presenter` tiers.** Leave them, rename them to
  `Presenter Early Bird`, or delete? Recommended: leave. Renaming a tier that
  carries a price is a pricing change we should not make on an organizer's
  behalf, and the new pair is seeded only onto newly created registration types.
  Organizers add presenter rates per event when they want them, and until they
  do, D4 keeps that event on today's free comp. **Owner confirmed Aug 11: leave
  them as is.**

### How D5 was reversed, and why

The first answer was "do not count them", by analogy with speaker companions.
The owner asked what was actually consistent with the platform, and it is the
opposite.

`seatCounter` in [registration-seat.ts](../src/lib/registration-seat.ts)
excludes `SPEAKER_COMPANION` for a stated reason: *"faculty don't consume a
venue seat"*, and the comment is careful that the exclusion is by
`createdSource` and NOT by the Faculty ticket type, because an admin who puts
someone on that type through the normal create path DOES increment the counter.
The exclusion is narrow and specific to the auto-minted **comp** companion of an
invited speaker.

An abstract presenter is not that. They signed up through an unauthenticated
public door, on a priced tier, and were charged. By the platform's own test that
is `PUBLIC_REGISTER`, and excluding them would make the abstract door the only
public paid entrance that does not count.

D1 also removed the one argument that could have supported excluding them. The
Aug 6 group-registration rule burns the tier because *"one 40-person group
drains the discount budget invisibly and Early Bird never advances to Standard
for individual registrants."* Presenters now have their own ladder, so a
presenter burning Presenter Early Bird cannot touch delegate Early Bird. The
drain risk does not exist here.

**Counting is not capping**, which is what resolved the owner's concern.
Measured on prod Aug 11: 334 pricing tiers of which **0** carry a real cap, 148
registration types of which 6 do, and **0** events with Maximum Attendees set.
`soldCount` on an unlimited tier blocks nobody; it only makes the number true.
"Presenters are not capacity-managed" is an argument for leaving the quantity
unlimited, which is already the default, not for leaving them out of the count.
Not counting would silently under-report people who were charged, in
"Registrations by Tier", in revenue by tier, and in any venue cap set later:
the same class of defect as the June `soldCount` leak.

**Build consequence, and it is simpler than the original plan.** The new
`RegistrationCreatedSource` value joins `TIER_CONSUMING_SOURCES` and is excluded
from nothing. No new exclusion logic. The distinct source is still worth having
for traceability and reporting ("which registrations came from the abstract
door"), but it is no longer load-bearing for seat accounting. Faculty exclusion
is unaffected either way, since `EXCLUDE_FACULTY_WHERE` keys on the `isFaculty`
ticket type and a presenter sits on a real delegate type.

## 8. Not in scope

- Automatic refund on rejection.
- Any change to how accepted abstracts are comped or discounted; the existing
  payment-status and promo flows cover it.
- A presenter-specific email template. The standard registration confirmation
  carries the quote.
