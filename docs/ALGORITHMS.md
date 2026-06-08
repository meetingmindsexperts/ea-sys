# Algorithms, Math Functions & Complex Logic

A comprehensive inventory of non-trivial logic patterns in the EA-SYS codebase.

---

## 1. Cryptography & Security

### AES-256-GCM Encryption

**File:** `src/lib/eventsair-client.ts`

- Derives a 256-bit key from `NEXTAUTH_SECRET` using SHA-256
- Generates a 16-byte random IV per encryption
- Encrypts plaintext with AES-256-GCM, appends auth tag
- Storage format: `{iv}:{authTag}:{ciphertext}` (all hex-encoded)
- Decryption reverses the process with auth tag verification

### SHA-256 Token Hashing

**File:** `src/lib/security.ts`

- Hashes verification tokens with a pepper (`NEXTAUTH_SECRET`) before storage
- Prevents token theft even if the database is compromised

### API Key Generation

**File:** `src/lib/api-key.ts`

- `crypto.randomBytes(32)` → hex encoding with a prefix
- Only the SHA-256 hash is stored in the database (not the plaintext key)
- First 12 characters retained as a display-safe prefix for UI masking

### Rate Limiting (Token Bucket / Sliding Window)

**File:** `src/lib/security.ts`

- In-memory store keyed by identifier (IP, user ID, etc.)
- Periodic cleanup: triggers when store exceeds 10,000 entries or 1 minute has elapsed
- Expired entries (where `resetAt <= now`) are pruned
- Per-request logic:
  - No entry or expired → set count = 1, allow
  - Count >= limit → deny, return `retry-after` seconds
  - Otherwise → increment count, allow
- Configurable per-endpoint (e.g., 3/60s for checkout, 20/15min for token GET, 5/15min for token POST)

---

## 2. Financial & Currency Math

### Zero-Decimal Currency Handling

**File:** `src/lib/stripe.ts`

- Set of 16 zero-decimal currencies: JPY, KRW, VND, BIF, CLP, DJF, GNF, ISK, KMF, MGA, PYG, RWF, UGX, XAF, XOF, XPF
- `toStripeAmount(amount, currency)`: zero-decimal → pass through; standard → `Math.round(amount * 100)`
- `fromStripeAmount(amount, currency)`: reverses the transformation

### Tax Calculation

**File:** `src/app/api/public/events/[slug]/checkout/route.ts`

```
taxAmount = ticketPrice * taxRate / 100
total = ticketPrice + taxAmount
```

- Tax and base price sent as separate Stripe line items
- `automatic_tax` disabled in favor of manual calculation

### Invoice Totals

**File:** `src/lib/invoice-service.ts`

- Subtotal, tax amount, and total computed from Prisma `Decimal` values converted to `Number`
- Due date defaults to 30 days from creation
- Supports INVOICE, RECEIPT, and CREDIT_NOTE document types

### Price-Based Payment Status

**File:** `src/app/api/events/[eventId]/import/registrations/route.ts`

```
Number(ticketType.price) === 0 ? "PAID" : "UNPAID"
```

---

## 3. Atomic Counters & Sequence Generation

### Invoice Numbering (Gap-Free)

**File:** `src/lib/invoice-numbering.ts`

- Runs inside `db.$transaction()` for atomicity
- Uses `upsert` with `increment: 1` on a per-event, per-type, per-year counter
- Format: `{eventCode}-{typeCode}-{sequenceNumber}` (e.g., `HFC2026-INV-001`)
- Separate counters for INVOICE, RECEIPT, and CREDIT_NOTE

### Registration Serial IDs

**File:** `src/lib/registration-serial.ts`

- Aggregate query: `db.registration.aggregate({ _max: { serialId: true } })`
- New serial = max + 1
- Zero-padded to 3 digits (001, 042, 100)

### Barcode Generation

**File:** `src/lib/utils.ts`

```
barcode = Date.now().toString() + Math.floor(Math.random() * 1000000).toString().padStart(6, "0")
```

- Timestamp (ms) + 6 random digits for uniqueness

---

## 4. CSV Parsing (RFC 4180)

**File:** `src/lib/csv-parser.ts`

### `parseCSVLine()` — Quote-Aware Field Splitting

