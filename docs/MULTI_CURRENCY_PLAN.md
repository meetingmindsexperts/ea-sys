# Multi-currency pricing (USD / AED / EUR)

> **Status: PLANNED, NOT BUILT.** Written 2026-08-12 from a survey of the live
> code. Do not start without owner go-ahead.
>
> **Goal:** let an organizer price an event in a currency other than USD, with
> the currency set once at the EVENT level, as groundwork for tenants who do not
> bill in dollars.
>
> **Headline:** this is smaller than it looks. The survey below found the money
> paths already currency-aware in the places that matter. The real work is a
> dropdown, one new field, and inheritance.

---

## 1. Owner decisions

| # | Decision | Status |
|---|---|---|
| 1 | Currencies offered: **USD, AED, EUR** | DECIDED |
| 2 | **OMR dropped** from scope | DECIDED, see §7 |
| 3 | Currency is set at the **EVENT** level, not per registration type or tier | DECIDED |
| 4 | Free-text currency input becomes a **dropdown** | DECIDED |

Open questions are in §9.

---

## 2. What already works (verified 2026-08-12)

This section is the reason the plan is short. Each line was read in source, not
assumed.

**The charge itself is already currency-correct.**

- USD, AED and EUR are all **two-decimal**, so the existing `× 100` conversion to
  Stripe's smallest unit is already right for all three. No maths changes.
- The checkout session is created in the tier's currency, lowercased, passed
  straight to Stripe.
- The webhook records **`session.currency`**, which is Stripe's own answer about
  what was actually charged, in preference to our stored value
  ([stripe-webhook-handler.ts](../src/lib/stripe-webhook-handler.ts) line 154).
  So the books reflect what happened even if a price was edited afterwards.
- Refunds are denominated from **`settledPayments[0].currency`**, the Payment
  row, not from today's price ([payment-service.ts](../src/services/payment-service.ts)
  line 273). This matters: Stripe rejects a refund whose currency differs from
  the original charge, and this already reads the right source.

**Aggregation is already safe.** This was the part expected to be expensive, and
is not. Every money sum on the event side is one of:

- **grouped by currency already**: event analytics revenue does
  `groupBy: ["currency"]` ([event-analytics.ts](../src/lib/event-analytics.ts) line 237);
- **already guarded against mixing**: the payer roll-up returns null totals with
  `mixedCurrency: true` rather than adding AED to USD
  ([payer-breakdown.ts](../src/lib/payer-breakdown.ts));
- **scoped to a single registration**: the remaining ~10 `reduce(+ amount)` and
  `_sum` sites total one registration's payments or credit notes. These are safe
  provided a registration cannot hold two currencies, which is exactly what
  event-level currency guarantees.

There is **no org-wide revenue total** anywhere, so nothing sums across events.

**Other surfaces already carry the row's own currency**: quote, invoice, receipt
and credit-note PDFs; confirmation and payment emails; the manual Record Payment
dialog, which already offers USD and AED.

---

## 3. What is actually missing

1. **The currency field is free text and a bad value crashes the page.**
   [tickets/page.tsx](../src/app/%28dashboard%29/events/%5BeventId%5D/tickets/page.tsx)
   line 716 is a bare `<Input>`. `formatCurrency` uses `Intl.NumberFormat`, which
   throws `RangeError` on any non-ISO-4217 value. Verified: `Dirham`, `AE`, an
   empty string and even `"AED "` with a trailing space all throw. The tier list
   and the public registration form both break.

2. **Three divergent currency lists**, none of which agree:
   - org settings: `USD EUR GBP INR JPY AUD CAD` (7)
   - Record Payment dialog: `USD AED` (2)
   - CRM: `USD AED EUR GBP SAR` (5)

3. **No event-level currency.** `Event` has no currency column. Currency lives
   on `TicketType` and `PricingTier` independently, and only the TIER has a UI
   control, so a type with no tiers cannot be changed from USD at all.

4. **A dead org-level setting already exists.** `settings.currency` is written by
   the org settings page and **read by nothing**. Same shape as the dormant
   "Maximum Attendees" field before it was wired up. Decide whether event-level
   supersedes it or defaults from it (§9).

5. **Accommodation prices are a separate currency space.** `RoomType` and
   `Accommodation` carry their own `currency` columns, defaulting to USD, and are
   not part of the registration price. Decide whether they inherit the event
   currency (§9).

---

## 4. Design

**One currency per event, inherited downward.**

- New nullable `Event.currency`. Null means USD, so every existing event is
  unchanged and no backfill is required.
- Types and tiers keep their columns (historical rows must stay readable) but the
  UI stops offering a per-tier choice. New types and tiers are created with the
  event's currency.
- The existing read chain `pricingTier?.currency ?? ticketType?.currency ?? "USD"`
  gains an event step at the end, before the literal. There are roughly 10 such
  sites; the 72 other hardcoded `"USD"` strings outside the CRM are mostly
  fallbacks that stay correct.

**Lock the currency once money has moved.** Changing an event's currency after
the first settled payment silently re-denominates history: a 250 becomes 250 of
something else, and there is no correct answer for what the old rows meant. The
field should be editable freely until the first `Payment` exists on the event,
and refused afterwards with a message explaining why.

