# Payment Flow — End to End (Junior Developer Guide)

> **Who this is for:** a developer who has never touched EA‑SYS's money code and
> needs to understand, from zero, how a registration turns into money owed,
> money paid, an invoice, and a receipt. Read it top to bottom once; after that
> use it as a map.
>
> **Golden rule of this subsystem:** there is exactly **one** place that does the
> money math — [`src/lib/registration-financials.ts`](../src/lib/registration-financials.ts).
> Every screen, PDF, and email reads from it. If you ever compute VAT or a total
> "by hand" somewhere else, you have introduced a bug. Don't.

---

## 1. The mental model (read this first)

A **registration** is a person signed up for an event. Money attaches to it in
three layers. Keep these three ideas separate in your head — most confusion
comes from mixing them:

| Layer | Question it answers | Where it lives |
|-------|--------------------|----------------|
| **Price** | "How much *should* this person pay?" | `Registration.originalPrice`, the pricing tier, the ticket type |
| **Payment status** | "What *state* is the money in?" | `Registration.paymentStatus` (an enum) |
| **Payments** | "What money *actually arrived*?" | `Payment` rows (Stripe or manually recorded) |

The **balance due** is simply:

```
balance due = (price − discount + VAT) − money that actually arrived
```

That one line is the whole system. Everything below is just *how* each piece of
that equation gets filled in, safely, for the different ways people pay.

### The big picture in one diagram

```
                         ┌─────────────────────────┐
                         │   A person registers    │
                         └───────────┬─────────────┘
                                     │
             ┌───────────────────────┼───────────────────────────┐
             ▼                       ▼                             ▼
    ┌─────────────────┐   ┌─────────────────────┐     ┌───────────────────────┐
    │  PUBLIC, PAID   │   │  FREE / COMP /      │     │  ADMIN / ONSITE       │
    │  (self-service) │   │  SPONSOR-PAID       │     │  (staff creates it)   │
    └────────┬────────┘   └──────────┬──────────┘     └───────────┬───────────┘
             │                       │                            │
             ▼                       ▼                            ▼
   Stripe Checkout page      No payment needed           Staff records a manual
   (card entry)              paymentStatus =             payment (cash / bank /
             │               COMPLIMENTARY or            card-on-site)
             ▼               INCLUSIVE                            │
   Stripe calls our                 │                            ▼
   WEBHOOK when paid                │                   Payment row (status PAID)
             │                      │                   + reg flips to PAID
             ▼                      │                            │
   Payment row + reg PAID           │                            │
             └──────────────┬───────┴────────────────────────────┘
                            ▼
              ┌──────────────────────────────┐
              │  INVOICE (PDF) generated +   │
              │  emailed to the registrant   │
              └──────────────────────────────┘
```

There are only **three ways money moves**. Learn them as three flows (Sections
5, 6, 7). But first, learn the data and the math they all share (Sections 3–4).

---

## 2. Vocabulary (glossary)

- **Ticket type** (`TicketType`) — a category of registration, e.g. "Physician",
  "Allied Health". Has a base `price`. May have **pricing tiers**.
- **Pricing tier** (`PricingTier`) — a time-windowed price for a ticket type,
  e.g. "Early Bird — 250", "Standard — 350". A registration can point at one.
- **`originalPrice`** — the price we **stamped onto the registration at creation
  time**. This is the *authoritative* "should pay" number. We stamp it so that
  if the tier's price changes next week, this person's price doesn't silently
  change with it.
- **`discountAmount`** — money knocked off by a promo code (or a manual
  discount). Stored on the registration.
- **VAT / tax** — a percentage added on top, configured per event
  (`Event.taxRate` + `Event.taxLabel`). "VAT" is the default label.
- **`Payment`** — one row per real payment that arrived. Card payments come from
  Stripe; cash/bank/card‑on‑site come from an organizer recording them manually.
- **`paymentStatus`** — the enum describing the money state (see Section 8).
- **Invoice** — the PDF document. Pre‑payment it's a *quote/proforma*;
  post‑payment it's a *paid invoice*. Same numbering sequence.
- **Quote PDF** — the pre‑payment "here's what you owe" PDF attached to the
  confirmation email.

---

## 3. The money data model (where each number lives)

