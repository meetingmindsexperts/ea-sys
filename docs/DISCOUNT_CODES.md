# Discount / Promo Codes — Implementation Plan

## Context

EA-SYS has a complete registration and payment flow (TicketType → PricingTier → Registration → Stripe Checkout → Payment → Invoice) but no discount or promo code functionality. Organizers need to offer discounts to specific groups (early supporters, speakers, sponsors, VIPs) via redeemable codes applied during registration.

---

## 1. Prisma Schema

### New Models

**PromoCode** — event-scoped discount code definition

```prisma
model PromoCode {
  id               String       @id @default(cuid())
  eventId          String
  code             String       // e.g. "EARLYBIRD20", stored uppercase
  description      String?      @db.Text
  discountType     DiscountType // PERCENTAGE or FIXED_AMOUNT
  discountValue    Decimal      @db.Decimal(10, 2) // 20.00 = 20% or $20
  currency         String?      // required for FIXED_AMOUNT, null for PERCENTAGE
  maxUses          Int?         // null = unlimited
  maxUsesPerEmail  Int?         @default(1)
  usedCount        Int          @default(0) // atomic counter
  validFrom        DateTime?
  validUntil       DateTime?
  isActive         Boolean      @default(true)
  createdAt        DateTime     @default(now())
  updatedAt        DateTime     @updatedAt

  event            Event        @relation(fields: [eventId], references: [id], onDelete: Cascade)
  ticketTypes      PromoCodeTicketType[]
  redemptions      PromoCodeRedemption[]

  @@unique([eventId, code])
  @@index([eventId])
  @@index([code])
}

enum DiscountType {
  PERCENTAGE
  FIXED_AMOUNT
}
```

**PromoCodeTicketType** — restricts code to specific ticket types (empty = applies to all)

```prisma
model PromoCodeTicketType {
  id           String     @id @default(cuid())
  promoCodeId  String
  ticketTypeId String

  promoCode    PromoCode  @relation(fields: [promoCodeId], references: [id], onDelete: Cascade)
  ticketType   TicketType @relation(fields: [ticketTypeId], references: [id], onDelete: Cascade)

  @@unique([promoCodeId, ticketTypeId])
  @@index([promoCodeId])
  @@index([ticketTypeId])
}
```

**PromoCodeRedemption** — audit trail of every code use

```prisma
model PromoCodeRedemption {
  id              String   @id @default(cuid())
  promoCodeId     String
  registrationId  String   @unique
  email           String
  originalPrice   Decimal  @db.Decimal(10, 2)
  discountAmount  Decimal  @db.Decimal(10, 2)
  finalPrice      Decimal  @db.Decimal(10, 2)
  createdAt       DateTime @default(now())

  promoCode       PromoCode    @relation(fields: [promoCodeId], references: [id], onDelete: Cascade)
  registration    Registration @relation(fields: [registrationId], references: [id], onDelete: Cascade)

  @@index([promoCodeId])
  @@index([email])
}
```

### Modifications to Existing Models

**Registration** — add denormalized discount fields:
```prisma
promoCodeId      String?
discountAmount   Decimal?      @db.Decimal(10, 2)
originalPrice    Decimal?      @db.Decimal(10, 2)
promoCode        PromoCode?    @relation(fields: [promoCodeId], references: [id])
promoRedemption  PromoCodeRedemption?
@@index([promoCodeId])
```

**Invoice** — add discount snapshot fields:
```prisma
discountCode     String?
discountAmount   Decimal       @default(0) @db.Decimal(10, 2)
// subtotal = original price, total = (subtotal - discountAmount) + taxAmount
```

**Event** — add relation: `promoCodes PromoCode[]`

**TicketType** — add relation: `promoCodeLinks PromoCodeTicketType[]`

---

## 2. Pricing Flow (with discount)

```
Original Price (from PricingTier or TicketType)
  → Apply Discount (percentage or fixed, capped at original price)
  → Discounted Subtotal = max(0, originalPrice - discountAmount)
  → Tax = discountedSubtotal × taxRate / 100
  → Total = discountedSubtotal + tax
```

**Key rule:** Discount is applied BEFORE tax. Tax is calculated on the discounted amount.

If discount makes price 0 → `paymentStatus = "PAID"` (skip checkout entirely).

---

## 3. API Routes