**Do not unify with the CRM lists.** The CRM prices sponsorship deals in AED by
default and is a different domain with its own money rules. Sharing one constant
would couple two things that legitimately disagree, the same reasoning as the
deliberately-separate visibility predicates.

---

## 5. Phases

| Phase | Scope | Size |
|---|---|---|
| 1 | Shared `EVENT_CURRENCIES` constant; tier currency input becomes a dropdown; crash fix | Small |
| 2 | `Event.currency` column, additive nullable; Settings control; inheritance on create; read chain extended | Medium |
| 3 | Lock-after-first-payment guard, server-enforced with a clear message | Small |
| 4 | Tests, and one real Stripe charge in AED (§8) | Small, but do not skip |

Phase 1 alone is shippable and removes a live crash. It does not enable AED
pricing on its own in a useful way, because the tier-level choice is the thing
being replaced, so 1 and 2 are best done together.

---

## 6. The Stripe dependency, which is not code

Two different currencies matter and are routinely conflated:

- **Presentment currency**: what the customer is charged in. That is what we send.
- **Settlement currency**: what lands in the bank. A property of the Stripe
  account.

Matching means no conversion. Differing means Stripe converts and takes an FX fee
on top of the processing fee. **A presentment currency that is not enabled on the
account makes checkout session creation fail**, which surfaces at the moment a
registrant clicks Pay.

**⚠ THE STRIPE ACCOUNT IS SHARED WITH EVENTSAIR** (confirmed 2026-08-14). A
`checkout.session.completed` with no metadata reached our webhook and turned
out to be a USD 100 payment for "OSHC2026", an event that lives in EventsAir,
not EA-SYS. Two consequences this plan has to carry:

1. **Settlement currency and enabled presentment currencies are NOT ours to
   change unilaterally.** Enabling AED or EUR, or changing settlement, affects
   EventsAir's payments on the same account. Whoever owns that side needs to
   agree before Phase 4.
2. **Stripe Dashboard totals are not EA-SYS revenue.** They mix both systems,
   so any figure read off Stripe overstates EA-SYS. `Payment` rows in our own
   database are the correct source, which is also why §2's "aggregation is
   already safe" claim holds only for OUR books.

Per-tenant Stripe keys ([PLATFORM_DECISIONS.md](PLATFORM_DECISIONS.md) item 7)
would separate the two, and this is a concrete argument for doing it before
multi-currency rather than after.

**Owner action before Phase 4:** in the Stripe Dashboard, check Settings →
Business → *Bank accounts and currencies* for the settlement currency, and the
payment-method/currency settings for which presentment currencies are enabled.
This cannot be answered from the codebase.

**Per-tenant relevance:** per-tenant Stripe keys are item 7 in
[PLATFORM_DECISIONS.md](PLATFORM_DECISIONS.md), decided but not built. Until they
exist, every charge runs through MMG's single account, so a second tenant's
"currency" is really "whatever MMG's account can present". The currency field
should be designed knowing the account constrains it.

---

## 7. Explicitly NOT in scope

- **OMR and the other three-decimal currencies** (BHD, JOD, KWD, TND). Omani rial
  has 1000 baisa. Stripe wants three-decimal amounts in the smallest unit and
  divisible by 10, so our `× 100` would send `1050` for OMR 10.500 and Stripe
  would charge **1.050, a tenth of the intended amount**, silently, with the
  webhook then recording the wrong figure. Supporting it means a three-decimal
  branch plus consolidating the **four** duplicated conversion sites
  (`toStripeAmount`, `fromStripeAmount`, and inline copies in checkout and
  group-checkout). Real work and a real money risk, deliberately deferred.
- **GBP, SAR and the rest.** Trivial to add later, all two-decimal; left out to
  keep the first list short.
- **FX display**, showing an approximate home-currency equivalent. Needs a rate
  source and a staleness policy.
- **Multi-currency within one event.** The whole design exists to prevent it.
- **Re-denominating historical events.** See the lock rule in §4.
- **Accommodation currency**, pending §9.

---

## 8. Test plan

Unit and route tests cover the dropdown, the inheritance chain and the lock
guard. Two things unit tests cannot cover:

1. **A real Stripe charge in AED**, small amount, on the live account. Verify
   four things, in order: the Dashboard shows the charge as AED, the `Payment`
   row records AED, the receipt PDF prints AED, and **a partial refund
   succeeds**. The refund is the step people skip, and it is where a currency
   mismatch actually surfaces.
2. **The RangeError**, which is a render-time crash rather than a test failure.
   Worth one case asserting the dropdown cannot emit an invalid code.

---

## 9. Open questions for the owner

1. **The dead `settings.currency`.** Delete it, or make it the default for new
   events? It currently does nothing.
2. **Accommodation.** Should `RoomType` prices inherit the event currency, or
   stay independent? Hotels sometimes quote in a different currency from the
   conference fee, so independent may be correct.
3. **Existing events.** Confirm they stay USD (null = USD) rather than being
   backfilled. Nothing on production is non-USD today: 148 registration types and
   all 5 payments ever taken are USD.
4. **Who may change it.** Event currency is finance-shaped. Restrict to
   ADMIN/ORGANIZER, or leave with the rest of event settings?

---

*Survey performed against the code and a read-only production query on
2026-08-12. Re-check §2 before starting if significant time has passed: its value
is that each claim was verified, and an unverified claim here is worse than none.*