```
Event
 ├─ taxRate     (e.g. 5  → 5% VAT; null/0 → no VAT)
 └─ taxLabel    (e.g. "VAT")

TicketType
 ├─ price          (base price)
 ├─ virtualPrice   (price if the attendee chose VIRTUAL on a HYBRID event)
 └─ pricingTiers[] (PricingTier: name, price, currency, isActive, salesStart/End)

Registration
 ├─ originalPrice   (STAMPED "should pay" price — the authoritative base)
 ├─ discountAmount  (promo/manual discount)
 ├─ finalPrice      (originalPrice − discount, cached by the promo service)
 ├─ pricingTierId   (which tier, if any)
 ├─ ticketTypeId    (which ticket type)
 ├─ paymentStatus   (the money state enum)
 ├─ attendanceMode  (IN_PERSON | VIRTUAL — affects price + whether a barcode is minted)
 └─ payments[]      (the Payment rows)

Payment
 ├─ amount            (how much arrived)
 ├─ currency
 ├─ status            (PAID / PENDING / … — a PaymentStatus value)
 ├─ stripePaymentId   (set for Stripe payments; NULL for manual)
 ├─ cardBrand/cardLast4/paymentMethodType  (instrument details for reconciliation)
 ├─ paidAt            (authoritative settlement time)
 └─ metadata          (bank ref / receipt no. / who took the cash, etc.)

Invoice
 ├─ type     (INVOICE — legacy RECEIPT rows may still exist)
 ├─ status   (DRAFT / SENT / PAID / OVERDUE)
 └─ number   (per-event sequential, prefixed with the event code)
```

**Why `originalPrice` exists (important):** a pricing tier's price can change, a
tier can close, a ticket type can be edited. If every screen recomputed the
price live, a registrant's amount owed could change under their feet. So we
**freeze the price onto the registration when it's created**. `originalPrice` is
that frozen number. All the price-reading logic *prefers* it.

---

## 4. The two core algorithms (this is the heart of the system)

Everything money-related is built on two pure functions in
[`registration-financials.ts`](../src/lib/registration-financials.ts). "Pure"
means: no database, no network — you give them numbers, they give you numbers.
That's why they're easy to test and impossible to get inconsistent.

### 4a. `readRegistrationBasePrice(reg)` — "what should this person pay, before discount and tax?"

```
resolve base price:
  orig = number(reg.originalPrice)        // the stamped, authoritative price
  tier = number(reg.pricingTier?.price)   // fallback 1
  ticket = number(reg.ticketType?.price)  // fallback 2

  // ── The gotcha every developer must understand ──
  // A stamped originalPrice of EXACTLY 0 next to a real, priced tier means the
  // price wasn't re-stamped when the tier was assigned. Prefer the tier price.
  if orig === 0 AND tier is a real number > 0:
      return tier

  // Otherwise: prefer the stamped price, then tier, then ticket, else 0.
  return orig ?? tier ?? ticket ?? 0
```

**Why the special case?** JavaScript's `??` ("nullish coalescing") only falls
through on `null`/`undefined` — **not on `0`**. So `0 ?? 250` is `0`, not `250`.
Without the guard, a registration stamped `originalPrice = 0` but sitting on an
"Early Bird — 250" tier resolved its price to **0**, and the UI showed *"Free
registration / no price set yet"* even though the tier clearly said 250. That
was a real production bug (fixed July 2026). A genuine free comp has **no priced
tier**, so it correctly stays `0`. This is the single most surprising line in
the subsystem — read it twice.

There is a sibling function `resolveRegistrationBasePrice({attendanceMode,
virtualPrice, tierPrice, ticketTypePrice})` used **at creation time** to compute
the number we *stamp* into `originalPrice`. VIRTUAL registrations price off
`virtualPrice`; in-person price off the tier (or ticket) price.

### 4b. `computeRegistrationFinancials(input)` — "turn the base price into the full breakdown"

Input: `{ subtotal, discount, taxRate, taxLabel, currency, totalPaid }`.
`subtotal` is what `readRegistrationBasePrice` returned.

```
compute financials:
  subtotal    = max(0, subtotal)
  discount    = max(0, discount)
  taxRate     = max(0, taxRate)            // percent, e.g. 5

  taxableBase = max(0, subtotal − discount)      // discount applies BEFORE tax
  taxAmount   = round2(taxableBase × taxRate / 100)
  total       = round2(taxableBase + taxAmount)   // ← the VAT-inclusive amount
  balanceDue  = round2(max(0, total − totalPaid))

  isPaidInFull        = balanceDue ≤ 0.01          // 1-cent float tolerance
  hasOutstandingBalance = NOT isPaidInFull AND total > 0
```

