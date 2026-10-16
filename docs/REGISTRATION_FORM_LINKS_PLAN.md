# Registration form links with a rate: plan

Status: BUILT Oct 16, 2026. Owner decisions are recorded in section 2; section 8 lists where the build differs from this plan.

## 1. The problem

An organiser imports people (CSV, Import from Contacts, Add Registration) and wants to email each of them a personal link to complete their registration, at a rate they choose: Early Bird, Standard, Inclusive for a sponsor, or Complimentary.

Today:

- **Send Registration Form** (Registrations page, bulk and per person) sends a fixed "Complete Your Registration" email with a personal 7-day link (`/e/<slug>/complete-registration?token=...`). Communications, Send Email has no way to send it, and there is no token for the link, so a list matched in Communications cannot be sent it.
- **The CSV import never records a rate.** `src/app/api/events/[eventId]/import/registrations/route.ts` sets no `pricingTierId` and no `originalPrice`, and decides `paymentStatus` from `TicketType.price`. On an event whose prices live on the rates (BHS2026: every type's own price is 0), an imported Physician lands as COMPLIMENTARY with no rate.
- **The completion form only prices people with no type.** For them it uses the open public rate (`pickOpenPublicRate`). A person who already has a type keeps whatever the import gave them.

So there is no way to say "these ten are Early Bird" or "these are Inclusive for Biologix".

## 2. Owner decisions (Oct 16, 2026)

| # | Question | Decision |
|---|---|---|
| D1 | Where is it sent from? | Both: the Send Registration Form button AND a new "Registration form" type in Communications, Send Email. One service behind both. |
| D2 | What carries the rate? | The organiser picks it at send time: any rate name on the event, or Complimentary. Sponsor-link rates (Inclusive) are allowed because staff are sending; a sponsor is then required. |
| D3 | The rate closes before the person completes | **Refuse.** The form says the rate has closed and to contact the organiser; the organiser resends with the current rate. Same rule as group registration. |
| D4 | Stamp the rate on the registration at send? | **Yes**, immediately: rate, price and payment status show on the Registrations list before the person completes. |
| D5 | May the person change type on the form? | **Yes**, among the types that carry the sent rate, priced at that rate. A person with no type picks one the same way. |
| D6 | Editable email | Yes: the email becomes a template in Email Templates (today's wording as its default) with a `{{registrationFormLink}}` token. |
| D7 | How long the link lasts | **The organiser sets it per send**, e.g. 10 or 30 days. Default 7 (today's lifetime). |

## 3. Design

### 3.1 One service

`src/services/registration-form-service.ts`, function `sendRegistrationForms({ eventId, organizationId, registrationIds, rate, sponsorId?, actorUserId, source })`.

- `rate` is `{ kind: "rate", slug }` or `{ kind: "complimentary" }`.
- `expiryDays` (D7): a whole number of days, 1 to 365, default 7. See 3.8.
- Called by the existing route `POST /api/events/[eventId]/import/registrations/send-completion-emails` (which gains the `rate` and `sponsorId` fields) and by the bulk email send for the new type. Errors as values; no `next/server` import (services/README.md).
- The route keeps auth, `requirePermission("registrations.import")`, the 5-per-hour organisation limit and the HTTP mapping.

### 3.2 What the service does, per registration

Checks first, all reported back as `skipped` with a reason, before anything is written or sent:

1. Cancelled: skip.
2. Has an account (`userId`): skip ("already completed").
3. Money recorded: an issued invoice or any payment, or `paymentStatus` in PAID / REFUNDED / partially refunded: skip ("already paid or invoiced"). Re-pricing a registration finance has already billed would make the invoice disagree with the row.
4. For a rate: the registration's type (when it has one) must carry a rate with that name (`registerTierSlug` match), else skip ("Exhibitor has no Early Bird rate").
5. For a rate: the rate must be on sale now (`isTierOnSale`) on that type, else skip ("Early Bird is not on sale"). A typeless person is checked when they pick a type.
6. For a sponsor-link rate (`codeRequiredTiers`): a sponsor is required, from the dialog or the registration's own `sponsorId`. Without one the whole send is refused (`SPONSOR_REQUIRED`), not skipped.

Then, for each registration that passed (D4, the stamp), in one transaction per registration:

| Chosen | Has a type | Stamp |
|---|---|---|
| A paid rate | yes | `pricingTierId` = that type's rate, `originalPrice` = its price, `paymentStatus` UNASSIGNED |
| A $0 rate | yes | as above, `paymentStatus` COMPLIMENTARY |
| A sponsor-link rate | yes | as above, `paymentStatus` INCLUSIVE, `sponsorId` set |
| Complimentary | yes | `pricingTierId` null, `originalPrice` 0, `paymentStatus` COMPLIMENTARY |
| Anything | no | nothing yet; the rate rides in the link (3.3) |

- Seats do not move at send. A CSV_IMPORT row holds its seat on the TYPE counter (`seatCounter`), and stamping a rate does not change that.
- Each stamp writes an AuditLog entry (`REGISTRATION_FORM_RATE_SET`, with the previous and new rate, price and status, and `source`).

Then the link and the email:

- Delete the person's earlier completion tokens (both identifier forms, 3.3), mint a new token valid for `expiryDays`, render the `registration-form` template with `{{registrationFormLink}}`, send.
- A failed send deletes the token. The stamp stays (the organiser can resend; the stamp is the organiser's decision, not the email's).

### 3.3 The link carries the rate

`VerificationToken` has `identifier`, `token`, `expires`. No schema change:

- New identifier form: `regform:<registrationId>:<rate>` where `<rate>` is the rate slug or `complimentary`.
- The old form `reg:<registrationId>` stays valid (links already in inboxes), with today's behaviour.
- One parser, `parseCompletionIdentifier()` in `src/lib/registration-form-link.ts`, used by the completion GET and POST, returns `{ registrationId, rate | null }`.

### 3.4 The completion form

GET (`/api/public/events/[slug]/complete-registration`):

- With a rate in the link: the selectable types are the event's public types that carry that rate, priced at it (D5). The person's current type, if any, is preselected. If the rate is not on sale on any of them, the page shows "The Early Bird rate has closed. Please contact the organising team." (D3).
- Complimentary: types are listed with no price; nothing to pay.
- Without a rate (old links): unchanged.

POST:

- Re-resolves everything server-side from the token's rate; the client sends only `ticketTypeId`.
- Rate closed: 400 `RATE_CLOSED`, logged, nothing written, token kept.
- Same type as stamped: no repricing beyond confirming the stamp.
- Different type (D5): move the seat from the old type to the new one through `planSeatTransition` / `applyRegistrationTransition` (`registration-seat*.ts`), the same machinery the dashboard Change Type uses, then stamp the new type's rate. A sold-out new type: 409, nothing written.
- Typeless: today's claim path, priced at the token's rate instead of the open rate.
- `paymentStatus` follows the table in 3.2, except that a status already holding money is never touched (the send refused those; this is the second line).
- Everything else (account creation, confirmation email, identity evidence, approval flip) is unchanged.

### 3.5 Bulk email

- New `BulkEmailType` `"registration-form"`, registrations audience only, in `src/lib/bulk-email.ts`, `bulk-email-audience.ts` and the zod enum.
- `filters.registrationFormRate`, `filters.registrationFormSponsorId` and `filters.registrationFormExpiryDays`. A scheduled send reads them back from the saved ScheduledEmail row, as the survey invitation does with `surveyExpiryDays`. The send for this type delegates to `sendRegistrationForms` (like `certificate` delegates to `executeCertificateBulkSend`), so the stamp and skip rules are the service's.
- Scheduled sends: the token is minted when the scheduled send runs, so a link never expires before it is delivered. The rate must still be on sale at that moment, else those people are skipped and reported.
- The 10-per-hour per-event bulk limit applies as for other types.

### 3.6 The template

- New system template `registration-form` in `email-template-registry.ts` and `email-template-defaults.ts`: today's "Complete Your Registration" wording, tokens `{{registrationFormLink}}`, `{{rateName}}`, `{{linkExpiresIn}}` ("30 days") and `{{linkExpiresOn}}` (the date, in the event's timezone) plus the usual person and event tokens. `rawHtmlKeys` none.
- `emailTemplates.registrationCompletion` in `email.ts` is retired once the service sends through the template.
- Preview and test send render a sample link (the preview data layer already does this for per-person links).

### 3.7 UI

- **Registrations page and the detail sheet:** the Send Registration Form confirm dialog gains a **Rate** select (the event's rate names via `orderedTierNames`, plus Complimentary; presenter rates excluded) and a **Sponsor** select shown when a sponsor-link rate is chosen. After sending: "Sent 8. Skipped 2: Exhibitor has no Early Bird rate (1), already paid (1)."
- **Communications, Send Email:** "Registration form" appears under the registrations audience, with the same Rate and Sponsor selects.
- Both dialogs have a **Link valid for (days)** field, default 7 (D7, 3.8).
- No pre-flight preview of skips in v1; the result lists them with reasons. (A dry-run count could follow.)

### 3.8 Link lifetime (D7)

- The organiser types a whole number of days, 1 to 365, default 7. This copies the survey invitation (`src/lib/survey/expiry.ts`): it began as a 3/5/7/10 dropdown and was changed on Sep 17, 2026 to a typed number because organisers wanted 15, 30 and 45. The bounds are a typo guard (450 typed for 45), not a product rule.
- Shared, not copied: the survey module's schema and parser move to a neutral `src/lib/link-expiry.ts` used by both sends (client-safe; the dialog validates as you type). The survey keeps its exported names as re-exports, so nothing else changes.
- **The lifetime and the rate interact (D3).** A 30-day link on an Early Bird rate that closes in 5 days stops working in 5 days, because the form refuses a closed rate. The dialog says so before sending, using the rate's `salesEnd`: "Early Bird closes on 31 Oct, so these links stop working then, even though they are valid for 30 days." The send is not blocked; the warning is information.
- The old link form (`reg:<id>`) keeps its 7 days; only new sends use the chosen lifetime.

## 4. Out of scope

- A rate column in the CSV import. Sending with a rate is how imported people get priced. Noted as a follow-up.
- Sending to people who are not on the list yet (they use the public, rate or sponsor links).

## 5. Build order

Each step ends with lint, tsc and its tests.

1. `registration-form-link.ts`: identifier build and parse. Tests.
2. `link-expiry.ts` (moved from the survey module, survey names re-exported), then `registration-form-service.ts`: checks, stamp, token with the chosen lifetime, send. Tests for every row of 3.2, every skip reason, and the expiry bounds.
3. The send route delegates to the service; accepts `rate`, `sponsorId`. Route tests (400 / 403 / 429 / skip report).
4. Completion GET and POST with a rated link: the type list, RATE_CLOSED, same type, type change with seat move, typeless, old links unchanged. Tests, including a mutation check on the closed-rate refusal and the seat move.
5. Template registry entry, defaults, retire the hard-coded email. Registry and preview tests.
6. Bulk email type delegating to the service, including scheduled sends. Tests.
7. UI: both dialogs and Communications.
8. User guide (help chat reads it) and CHANGELOG.

## 6. Verification

- Full gate: lint, tsc, every `scripts/check-*.sh` and `scripts/check-*.mjs`, full vitest.
- Browser, on the local BHS2026 copy, console clean on every touched page:
  - send Early Bird to two typed and one typeless test registration (local only, no real email: the send goes to krishna@meetingmindsdubai.com or the provider is blank);
  - the Registrations list shows the stamped rate and price;
  - the link: preselected type, switch to another type at the same rate, complete;
  - Inclusive with Biologix: INCLUSIVE, nothing to pay;
  - Complimentary;
  - a closed rate refused;
  - an old `reg:` link still works;
  - a 30-day send: the token's expiry is 30 days out, and the closing-rate warning shows when the rate ends sooner.
- Test registrations deleted by captured id afterwards.

## 7. Risk

Touches registration pricing and payment status (staff-initiated), the public completion form and bulk email. Kept safe by: no schema change; old links unchanged; money already recorded is never re-priced; every stamp audited; the completion POST re-resolves the price server-side. Confirmed with the owner before push.

## 8. Where the build differs from the plan

- **Sponsor missing is a per-person skip, not a refusal of the whole send** (`NO_SPONSOR`): a CSV with a sponsor column on most rows should not be blocked by the few without one.
- **Extra skip reasons:** `PROMO_APPLIED` (re-pricing would leave the discount wrong), `RATE_SOLD_OUT` (the rate's seats are full) and `CHANGED` (the registration was paid or completed while sending; the stamp is guarded on what was checked).
- **The stamp moves a seat when the seat is counted on a rate** (a public registration), through `applyRegistrationTransition`. Imported and staff-added registrations are counted on their type, so nothing moves for them.
- **The bulk type runs inside the bulk pipeline** (resume, BCC, logs, scheduling) rather than being delegated out like certificates: the pipeline calls `prepareRegistrationForms` before its batches and `mintRegistrationFormLink` per recipient.
- **Permission:** the bulk type needs `registrations.import` beside `communications.send`, the same key as the button, because it re-prices registrations.
- **The route resolves the event through `gate.eventWhere` before calling the service**; the route status matrix caught the service's organisation-only lookup.
- **Review of b269ff6e (Oct 16, 2026).**
  - H1: the link's rate applies only while the registration is as the send left it (`linkMayReprice`: nothing paid, refunded or invoiced, no promo, not in a group, still on the stamped rate). Otherwise the link completes details only.
  - M1: a typeless person claims only their type's counter at completion, because the import already counted the event seat.
  - M2: a rate is "open" by switch and sale dates only (`isLinkRateOpen`); capacity is enforced when a seat is actually claimed.
  - M3: a virtual attendee is priced at the type's `virtualPrice` when set.
  - L4: an unknown rate is refused when a bulk send is queued.
  - L5: the log fields are corrected.
  - L6: the Complimentary key is `_complimentary`, which no rate slug can equal.
  - Left for later: L2 (a stamp landing during an open Stripe checkout) and L3 (the bulk send's link on failure or resume, and BCC copies carrying a live link).

