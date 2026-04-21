# Public Registration Forms — Field-by-Field Mapping

This document traces every field shown on a public-facing registration form to the server-side Zod schema that validates it and the Prisma column(s) where it lands. Use it as the authoritative reference when adding a new field, renaming one, or debugging why a submitted value "disappeared" between client and DB.

Last verified: **2026-04-21** against `main`.

---

## Surface map

| # | Public URL | API endpoint | Client file | Zod schema | Creates / updates |
|---|---|---|---|---|---|
| 1 | `/e/[slug]/register/[category]` | `POST /api/public/events/[slug]/register` | [src/app/e/[slug]/register/[category]/page.tsx](../src/app/e/%5Bslug%5D/register/%5Bcategory%5D/page.tsx) | [route.ts L17-73](../src/app/api/public/events/%5Bslug%5D/register/route.ts#L17-L73) | `Attendee`, `Registration`, optionally `User` (REGISTRANT), `Contact` |
| 2 | `/e/[slug]/abstract/register` | `POST /api/public/events/[slug]/submitter` | [src/app/e/[slug]/abstract/register/page.tsx](../src/app/e/%5Bslug%5D/abstract/register/page.tsx) | [submitter/route.ts L12-34](../src/app/api/public/events/%5Bslug%5D/submitter/route.ts#L12-L34) | `User` (SUBMITTER), `Speaker`, `Contact` |
| 3 | `/e/[slug]/submitAbstract` | `POST /api/public/events/[slug]/submitter` | [src/app/e/[slug]/submitAbstract/page.tsx](../src/app/e/%5Bslug%5D/submitAbstract/page.tsx) | (same as #2) | (same as #2) |
| 4 | `/e/[slug]/complete-registration?token=…` | `POST /api/public/events/[slug]/complete-registration` | [src/app/e/[slug]/complete-registration/page.tsx](../src/app/e/%5Bslug%5D/complete-registration/page.tsx) | [completion/route.ts L158-188](../src/app/api/public/events/%5Bslug%5D/complete-registration/route.ts#L158-L188) | `Attendee`, `Registration` (termsAccepted side-effects on `User`), optionally `User` (REGISTRANT), `Contact` |
| 5 | (preflight — no page) | `POST /api/public/events/[slug]/check-email` | called from forms #1 and #2 step 1 | inline `{ email }` schema | reads only — no writes |

> Forms #2 and #3 POST to the **same endpoint**. Keep their client-side Zod schemas aligned or they'll diverge again (they did once — see `2026-04-14 Abstracts flow audit + fixes` in `CHANGELOG.md`).

> Shared enums used below live in [src/lib/schemas.ts](../src/lib/schemas.ts): `titleEnum` = `Title` (DR/MR/MRS/MS/PROF), `attendeeRoleEnum` = `AttendeeRole` (ADMIN/...). `specialty` is a free-form string with a server `.refine()` requiring `customSpecialty` when `specialty === "Others"`.

---

## 1. Public Attendee Registration — `/e/[slug]/register/[category]`

Two-step form. Step 1 is the account block; Step 2 is personal + billing + optional account password.

### Step 1 — account

| Client label | Client field | Required | Server Zod | Landing |
|---|---|---|---|---|
| Email | `email` | ✅ | `z.string().email().max(255)` | `Attendee.email`, `Contact.email`, `User.email` (if account created) |
| Password | `password` | optional (✅ if creating account) | `z.string().min(6).max(128).optional()` | `User.passwordHash` (bcrypt) |
| Confirm Password | `confirmPassword` | client-only | client `.refine(password === confirmPassword)` | — |

> The **"Already registered?"** banner on Step 1 comes from `POST /api/public/events/[slug]/check-email` — fired after client validation passes, before advancing to Step 2. Returns non-enumerable `{ exists, reason }` (20/hr/IP).

### Step 2 — attendee + billing

| Client label | Client field | Required | Server Zod | Landing |
|---|---|---|---|---|
| Title | `title` | ✅ | `titleEnum` | `Attendee.title` |
| Role | `role` | ✅ | `attendeeRoleEnum` | `Attendee.role` |
| First Name | `firstName` | ✅ | `z.string().min(1).max(100)` | `Attendee.firstName`, `Contact.firstName`, `User.firstName` |
| Last Name | `lastName` | ✅ | `z.string().min(1).max(100)` | `Attendee.lastName`, `Contact.lastName`, `User.lastName` |
| Additional Email | `additionalEmail` | — | `z.string().email().max(255).optional().or(z.literal(""))` | `Attendee.additionalEmail` |
| Organization | `organization` | ✅ | `z.string().min(1).max(255)` | `Attendee.organization`, `Contact.organization` |
| Job Title / Position | `jobTitle` | ✅ | `z.string().min(1).max(255)` | `Attendee.jobTitle`, `Contact.jobTitle` |
| Phone | `phone` | ✅ | `z.string().min(1).max(50)` | `Attendee.phone`, `Contact.phone` |
| City | `city` | ✅ | `z.string().min(1).max(255)` | `Attendee.city`, `Contact.city` |
| State | `state` | — | `z.string().max(255).optional()` | `Attendee.state`, `Contact.state` |
| Zip Code | `zipCode` | — | `z.string().max(20).optional()` | `Attendee.zipCode`, `Contact.zipCode` |
| Country | `country` | ✅ | `z.string().min(1).max(255)` | `Attendee.country`, `Contact.country` |
| Specialty | `specialty` | ✅ | `z.string().min(1).max(255)` | `Attendee.specialty`, `Contact.specialty` |
| Custom Specialty (when Specialty = "Others") | `customSpecialty` | conditional (server `.refine()`) | `z.string().max(255).optional()` | `Attendee.customSpecialty` |
| Dietary Requirements | `dietaryReqs` | — | `z.string().max(2000).optional()` | `Attendee.dietaryReqs` |
| Association Name | `associationName` | — | `z.string().max(255).optional()` | `Attendee.associationName` |
| Member ID | `memberId` | conditional (client-side when ticket type name contains "member") | `z.string().max(100).optional()` | `Attendee.memberId` |
| Student ID | `studentId` | conditional (client-side when ticket type name contains "student") | `z.string().max(100).optional()` | `Attendee.studentId` |
| Student ID Expiry | `studentIdExpiry` | conditional (same as above) | `z.string().max(20).optional()` → coerced to `Date` | `Attendee.studentIdExpiry` |
| **Ticket / Pricing** | `ticketTypeId` | ✅ | `z.string().min(1).max(100)` | `Registration.ticketTypeId` |
| | `pricingTierId` | — | `z.preprocess("" → undefined, z.string().optional())` | `Registration.pricingTierId` |
| Promo Code | `promoCode` | — | `z.string().max(50).optional()` | `Registration.promoCodeId` (via FK lookup), `PromoCodeRedemption` row |
| **Billing block** (checkbox "bill to same" hides these when true) |  |  |  |  |
| Tax Number / VAT | `taxNumber` | — | `z.string().max(100).optional()` | `Registration.taxNumber` |
| Billing First Name | `billingFirstName` | — | `z.string().max(100).optional()` | `Registration.billingFirstName` |
| Billing Last Name | `billingLastName` | — | `z.string().max(100).optional()` | `Registration.billingLastName` |
| Billing Email | `billingEmail` | — | `z.string().email().max(255).optional().or(z.literal(""))` | `Registration.billingEmail` |
| Billing Phone | `billingPhone` | — | `z.string().max(50).optional()` | `Registration.billingPhone` |
| Billing Address | `billingAddress` | — | `z.string().max(500).optional()` | `Registration.billingAddress` |
| Billing City | `billingCity` | — | `z.string().max(255).optional()` | `Registration.billingCity` |
| Billing State | `billingState` | — | `z.string().max(255).optional()` | `Registration.billingState` |
| Billing Zip | `billingZipCode` | — | `z.string().max(20).optional()` | `Registration.billingZipCode` |
| Billing Country | `billingCountry` | — | `z.string().max(255).optional()` | `Registration.billingCountry` |
| **Tracking (hidden)** |  |  |  |  |
| Referrer | `referrer` (from `document.referrer`) | — | `z.string().max(2000).optional()` | `Registration.referrer` |
| UTM Source | `utmSource` (from `?utm_source`) | — | `z.string().max(255).optional()` | `Registration.utmSource` |
| UTM Medium | `utmMedium` | — | `z.string().max(255).optional()` | `Registration.utmMedium` |
| UTM Campaign | `utmCampaign` | — | `z.string().max(255).optional()` | `Registration.utmCampaign` |
| **T&C checkbox** | `agreeTerms` (client-only on form #1) | ✅ | — | indirectly: successful POST → `User.termsAcceptedAt` + `User.termsAcceptedIp` set server-side when account created. Not persisted on the `Registration` row itself. |

**Server side-effects per successful POST** (atomic transaction):

1. `Attendee` — reused if orphaned (same email, zero active registrations), else created.
2. `PricingTier.soldCount` or `TicketType.soldCount` — atomic `+1` with sold-out guard.
3. `PromoCode.usedCount` — atomic `+1` if `promoCode` supplied + valid. `PromoCodeRedemption` row written.
4. `Registration` — created with `status: PENDING`/`CONFIRMED` (depends on `requiresApproval`), `paymentStatus: PAID` (free tickets) / `UNPAID` (paid tickets).
5. After transaction: `User` upsert (REGISTRANT role, `termsAcceptedAt` set if first time) when `password` submitted. Existing unlinked Registrations for the same email are linked via `Registration.userId`.
6. `syncToContact()` → upserts `Contact` scoped by `(organizationId, email)`.
7. `notifyEventAdmins()` — SIGNUP notification (fire-and-forget, now logged via `apiLogger.warn` on failure).
8. `sendRegistrationConfirmation()` — email with quote PDF when `ticketPrice > 0 && organizationName`.
9. Auto-invoice created if `finalPrice > 0` (`createInvoice()` + `sendInvoiceEmail()`).

---

## 2 & 3. Submitter / Speaker Registration — `/e/[slug]/abstract/register` and `/e/[slug]/submitAbstract`

Both forms POST to the same endpoint. Three-step UX on the client (identity / details / account), single Zod schema on the server.

| Client label | Client field | Required | Server Zod | Landing |
|---|---|---|---|---|
| Title | `title` | ✅ | `titleEnum` | `Speaker.title`, `Contact.title` |
| Role | `role` | ✅ | `attendeeRoleEnum` | (passed through, currently not persisted on Speaker — keep an eye on this) |
| First Name | `firstName` | ✅ | `z.string().min(1).max(100)` | `Speaker.firstName`, `User.firstName`, `Contact.firstName` |
| Last Name | `lastName` | ✅ | `z.string().min(1).max(100)` | `Speaker.lastName`, `User.lastName`, `Contact.lastName` |
| Email | `email` | ✅ | `z.string().email().max(255)` | `Speaker.email`, `User.email`, `Contact.email` |
| Additional Email | `additionalEmail` | — | `z.string().email().max(255).optional().or(z.literal(""))` | — *(currently dropped — not persisted anywhere on the Speaker/Contact path)* |
| Password | `password` | ✅ | `z.string().min(6).max(128)` | `User.passwordHash` (bcrypt) |
| Organization | `organization` | ✅ | `z.string().min(1).max(255)` | `Speaker.organization`, `Contact.organization` |
| Job Title / Position | `jobTitle` | ✅ | `z.string().min(1).max(255)` | `Speaker.jobTitle`, `Contact.jobTitle` |
| Phone | `phone` | ✅ | `z.string().min(1).max(50)` | `Speaker.phone`, `Contact.phone` |
| City | `city` | ✅ | `z.string().min(1).max(255)` | `Speaker.city`, `Contact.city` |
| Country | `country` | ✅ | `z.string().min(1).max(255)` | `Speaker.country`, `Contact.country` |
| Specialty | `specialty` | ✅ | `z.string().min(1).max(255)` | `Speaker.specialty`, `Contact.specialty` |
| Custom Specialty (when Specialty = "Others") | `customSpecialty` | conditional (server `.refine()`) | `z.string().max(255).optional()` | `Speaker.customSpecialty` |
| Registration Type | `registrationType` | — | `z.string().max(255).optional()` | `Speaker.registrationType`, `Contact.registrationType` |

**Server side-effects per successful POST** (atomic transaction):

1. `User` — created with `role: SUBMITTER`, `organizationId: null` (org-independent), `termsAcceptedAt` + `termsAcceptedIp` set. If an existing user at the same email is `REGISTRANT`, role is **upgraded** to `SUBMITTER` and the record's names are refreshed.
2. `Speaker` — `findUnique` by `(eventId, email)`. Updated if exists; created otherwise with `status: CONFIRMED` and `userId` linked.
3. `syncToContact()` → upserts `Contact` (post-transaction).
4. `notifyEventAdmins()` — SIGNUP notification.
5. Welcome email → `submitter-welcome` template, logged as `entityType=SPEAKER, entityId=<speaker id>`.

> **Gap flagged**: `additionalEmail` exists on the client Zod on form #1 but **not on form #2/#3** and isn't persisted to `Speaker` / `Contact` even if sent. If the submitter form should collect it, add to both Zod + DB write. Worth raising if it matters.

---

## 4. Completion Form — `/e/[slug]/complete-registration?token=…`

Used when an admin CSV-imports a basic registration (`email`, `firstName`, `lastName` minimum) and then hits "Send Registration Forms" to email each registrant a one-time-use 7-day completion link. Token is looked up + decoded on `GET`, submitted back on `POST`.

| Client label | Client field | Required | Server Zod | Landing |
|---|---|---|---|---|
| Token (hidden) | `token` | ✅ | `z.string().min(1)` | verified against `VerificationToken` (SHA-256 hashed), `identifier` prefix `reg:<registrationId>` |
| Title | `title` | ✅ | `titleEnum` | `Attendee.title`, `Contact.title` |
| Role | `role` | ✅ | `attendeeRoleEnum` | `Attendee.role` |
| Job Title / Position | `jobTitle` | ✅ | `z.string().min(1).max(255)` | `Attendee.jobTitle`, `Contact.jobTitle` |
| Organization | `organization` | ✅ | `z.string().min(1).max(255)` | `Attendee.organization`, `Contact.organization` |
| Phone | `phone` | ✅ | `z.string().min(1).max(50)` | `Attendee.phone`, `Contact.phone` |
| City | `city` | ✅ | `z.string().min(1).max(255)` | `Attendee.city`, `Contact.city` |
| State | `state` | — | `z.string().max(255).optional()` | `Attendee.state`, `Contact.state` |
| Zip Code | `zipCode` | — | `z.string().max(20).optional()` | `Attendee.zipCode`, `Contact.zipCode` |
| Country | `country` | ✅ | `z.string().min(1).max(255)` | `Attendee.country`, `Contact.country` |
| Specialty | `specialty` | ✅ | `z.string().min(1).max(255)` | `Attendee.specialty`, `Contact.specialty` |
| Custom Specialty (when Specialty = "Others") | `customSpecialty` | conditional (server `.refine()`) | `z.string().max(255).optional()` | `Attendee.customSpecialty` |
| Dietary Requirements | `dietaryReqs` | — | `z.string().max(2000).optional()` | `Attendee.dietaryReqs` |
| Association Name | `associationName` | — | `z.string().max(255).optional()` | `Attendee.associationName` |
| Member ID | `memberId` | conditional (ticket type name contains "member") | `z.string().max(100).optional()` | `Attendee.memberId` |
| Student ID | `studentId` | conditional (ticket type name contains "student") | `z.string().max(100).optional()` | `Attendee.studentId` |
| Student ID Expiry | `studentIdExpiry` | conditional | `z.string().max(20).optional()` → coerced to `Date` | `Attendee.studentIdExpiry` |
| Create Account (optional) |  |  |  |  |
| Password | `password` | — | `z.string().min(6).max(128).optional()` | `User.passwordHash` |
| Confirm Password | `confirmPassword` | client-only | `.refine(password === confirmPassword)` | — |
| Terms checkbox | `agreeTerms` | ✅ | `z.literal(true)` | `User.termsAcceptedAt` + `User.termsAcceptedIp` (if account created) + registration is flipped to `status: CONFIRMED` |

**Server side-effects per successful POST:**

1. `Attendee` — `update()` on the existing row linked by `Registration.attendeeId`.
2. `Registration.status` — flipped to `CONFIRMED` (was `PENDING`).
3. `User` upsert — same REGISTRANT + termsAcceptedAt logic as form #1.
4. `VerificationToken` — deleted (one-time-use).
5. `syncToContact()`.
6. `sendRegistrationConfirmation()` with quote PDF if `ticketPrice > 0 && organizationName`.

---

## 5. Preflight — `POST /api/public/events/[slug]/check-email`

Called from the "Continue" button on Step 1 of forms #1 and #2 after client-side email/password validation passes. Purpose: tell the user *immediately* if the email is already registered (vs. letting them fill 20 fields and hitting a server error at final submit).

| Body field | Zod | Notes |
|---|---|---|
| `email` | `z.string().email()` | lowercased server-side |

**Response shape** — intentionally non-enumerable:

```ts
{ exists: false }
// or
{ exists: true, reason: "already_registered" | "user_exists" }
```

**Rate limit**: 20/hr/IP via `checkRateLimit` in [src/lib/security.ts](../src/lib/security.ts).

---

## Shared persistence side-effects

These fire regardless of which form was submitted (where they apply):

- **`EmailLog` row** — written by [src/lib/email-log.ts](../src/lib/email-log.ts) for every `sendEmail()` call in these routes. Tied to `entityType=REGISTRATION|SPEAKER` so the person's detail sheet Email History card picks it up.
- **`AuditLog` row** — fire-and-forget on create / update / status change of `Registration`.
- **`syncToContact()`** — idempotent upsert on `Contact` keyed by `(organizationId, email)`; appends `eventId` to `Contact.eventIds` if not already present.
- **`refreshEventStats()`** — bumps the denormalized `EventStats` row.
- **`notifyEventAdmins()`** — creates `Notification` rows for ADMIN + ORGANIZER users on the event.

---

## Change-management checklist

When adding or renaming a public registration field:

1. **Client Zod** — in the form's own `registerSchema` / `completionSchema` (one per page). Match `min(1)` + error message with existing required fields.
2. **Server Zod** — in the matching API route (`src/app/api/public/events/[slug]/{register,submitter,complete-registration}/route.ts`). Keep length caps consistent client ↔ server.
3. **`.refine()` conditionals** — if the field is conditionally required (e.g. `customSpecialty` when Specialty = "Others"), add both client and server refinements.
4. **Prisma schema** — add the column to the right model (`Attendee` vs. `Registration` vs. `Speaker` vs. `User`) + migration.
5. **Persistence writes** — update the `attendeeData` / `speakerData` / `userData` object literal in the route.
6. **`syncToContact()`** — add the field to [src/lib/contact-sync.ts](../src/lib/contact-sync.ts) so the org contact store stays in sync.
7. **Admin dashboard** — add to the registration detail sheet + CSV export if it should be organizer-visible.
8. **Completion form parity** — if the new field is something a CSV-imported registrant should supply, add to form #4 too.
9. **E2E** — [e2e/public-registration.spec.ts](../e2e/public-registration.spec.ts) + [e2e/abstract-submitter.spec.ts](../e2e/abstract-submitter.spec.ts) if the field is required.

---

## Known gaps / TODOs

- **`additionalEmail` not persisted on form #2/#3** — Zod on form #1 accepts it and lands on `Attendee.additionalEmail`. The submitter route has no equivalent column on `Speaker` and the field isn't in that route's Zod at all. If the field is meaningful for submitters, add to `submitter/route.ts` Zod + `Speaker` schema.
- **`role` field dropped on submitter path** — the submitter Zod accepts `role: attendeeRoleEnum` but `Speaker` has no `role` column and the server doesn't persist it. Today the value is validated-then-ignored.
- **Form #3 (`submitAbstract`) client Zod uses plain `z.string().min(1)` for title/role** — the canonical form #2 uses `titleEnum` / `attendeeRoleEnum`. Cosmetic drift; both POST to the same server-validated endpoint so correctness is preserved, but the client-side error UX differs slightly.