**Worked example (the "65 vs 68" case):** ticket base **65**, event VAT **5%**,
no discount, nothing paid yet:

```
subtotal    = 65
taxableBase = 65 − 0 = 65
taxAmount   = 65 × 5 / 100 = 3.25
total       = 68.25        ← this is what the attendee actually pays
balanceDue  = 68.25
```

So if an organizer records a manual payment and types **65** (the pre‑VAT
number), the registration is **short by 3.25**. The correct amount to record is
the **total, 68.25**. That's why the record‑payment dialog *prefills the total*
(Section 7) — so nobody types the pre‑VAT figure by mistake.

**Rounding:** `round2` avoids binary‑float drift (`1.005 → 1.01`). The 1‑cent
`isPaidInFull` tolerance handles totals like `0.004` left after several partial
bank transfers.

Where does the detail sheet / PUT / GET call this? The registration detail API
([route.ts](../src/app/api/events/%5BeventId%5D/registrations/%5BregistrationId%5D/route.ts))
attaches the result as a `financials` object on the registration it returns, and
the UI ([registration-detail-sheet.tsx](../src/app/%28dashboard%29/events/%5BeventId%5D/registrations/registration-detail-sheet.tsx))
renders straight from it. **Non‑finance roles** (e.g. MEMBER, ONSITE) get the
whole `financials` block stripped by `redactFinancialFields` — they never see
amounts.

---

## 5. Flow A — Public paid registration (Stripe)

This is the self‑service path: a stranger fills the public form and pays by card.

```
1. Public registration form  →  POST /api/public/events/[slug]/register
      • creates the Registration (the public route has its own create logic;
        admin/MCP creates go through registration-service.createRegistration)
      • stamps originalPrice, mints an entry barcode (qrCode) for in-person
      • paymentStatus starts UNPAID (paid ticket) or COMPLIMENTARY (free)
        NOTE: the admin/service-created default is UNASSIGNED, not UNPAID —
        different entry points, same "money still owed" meaning (Section 8).
      • sends the confirmation email WITH the quote PDF attached
                                   │
2. Registrant clicks "Pay now"  →  POST /api/public/events/[slug]/checkout
      • rate-limited per IP (anti-abuse)
      • basePrice  = readRegistrationBasePrice(reg)
      • ticketPrice = max(0, basePrice − discountAmount)
      • taxAmount   = ticketPrice × event.taxRate / 100
      • builds TWO Stripe line items:  [ ticket ]  +  [ VAT ]
      • creates a Stripe Checkout Session (mode: "payment")
      • metadata.registrationId = <id>   ← how the webhook finds us later
      • flips paymentStatus → PENDING, redirects the browser to Stripe
                                   │
3. Stripe hosts the card page, charges the card, then calls our WEBHOOK
                                   │
4. POST /api/webhooks/stripe   (event type: checkout.session.completed)
      • FIRST verify the signature: stripe.webhooks.constructEvent(body, sig, secret)
        (never trust an unsigned webhook — see Security)
      • look up the registration by metadata.registrationId
      • IDEMPOTENCY GUARD: if paymentStatus is already PAID → stop (Stripe
        retries webhooks; we must not double-insert)
      • pull the PaymentIntent's latest charge to capture:
          receiptUrl, cardBrand, cardLast4, paymentMethodType, paidAt
      • in ONE transaction:
          - re-check status != PAID, then set paymentStatus = PAID
          - insert a Payment row (status PAID, stripePaymentId set)
      • fire-and-forget (failures logged, never block the 200 response):
          - sendPaymentConfirmationEmail(...)
          - createPaidInvoice(...)  →  sendInvoiceEmail(...)
```

**Key files:** [checkout/route.ts](../src/app/api/public/events/%5Bslug%5D/checkout/route.ts),
[webhooks/stripe/route.ts](../src/app/api/webhooks/stripe/route.ts),
[stripe.ts](../src/lib/stripe.ts).

**Why the amount is split into two Stripe line items** (ticket + VAT) instead of
using Stripe's automatic tax: we control the VAT number ourselves so it exactly
matches the quote PDF and the invoice. One source of truth, again.

**Zero‑decimal currencies:** Stripe wants integer "minor units" (cents). But some
currencies (JPY, KRW) have *no* minor unit. `toStripeAmount` / `fromStripeAmount`
+ `isZeroDecimalCurrency` in [stripe.ts](../src/lib/stripe.ts) handle the ×100 (or
not) so you never send Stripe 100× the intended charge. Always convert through
these helpers — never multiply by 100 yourself.