### Admin APIs (authenticated, `denyReviewer` guarded)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/events/[eventId]/promo-codes` | List all promo codes with usage stats |
| POST | `/api/events/[eventId]/promo-codes` | Create promo code |
| GET | `/api/events/[eventId]/promo-codes/[promoCodeId]` | Detail with redemption history |
| PUT | `/api/events/[eventId]/promo-codes/[promoCodeId]` | Update promo code |
| DELETE | `/api/events/[eventId]/promo-codes/[promoCodeId]` | Deactivate (or hard-delete if unused) |

**Zod schema:**
```ts
z.object({
  code: z.string().min(1).max(50).transform(v => v.toUpperCase().trim()),
  description: z.string().max(2000).optional(),
  discountType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]),
  discountValue: z.number().min(0.01),
  currency: z.string().max(10).optional(),   // required for FIXED_AMOUNT
  maxUses: z.number().int().min(1).nullable().optional(),
  maxUsesPerEmail: z.number().int().min(1).nullable().optional().default(1),
  validFrom: z.string().datetime().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  isActive: z.boolean().default(true),
  ticketTypeIds: z.array(z.string()).optional(), // empty = all ticket types
}).refine(d => d.discountType !== "PERCENTAGE" || d.discountValue <= 100)
  .refine(d => d.discountType !== "FIXED_AMOUNT" || d.currency)
```

### Public Validation API (no auth, rate-limited)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/public/events/[slug]/validate-promo` | Preview discount without redeeming |

Request: `{ code, ticketTypeId, pricingTierId?, email }`

Response: `{ valid, discountType, discountValue, discountAmount, originalPrice, finalPrice, code }`

Validates: active, date range, maxUses, maxUsesPerEmail, ticket type applicability. Does NOT increment `usedCount`.

Rate limit: 10 requests per 15 min per IP (prevent enumeration).

---

## 4. Registration Route Modifications

**File:** `src/app/api/public/events/[slug]/register/route.ts`

### Add to schema (line ~15):
```ts
promoCode: z.string().max(50).optional(),
```

### Inside `db.$transaction` (after soldCount increment, ~line 296):

```ts
let discountAmount = 0;
let originalPrice = effectivePrice;
let promoCodeRecord = null;

if (promoCode) {
  promoCodeRecord = await tx.promoCode.findUnique({
    where: { eventId_code: { eventId: event.id, code: promoCode.toUpperCase().trim() } },
    include: { ticketTypes: { select: { ticketTypeId: true } } },
  });

  if (!promoCodeRecord || !promoCodeRecord.isActive) throw new Error("INVALID_PROMO_CODE");

  // Date range
  const now = new Date();
  if (promoCodeRecord.validFrom && now < promoCodeRecord.validFrom) throw new Error("INVALID_PROMO_CODE");
  if (promoCodeRecord.validUntil && now > promoCodeRecord.validUntil) throw new Error("INVALID_PROMO_CODE");

  // Ticket type applicability
  if (promoCodeRecord.ticketTypes.length > 0) {
    if (!promoCodeRecord.ticketTypes.some(t => t.ticketTypeId === ticketTypeId))
      throw new Error("PROMO_CODE_NOT_APPLICABLE");
  }

  // Atomic usedCount increment (same pattern as soldCount)
  if (promoCodeRecord.maxUses !== null) {
    const updated = await tx.promoCode.updateMany({
      where: { id: promoCodeRecord.id, usedCount: { lt: promoCodeRecord.maxUses } },
      data: { usedCount: { increment: 1 } },
    });
    if (updated.count === 0) throw new Error("PROMO_CODE_EXHAUSTED");
  } else {
    await tx.promoCode.update({
      where: { id: promoCodeRecord.id },
      data: { usedCount: { increment: 1 } },
    });
  }

  // Per-email limit
  if (promoCodeRecord.maxUsesPerEmail !== null) {
    const emailUses = await tx.promoCodeRedemption.count({
      where: { promoCodeId: promoCodeRecord.id, email: email.toLowerCase() },
    });
    if (emailUses >= promoCodeRecord.maxUsesPerEmail) throw new Error("PROMO_CODE_EMAIL_LIMIT");
  }

  // Calculate discount
  if (promoCodeRecord.discountType === "PERCENTAGE") {
    discountAmount = originalPrice * Number(promoCodeRecord.discountValue) / 100;
  } else {
    discountAmount = Math.min(Number(promoCodeRecord.discountValue), originalPrice);
  }
  discountAmount = Math.round(discountAmount * 100) / 100;
}

const finalPrice = Math.max(0, originalPrice - discountAmount);
```