- O(n) single-pass algorithm with a boolean quote-state tracker
- Handles escaped quotes (`""` → `"`)
- Splits only on commas outside quoted regions

### `splitCSVLines()` — Multi-Line Field Merging

- Counts quotes per line to detect unclosed quoted fields
- Merges subsequent lines into the current record until quotes balance
- Handles RFC 4180 spec for newlines inside quoted values

### `parseCSV()` — Full Parser

- Splits input into lines, merges multi-line fields
- Normalizes headers: lowercase, strip spaces
- Enforces max 5,000 row limit
- Returns `{ headers, rows }` with error handling

### `parseTags()`

- Split by comma → trim each → filter empties → return `string[]`

---

## 5. Transactional / Atomic Database Patterns

### Stripe Webhook Idempotency

**File:** `src/app/api/webhooks/stripe/route.ts`

```typescript
await db.$transaction(async (tx) => {
  const current = await tx.registration.findUnique(...);
  if (current?.paymentStatus === "PAID") return; // Already processed
  await tx.registration.update({ paymentStatus: "PAID" });
  await tx.payment.create({ ... });
});
```

- Double-check pattern inside transaction prevents duplicate Payment records
- Stripe signature verification before processing

### Refund with Optimistic Locking

**File:** `src/app/api/events/[eventId]/registrations/[registrationId]/refund/route.ts`

- `updateMany` with condition `paymentStatus: "PAID"`
- If `count === 0` → already refunded → return 409
- If Stripe refund fails → rollback DB changes in catch block
- Idempotency key: `refund-${paymentId}`

### Bulk Registration Type Change

**File:** `src/app/api/events/[eventId]/registrations/bulk-type/route.ts`

- Atomic `$transaction`:
  1. Decrement `soldCount` on old ticket types
  2. Increment `soldCount` on new ticket type
  3. Update `ticketTypeId` on all selected registrations
  4. Sync `attendee.registrationType` text field from new ticket type name

### Capacity Check with Atomic Increment

**File:** `src/app/api/events/[eventId]/import/registrations/route.ts`

```
if (soldCount >= quantity) → CAPACITY_EXCEEDED error
else → update({ soldCount: { increment: 1 } })
```

### Event Cloning with Relationship Mapping

**File:** `src/app/api/events/[eventId]/clone/route.ts`

- 5-step sequential clone inside a 30-second transaction timeout:
  1. Create event copy (reset status, clear counters)
  2. Clone ticket types + pricing tiers → build `ticketMap` (old ID → new ID)
  3. Clone speakers → build `speakerMap`
  4. Clone tracks → build `trackMap`
  5. Clone sessions + re-link via all three maps
- Hotels and room types cloned with nested creation
- Speaker status reset to INVITED, soldCounts reset to 0

---

## 6. Deduplication Algorithms

### Two-Pass Set Dedup (Speaker Import)

**File:** `src/app/api/events/[eventId]/speakers/import-registrations/route.ts`

1. Query existing speakers → build email Set
2. Filter input: skip if email in existing Set
3. Dedupe within batch: `seen.add(email)`, skip if already seen

### Bulk Email Dedup

**File:** `src/app/api/events/[eventId]/emails/bulk/route.ts`

- Set-based email deduplication for abstract recipients (one speaker may have multiple abstracts)

### Tag Set Operations

**File:** `src/app/api/contacts/bulk-tags/route.ts`

- **Add mode:** `[...new Set([...existingTags, ...newTags])]` — union with dedup
- **Remove mode:** `existingTags.filter(t => !removeSet.has(t))` — O(1) lookup per tag
- **Replace mode:** overwrites entirely
- All updates batched in `db.$transaction()`

---

## 7. PDF Generation & Layout

### Badge PDF with Barcode Pre-Rendering

**File:** `src/app/api/events/[eventId]/registrations/badges/route.ts`

- Uses `pdfkit` for PDF generation and `bwip-js` for Code128 barcodes
- Pre-renders all barcodes concurrently via `Promise.all()` into a `Map<string, Buffer>` cache
- Avoids regenerating the same barcode value twice
- Badge dimensions: 4" × 3" (288 × 216 points) centered on A4 page
- Layout: name, country, barcode image, badge type (large), registration number (italic)
- Configurable `badgeVerticalOffset` per event for print alignment