**If the payment fails or the session expires** (`payment_intent.payment_failed`
/ `checkout.session.expired`): the webhook flips `PENDING → UNPAID` so the
registrant can try again.

---

## 6. Flow B — Free / complimentary / sponsor‑paid

No card is ever charged. The registration is created with a payment status that
means "no money is owed from the attendee":

- **`COMPLIMENTARY`** — a genuine no‑charge (VIP, speaker, free ticket type).
  The default when a ticket type's price is `0`.
- **`INCLUSIVE`** — a **sponsor** paid a lump sum offline to cover this seat.
  Requires a `sponsorId` pointing at an entry in `Event.settings.sponsors[]`.
  This is **orthogonal to price**: the seat may have a real price, but the
  attendee owes nothing because the sponsor covers it. The historical sponsor
  attribution is preserved even if the status later changes.

For both, the Payment Summary shows *"no payment due"* and the checkout / Pay‑Now
path is suppressed. No `Payment` row, no Stripe, no invoice email (unless an
admin issues one).

`createRegistration` in
[registration-service.ts](../src/services/registration-service.ts) decides the
default: **`UNASSIGNED`** for a paid ticket (money owed, not yet paid),
**`COMPLIMENTARY`** for a free ticket or no ticket type.

---

## 7. Flow C — Admin / onsite manual payment

An organizer at the registration desk takes cash, a bank transfer, or swipes a
card on a terminal, and **records** that it happened. There is no Stripe here —
we're writing down a fact.

```
Organizer clicks "Record Payment" on the registration detail sheet
                                   │
   The dialog PREFILLS the amount with financials.balanceDue
   (the VAT-INCLUSIVE total, e.g. 68.25 — NOT the pre-VAT 65)
   and shows a Subtotal / VAT / Total breakdown so it's obvious
   the number already includes tax.
                                   │
   POST /api/events/[eventId]/registrations/[registrationId]/payments
      • pick a method: bank_transfer | card_onsite | cash
        (each has its own required fields: bank ref, card last4, who took cash)
      • IDEMPOTENCY GUARD: if the reg is already PAID and has a Payment row → 409
      • if no amount was supplied, fall back to:  fin.total   ← the VAT-inclusive total
      • in ONE transaction:
          - flip paymentStatus → PAID
          - insert a Payment row (status PAID, stripePaymentId = NULL,
            method details saved in metadata)
      • fire-and-forget: createPaidInvoice(...) → sendInvoiceEmail(...)
```

**Key files:** [payments/route.ts](../src/app/api/events/%5BeventId%5D/registrations/%5BregistrationId%5D/payments/route.ts),
[record-payment-dialog.tsx](../src/components/payments/record-payment-dialog.tsx).

**The important lesson here:** a manual payment records *the amount the attendee
actually paid*. If VAT applies, that amount is the **VAT‑inclusive total**. The
dialog prefills it for you (from `computeRegistrationFinancials(...).total`) so
you don't have to add tax in your head — but if you *override* it with a smaller
number, the system faithfully records exactly what you typed and the balance
stays open. Type the total, not the base.

---

## 8. `PaymentStatus` — the state machine

```
UNASSIGNED     paid ticket, no money owed decision recorded yet (admin-created default)
UNPAID         money owed, not paid (self-service default after a failed/abandoned checkout)
PENDING        a Stripe checkout is in progress (waiting for the webhook)
PAID           money arrived (Stripe or manual)
COMPLIMENTARY  genuine no-charge (VIP / free ticket)
INCLUSIVE      a sponsor is paying (needs sponsorId)
REFUNDED       money was returned (DB flag only — see refunds)
FAILED         a charge attempt failed
```

**"Owes money" set** (`OUTSTANDING_PAYMENT_STATUSES`): `UNASSIGNED`, `UNPAID`,
`PENDING`. These are the statuses for which we attach a **quote PDF** to the
confirmation email and allow re‑tiering / promo application. `PAID`,
`COMPLIMENTARY`, `INCLUSIVE`, `REFUNDED` mean "don't ask this person for money."

**Which statuses an admin can set by hand** (`MANUAL_PAYMENT_STATUSES`):
`UNASSIGNED`, `UNPAID`, `PAID`, `COMPLIMENTARY`, `INCLUSIVE`. The Stripe‑driven
ones (`PENDING`, `REFUNDED`, `FAILED`) are owned by the webhook / refund flow,
not the dropdown.