### Registration create data:
```ts
promoCodeId: promoCodeRecord?.id || null,
discountAmount: discountAmount > 0 ? discountAmount : null,
originalPrice: discountAmount > 0 ? originalPrice : null,
paymentStatus: finalPrice === 0 ? "PAID" : "UNPAID", // was effectivePrice === 0
```

### Create redemption record (inside tx):
```ts
if (promoCodeRecord && discountAmount > 0) {
  await tx.promoCodeRedemption.create({
    data: {
      promoCodeId: promoCodeRecord.id,
      registrationId: registration.id,
      email: email.toLowerCase(),
      originalPrice, discountAmount, finalPrice,
    },
  });
}
```

### Error handling (after transaction catch):
```ts
"INVALID_PROMO_CODE"        → 400 "Invalid or expired promo code"
"PROMO_CODE_NOT_APPLICABLE" → 400 "Promo code not applicable to this ticket type"
"PROMO_CODE_EXHAUSTED"      → 400 "Promo code usage limit reached"
"PROMO_CODE_EMAIL_LIMIT"    → 400 "Promo code already used with this email"
```

---

## 5. Checkout Route Modifications

**File:** `src/app/api/public/events/[slug]/checkout/route.ts`

Change price calculation (~line 70):
```ts
const originalPrice = Number(registration.pricingTier?.price ?? registration.ticketType.price);
const discountAmount = registration.discountAmount ? Number(registration.discountAmount) : 0;
const ticketPrice = Math.max(0, originalPrice - discountAmount);
```

Stripe line item reflects discounted amount (no changes needed — `ticketPrice` is already used for `unit_amount`). Tax calculated on discounted price (already the case).

---

## 6. Invoice Modifications

**File:** `src/lib/invoice-service.ts`

```ts
const price = Number(registration.pricingTier?.price ?? registration.ticketType.price);
const discountAmt = registration.discountAmount ? Number(registration.discountAmount) : 0;
const discountedPrice = Math.max(0, price - discountAmt);
const taxAmount = taxRate ? discountedPrice * (taxRate / 100) : 0;
const total = discountedPrice + taxAmount;
```

Invoice record:
```ts
subtotal: price,                                    // original price
discountCode: registration.promoCode?.code || null,
discountAmount: discountAmt,
taxAmount,                                          // on discounted price
total,                                              // discountedPrice + taxAmount
```

**Invoice/Receipt PDF** — add discount line between subtotal and tax:
```
Subtotal:              USD 500.00
Discount (EARLYBIRD20): -USD 100.00    ← new line (red)
VAT (5%):              USD 20.00       ← tax on 400, not 500
Total:                 USD 420.00
```

---

## 7. Payment Status API

**File:** `src/app/api/public/events/[slug]/payment-status/[registrationId]/route.ts`

Add to response:
```ts
originalPrice: registration.originalPrice ? Number(registration.originalPrice) : null,
discountAmount: registration.discountAmount ? Number(registration.discountAmount) : 0,
promoCode: registration.promoCode?.code || null,
```

The `ticketPrice` returned should be the **discounted** price.

---

## 8. UI Integration

### Public Registration Form

**File:** `src/app/e/[slug]/register/[category]/page.tsx`

- Add collapsible "Have a promo code?" section below ticket selection
- Input field + "Apply" button
- On click: POST to `/api/public/events/[slug]/validate-promo`
- Success: show green badge with discount preview ("20% off — you save $100")
- Error: show red message
- Include validated `promoCode` in registration submit payload

### Confirmation Page

**File:** `src/app/e/[slug]/confirmation/page.tsx`

Add discount row to price breakdown:
```tsx
{discountAmount > 0 && (
  <div className="flex justify-between text-sm">
    <span className="text-emerald-600">Discount ({promoCode})</span>
    <span className="text-emerald-600">-{currency} {discountAmount.toFixed(2)}</span>
  </div>
)}
```

### Admin: Promo Codes Management

**Option A:** New page at `src/app/(dashboard)/events/[eventId]/promo-codes/page.tsx`
**Option B:** Tab within the existing Registration Types page (`/tickets`)