### Invoice / Quote / Receipt PDF

**File:** `src/lib/invoice-service.ts`

- Type-specific rendering for INVOICE, RECEIPT, and CREDIT_NOTE
- Line items with quantity, unit price, tax breakdown
- Bank transfer details section
- Branded layout with organization details

---

## 8. Date/Time Calculations

**File:** `src/lib/utils.ts`

### Dubai Timezone (UTC+4)

```typescript
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000; // 14,400,000 ms
function toDubai(date: Date): Date {
  return new Date(date.getTime() + DUBAI_OFFSET_MS);
}
```

- Hardcoded offset (no DST in UAE)
- Applied manually rather than using `Intl.DateTimeFormat`

### Formatting Functions

| Function | Output Example |
|----------|---------------|
| `formatDate()` | "Jan 25, 2026" |
| `formatDateTime()` | "Jan 25, 2026, 2:30 PM GST" |
| `formatDateRange()` | "Jan 25 - Jan 27, 2026" (collapses if same day) |
| `formatTime()` | "2:30 PM GST" |

### Token Expiry

**File:** `src/app/api/public/events/[slug]/complete-registration/route.ts`

```typescript
if (tokenRecord.expires < new Date()) → token expired
```

- Completion tokens expire after 7 days

---

## 9. Contact Sync (Fire-and-Forget)

**File:** `src/lib/contact-sync.ts`

- Upsert contact by email within organization
- Array append with dedup: only adds `eventId` if not already in `contact.eventIds`
- Non-blocking: errors are logged but never thrown
- Called after CSV import, speaker import, and registration completion

---

## 10. HTML Sanitization

**File:** `src/lib/sanitize.ts`

- Uses DOMPurify with strict whitelists:
  - **19 allowed tags:** p, br, strong, em, u, a, ul, ol, li, h1-h4, span, div, img, table, tr, td, th
  - **8 allowed attributes:** href, src, alt, style, class, target, rel, width
- All event handlers stripped
- No data attributes permitted

---

## 11. Pagination

**File:** `src/app/api/contacts/route.ts`

```typescript
page  = Math.max(1, parseInt(pageParam || "1"))
limit = Math.min(100, Math.max(1, parseInt(limitParam || "50")))
skip  = (page - 1) * limit
totalPages = Math.ceil(total / limit)
```

- Parallel fetch: `Promise.all([findMany({ skip, take: limit }), count({ where })])`

---

## 12. Log Parsing

**File:** `src/app/api/logs/route.ts`

### Pino JSON Log Parsing (`parsePinoLine`)

- Attempts `JSON.parse()` on each line
- Maps numeric levels: 50 = error, 40 = warn, 30 = info, <30 = debug

### Docker Log Parsing (`parseDockerLine`)

- Regex: `/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s(.*)$/`
- Extracts ISO 8601 timestamp and message body

---

## 13. Validation & Normalization

### Email Validation

**File:** `src/app/api/events/[eventId]/import/registrations/route.ts`

```
/^[^\s@]+@[^\s@]+\.[^\s@]+$/
```

### Tag Normalization

**File:** `src/lib/utils.ts`

```typescript
function normalizeTag(tag: string): string {
  return tag.trim()
    .replace(/\s+/g, " ")                    // collapse whitespace
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())  // title case
    .join(" ");
}
```

### CSV Column Matching

**File:** `src/app/api/events/[eventId]/import/barcodes/route.ts`

- `findCol()` searches an array of alternative column names (case-insensitive)
- Supports variants: "barcode", "barcodenumber", "barcode_number", "dtcmbarcode"

---

## Summary

The codebase is primarily a CRUD application. Complexity lives in **correctness guarantees** (atomicity, idempotency, deduplication) rather than algorithmic difficulty. The most notable patterns are:

- **AES-256-GCM encryption** for API secret storage
- **RFC 4180 CSV state machine** for quote-aware parsing
- **Atomic counter generation** with `$transaction` + `upsert` for gap-free sequences
- **Stripe webhook idempotency** with double-check inside transactions
- **Optimistic locking** for refund safety
- **Event cloning** with multi-map relationship re-linking

There are no ML models, graph algorithms, or heavy computation in the codebase.