---

## 9. Pricing tiers & the "courtesy re‑tier"

A ticket type can have tiers (Early Bird / Standard / Onsite). Normally the tier
is chosen at registration. But organizers sometimes want to give a late
registrant the **Early Bird price as a courtesy** — even at the door.

The registration **PUT**
([route.ts](../src/app/api/events/%5BeventId%5D/registrations/%5BregistrationId%5D/route.ts))
supports this via `pricingTierId`, gated by rules:

```
re-tier is allowed only when:
  • the registration is UNPAID/UNASSIGNED/PENDING  (never re-price a paid seat)
  • no promo/discount is currently applied          (would double-count — remove it first)
  • the tier belongs to this registration's ticket type
when allowed:
  • RE-STAMP originalPrice = the tier's price   ← so every surface reflects the new price
  • move the seat counter to the new tier
```

**Crucial detail you'll trip on:** after any inline edit, the PUT recomputes and
returns the fresh `financials` block (same as the GET), so the detail sheet's
Payment Summary updates immediately. If it didn't, the dropdown would show the
new tier while the summary showed a stale/zero price. (This was a real bug —
the PUT used to return the row *without* `financials`.)

---

## 10. Promo codes & discounts

[promo-code-service.ts](../src/services/promo-code-service.ts) applies a code to
a registration:

```
apply promo:
  basePrice     = readRegistrationBasePrice(reg)
  discountAmount = (type PERCENTAGE) ? basePrice × pct / 100
                                     : min(fixedAmount, basePrice)
  finalPrice     = max(0, basePrice − discountAmount)
  store on the registration: discountAmount, finalPrice, originalPrice (=basePrice)
  increment PromoCode.usedCount  ATOMICALLY, guarded by  usedCount < maxUses
```

The **discount is applied before VAT** (see the `taxableBase` line in Section
4b). Removing a promo decrements `usedCount` (guarded so it never goes below 0)
and clears the discount. Only **unpaid** registrations can have a promo applied,
same as re‑tiering — for the same reason (never silently change a settled
charge).

---

## 11. Invoices & the quote PDF

There are two documents, one code path:

- **Before payment** → a **quote / proforma** PDF
  ([quote-pdf.ts](../src/lib/quote-pdf.ts)), attached to the confirmation email.
  No `Invoice` DB row is created here.
- **After payment** → a **paid invoice** PDF
  ([invoice-pdf.ts](../src/lib/invoice-pdf.ts)), created by
  `createPaidInvoice(...)` and emailed via `sendInvoiceEmail(...)`.

`createPaidInvoice` in
[invoice-service.ts](../src/lib/invoice-service.ts) is careful about numbering:

```
createPaidInvoice:
  if an admin already created an INVOICE for this reg (status SENT/DRAFT/OVERDUE):
      PROMOTE it in place → status PAID  (keeps the same invoice number)
  else:
      mint a NEW INVOICE with status PAID
```

This prevents "one event, two invoice numbers for the same registration." Invoice
numbers are sequential **per event**, prefixed with the event code. (Historical
`RECEIPT`‑type rows may exist in the DB; the system now only emits `INVOICE`.
`createReceipt` is a backward‑compat alias of `createPaidInvoice`.)

Both PDFs read their line items and VAT from the **same** financials math, so the
quote a registrant sees and the invoice they later receive always agree.

---

## 12. Refunds

Refunds flip `paymentStatus → REFUNDED`. **This is a DB flag only** — it does
**not** call Stripe to move money. Actually returning funds is done in the Stripe
dashboard (or a dedicated flow) by a human; the platform records the decision and
can issue a **credit note** (`createCreditNote` in
[invoice-service.ts](../src/lib/invoice-service.ts)). `originalPrice` and the
sponsor attribution are preserved so the history stays intact.

---

## 13. Idempotency & safety (why the code looks paranoid)

Money code must survive being run twice. Three defenses you'll see repeated:

1. **Webhook double‑delivery.** Stripe retries webhooks. The handler checks
   `paymentStatus === "PAID"` and bails before inserting a second `Payment`.
   `stripePaymentId` is also `@unique`.
2. **Manual double‑click.** The manual‑payment route returns `409` if the reg is
   already `PAID` with a payment on file.