Recommended: **Tab within Registration Types page** — promo codes are tightly coupled with ticket pricing.

UI:
- Table: code, type (% / fixed), value, usage (used/max), valid dates, status badge, actions
- "Add Promo Code" button → dialog form
- Edit/delete actions per row
- Expandable row showing redemption history (who used it, when, discount amount)

### Sidebar

No new sidebar entry needed — accessible via Registration Types page tab.

---

## 9. React Query Hooks

Add to `src/hooks/use-api.ts`:

**Query key:** `promoCodes: (eventId) => ["events", eventId, "promo-codes"]`

**Hooks:** `usePromoCodes`, `useCreatePromoCode`, `useUpdatePromoCode`, `useDeletePromoCode`

---

## 10. Edge Cases

| Case | Handling |
|------|----------|
| Discount exceeds price | `finalPrice = max(0, original - discount)` — becomes free ticket |
| 100% discount | paymentStatus = "PAID", skip checkout entirely |
| Currency mismatch (FIXED_AMOUNT) | Validate `promoCode.currency === ticketType.currency` at redemption |
| Code deleted after use | Redemption records preserved; Registration retains discount fields |
| Refund on discounted ticket | Credit note uses discounted amount (what was actually paid) |
| Registration deleted | PromoCodeRedemption cascade-deleted; `usedCount` may go stale (same known limitation as `soldCount`) |
| Concurrent redemptions | Atomic `updateMany` with `usedCount < maxUses` inside transaction (same pattern as ticket soldCount) |

---

## 11. Implementation Sequence

| Phase | What | Files | Complexity |
|-------|------|-------|------------|
| 1 | Schema + migration | `prisma/schema.prisma` | S |
| 2 | Admin CRUD API (2 route files) | `src/app/api/events/[eventId]/promo-codes/...` | M |
| 3 | Public validation API | `src/app/api/public/events/[slug]/validate-promo/route.ts` | S |
| 4 | Registration flow integration | `src/app/api/public/events/[slug]/register/route.ts` | M |
| 5 | Checkout + payment status | `checkout/route.ts`, `payment-status/.../route.ts` | S |
| 6 | Invoice + PDF updates | `invoice-service.ts`, `invoice-pdf.ts`, `receipt-pdf.ts` | M |
| 7 | React Query hooks | `src/hooks/use-api.ts` | S |
| 8 | Registration form UI (promo input) | `src/app/e/[slug]/register/[category]/page.tsx` | S |
| 9 | Confirmation page (discount display) | `src/app/e/[slug]/confirmation/page.tsx` | S |
| 10 | Admin promo codes UI (tab in tickets page) | `src/app/(dashboard)/events/[eventId]/tickets/page.tsx` | M |
| 11 | Lint + type check | `npm run lint && npx tsc --noEmit` | S |

---

## 12. Verification

1. Create a 20% promo code → register with it → verify discounted price, paymentStatus logic
2. Create a fixed $50 code on a $30 ticket → verify caps at $30 (free ticket)
3. Create a code with maxUses=2 → use it twice → verify third attempt fails
4. Create a code restricted to "VIP" ticket type → verify it rejects "Standard" registrations
5. Register with discount → go through Stripe checkout → verify Stripe charges discounted amount
6. Check invoice PDF shows: subtotal, discount line, tax on discounted amount, total
7. Delete a registration that used a code → verify redemption is cascade-deleted
8. Concurrent test: 2 simultaneous registrations with maxUses=1 → only one succeeds

---

## Critical Files

- `prisma/schema.prisma` — new models + Registration/Invoice field additions
- `src/app/api/public/events/[slug]/register/route.ts` — core integration (transaction, validation, redemption)
- `src/app/api/public/events/[slug]/checkout/route.ts` — discounted price to Stripe
- `src/lib/invoice-service.ts` — discount in invoice snapshot
- `src/lib/invoice-pdf.ts`, `src/lib/receipt-pdf.ts` — discount line in PDF
- `src/app/api/public/events/[slug]/payment-status/[registrationId]/route.ts` — return discount info
- `src/app/e/[slug]/register/[category]/page.tsx` — promo code input field
- `src/app/e/[slug]/confirmation/page.tsx` — discount display
- `src/hooks/use-api.ts` — React Query hooks