3. **Concurrent seat claims.** Capacity is guarded by an **atomic** DB update
   (`soldCount < quantity` predicate) inside a transaction, so two people can't
   both grab the last seat. See [registration-seat.ts](../src/lib/registration-seat.ts)
   (`planSeatTransition`, `seatCounter`, `holdsSeat`, `needsQrCode`) and
   [registration-seat-db.ts](../src/lib/registration-seat-db.ts) (`claimSeat`,
   `releaseSeat`). A VIRTUAL registration holds **no** venue seat.

Also: side effects that must never block the user (emails, invoice generation)
are **fire‑and‑forget** — wrapped so a mail‑server hiccup can't fail the payment.
Every failure is **logged** (this codebase's rule: no silent catches).

---

## 14. Security (non‑negotiables)

- **Verify the Stripe webhook signature** with `stripe.webhooks.constructEvent`
  before trusting *anything* in the body. An unsigned/forged webhook is rejected.
- **Rate‑limit** the public checkout per IP.
- **Finance visibility:** the `financials` block, payments, and billing are
  stripped for non‑finance roles by `redactFinancialFields` — a MEMBER or ONSITE
  user physically cannot pull amounts out of the API, even with a crafted
  request.

---

## 15. Where to look — file map

| Concern | File |
|--------|------|
| The money math (VAT, totals, base price) | [src/lib/registration-financials.ts](../src/lib/registration-financials.ts) |
| Stripe SDK + currency helpers | [src/lib/stripe.ts](../src/lib/stripe.ts) |
| Start a card payment | [src/app/api/public/events/[slug]/checkout/route.ts](../src/app/api/public/events/%5Bslug%5D/checkout/route.ts) |
| Receive the paid confirmation | [src/app/api/webhooks/stripe/route.ts](../src/app/api/webhooks/stripe/route.ts) |
| Record a manual/onsite payment | [src/app/api/events/[eventId]/registrations/[registrationId]/payments/route.ts](../src/app/api/events/%5BeventId%5D/registrations/%5BregistrationId%5D/payments/route.ts) |
| Manual payment UI (prefill + breakdown) | [src/components/payments/record-payment-dialog.tsx](../src/components/payments/record-payment-dialog.tsx) |
| Create a registration (stamps price, defaults status) | [src/services/registration-service.ts](../src/services/registration-service.ts) |
| Re-tier / edit a registration (returns fresh financials) | [src/app/api/events/[eventId]/registrations/[registrationId]/route.ts](../src/app/api/events/%5BeventId%5D/registrations/%5BregistrationId%5D/route.ts) |
| Promo codes / discounts | [src/services/promo-code-service.ts](../src/services/promo-code-service.ts) |
| Invoice creation + numbering | [src/lib/invoice-service.ts](../src/lib/invoice-service.ts) |
| Invoice PDF / Quote PDF | [src/lib/invoice-pdf.ts](../src/lib/invoice-pdf.ts) · [src/lib/quote-pdf.ts](../src/lib/quote-pdf.ts) |
| Seat / capacity accounting | [src/lib/registration-seat.ts](../src/lib/registration-seat.ts) · [src/lib/registration-seat-db.ts](../src/lib/registration-seat-db.ts) |
| Detail sheet Payment Summary (reads `financials`) | [src/app/(dashboard)/events/[eventId]/registrations/registration-detail-sheet.tsx](../src/app/%28dashboard%29/events/%5BeventId%5D/registrations/registration-detail-sheet.tsx) |
| Tests pinning the math | [__tests__/lib/registration-financials.test.ts](../__tests__/lib/registration-financials.test.ts) |

---

## 16. Five things to remember forever

1. **One math function.** VAT and totals come from
   `computeRegistrationFinancials`. Never recompute them anywhere else.
2. **`originalPrice` is the frozen price.** Prefer it — but a stamped `0` next to
   a priced tier is a stamping gap; the base‑price reader handles that. `0 ?? x`
   is `0`, not `x` — this bites people.
3. **Discount before tax.** `taxableBase = subtotal − discount`, then VAT.
4. **A recorded payment is the VAT‑inclusive total.** The dialog prefills it so
   nobody records the pre‑tax base.
5. **Everything money survives being run twice.** Idempotency guards on the
   webhook, the manual route, and the seat counters are not optional.

---

*Last updated: July 2026. If you change how a total or VAT is computed, update
Section 4 and the tests in the same PR — this doc is the map juniors trust.*
