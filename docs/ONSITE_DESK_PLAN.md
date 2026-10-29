# Onsite desk: walk-ins and completing registration at the venue

Status: **BUILT** (planned Oct 28, 2026; all three steps built Oct 28 to 29, 2026). Owner decisions are in §6.

## 1. The two problems

1. **A walk-in takes too long.** Registering someone at the desk, marking them
   complimentary or paid, printing the badge and checking them in takes about
   4 screens and 12 to 16 clicks today: Add Registration is a separate page that
   returns to the list, the person must be searched for again, the badge prints
   from the Activity tab of the detail sheet, and Check In is a further click.
   A paid walk-in also waits for the invoice, receipt and payment email, which
   `issuePaidRegistrationDocuments` creates inside the request. Target: 30 to 40
   seconds per walk-in, most of it typing.
2. **People added by the organiser or imported by CSV cannot complete at the
   venue.** Their "complete your registration" link is only ever emailed, and
   only its hash is stored, so the desk cannot show it again. The goal is that
   at the venue they fill in everything the public registration form asks and
   leave with a barcode and a badge, exactly as if they had used the emailed
   link.

## 2. What exists and is reused

- `registration-service.createRegistration` (the one create path), the
  check-in library (`src/lib/check-in.ts`), the badge route
  (`registrations/badges`), the payments route and `record-payment-dialog`.
- The completion form `/e/[slug]/complete-registration` and its route, with
  `mintRegistrationFormLink` in `src/services/registration-form-service.ts`
  (single use, minting a new link deletes the person's older links).
- `renderQrPng` in `src/lib/barcode.ts` (server side QR rendering).

## 3. Step 1: foundation

### 3.1 "Completed at" on each registration

Today the only signal that someone completed is `Registration.userId`, which
is set only when they chose a password. Someone who completes without one
still looks incomplete and can be sent the form again.

- New column `Registration.completedAt TIMESTAMP(3)`, nullable, additive
  (`ADD COLUMN IF NOT EXISTS`), no default. Blue/green safe: old code ignores it.
- Set it when the registration's details come from the person themself:
  - public registration, abstract submitter sign-up and group registration:
    at creation;
  - the completion form: on submit (any device, emailed link or onsite);
  - the speaker companion: at creation (the speaker's details come from their
    speaker record, so the desk never asks them to complete).
- Left empty for rows the organiser or a tool created with partial details:
  dashboard Add Registration, CSV import, EventsAir import, contacts import,
  the agent, and desk walk-ins (§4).
- Backfill in the same migration, idempotent (only rows still null):
  - `createdAt` for rows whose source is PUBLIC_REGISTER, PUBLIC_SUBMITTER,
    PUBLIC_COMPLETION_FORM, GROUP_REGISTER or SPEAKER_COMPANION;
  - the time of the row's `COMPLETE_REGISTRATION` audit entry, where one exists.
- "Not completed" means `completedAt IS NULL` and the registration is not
  cancelled.

### 3.2 A "Not completed" filter

- Registrations list API: `completion=pending|done`.
- Registrations page: a "Registration form" filter (All / Not completed /
  Completed), so the organiser sees before the event how many imported people
  still need to complete.

### 3.3 The completion form matches the public form

The completion route accepts everything the public form does except what is
fixed by the link (name, email, rate) or deliberately excluded (promo code,
attribution). Added:

- `additionalEmail`;
- the supporting document, with the same per-type rules
  (`src/lib/supporting-document.ts`): asked when the type asks, required when it
  requires;
- `taxNumber` and the billing fields (billing name, email, phone, address,
  city, state, postcode, country), optional exactly as on the public form.

Field rules are taken from the public form's schema so the two cannot drift; a
test pins that every public field is either on the completion form or on the
documented exclusion list.

## 4. Step 2: the Walk-in panel

On the Check-In page, a second tab beside the scanner: **Desk**.

- **One search box**: name, email, organisation or registration number. Each
  result shows Not completed / Completed / Checked in, whether payment is due,
  and the registration type, with the action that fits:
  - Completed and nothing owed: **Check in & print badge**;
  - Not completed: **Complete onsite** (§5);
  - payment due: **Record payment** (cash / card), then check in & print.
- **New walk-in**: first name, last name, email; the registration type,
  remembered per desk; Complimentary or Paid (cash / card); organisation and
  mobile optional. One button, **Register, check in & print**.
- Server: one desk route that runs the create through
  `registration-service`, records the payment when paid, and checks the person
  in, then returns. The badge PDF opens in the page and the operator clicks
  Print (the owner's choice: manual print dialog, no kiosk printing).
- Paid walk-ins: the invoice, receipt and payment email are created after the
  response, not while the desk waits (owner: fine to arrive later). Failures
  are logged at error and notify the event's admins, as today.
- Permissions: the route asks `registrations.create`, `registrations.checkin`
  and, when paid, `payments.record`, judged on the event (ONSITE staff on their
  assigned events, organisers everywhere).
- The unused `add-registration-dialog.tsx` is removed.

As built (Oct 29, 2026):

- The capture moved out of the payments route into `recordManualPayment()` in
  `src/services/payment-service.ts`; the route and the walk-in both call it.
  `deferDocuments` issues the invoice, receipt and email after returning.
- The route is `POST /api/events/[eventId]/registrations/walk-in`. It passes
  `overrideSalesWindow` (the public window has usually closed on the day; sold
  out and the event cap still apply) and, when paid, suppresses the "please
  pay" confirmation, because the payment email follows. A step that fails
  after the registration exists answers 200 with `registered: true` and the
  reason, so the desk finishes from search instead of registering twice.
- The walk-in form asks for every field the public form requires (owner,
  Oct 29, 2026: title, name, email, position, organisation, mobile, country,
  city, specialty, role; the type's member or student ID; its supporting
  document, uploaded through the public form's route), and the route enforces
  the same rules, so a walk-in is "Form completed" from the start
  (`detailsComplete` on `createRegistration()`). Terms and a password are not
  asked at the desk. This costs the desk time against the 30 to 40 second target;
  the owner chose complete details over speed.
- The desk picks a rate when the type has tiers (default: the one on sale now,
  else the last), because the usual shape is a type at 0 with the price on the
  tier, and without one a paid walk-in would be free.
- The desk is its own full-screen page, `/events/[id]/check-in/desk` (owner,
  Oct 29, 2026: one simple screen for temp and in-house staff): no dashboard
  sidebar, the event and the checked-in count in a header. It opens from the
  **Onsite desk** button on the Registrations page, beside Add Registration
  (owner, Oct 29, 2026; it was first a button on Check-In), and Exit returns
  there. Search on the left, the walk-in on the right. Enter acts on a
  single match; with no match, Enter treats the input as a scanned badge or
  confirmation barcode through the door's own check-in route. It sits under
  `/check-in`, so desk staff's confinement already covers it. It carries the
  organisation's logo in the header and the event's banner above the desk
  (owner, Oct 29, 2026).
- Codes at the desk (owner, Oct 29, 2026): a fourth payment choice,
  **Sponsor (Inclusive)**, takes a sponsor's code (one with "Sponsor covers
  the fee") and saves the walk-in INCLUSIVE under that sponsor, using one of
  their places; it works on a $0 sponsor rate too. Cash and card take an
  optional discount code that lowers what is collected; a code that leaves
  nothing to pay registers them complimentary with no payment, and a sponsor's
  code entered under cash or card switches the choice to Inclusive. The desk
  checks the code first (`GET .../registrations/walk-in/promo`, read-only) so
  the operator sees the amount before taking money; the walk-in then redeems
  it inside `createRegistration()` through `claimPromoCodeInTx`, the same
  redemption the public form uses, with the rules in `src/lib/promo-redeem.ts`.
  A refused code (used up, already used with that email) creates nothing.
  The desk sends the price it showed (after the code, before tax), and the
  service refuses with PRICE_CHANGED inside the transaction if its own figure
  differs, so a payment is never recorded for money nobody was asked for; a
  code that leaves nothing to pay goes as `covered`, which takes no payment
  right (review of f694a318). Known gap, as on the public form: on a $0 rate a
  sponsor's code writes no redemption row, so its per-email limit is not
  enforced there.
- Printing is NOT the default (owner, Oct 29, 2026): the desk's actions are
  **Check in**, **Record … & check in** and **Register & check in**, and a
  checked-in row offers **Print badge** (then **Reprint badge**) for whoever
  wants one (the
  Registrations page's Badges prints in bulk). Enter on someone already in
  says so and prints nothing. The text below describes the first build, which
  printed on every check-in.
- For someone already registered, "Check in & print" asks the door's own gate;
  when payment is due it opens Record payment (cash / card) in the row, then
  checks in and prints. "Complete onsite" for a not-completed row is step 3;
  until then the row shows "Form not completed" and can still be checked in.

## 5. Step 3: Complete onsite

### 5.1 At the desk

1. Search the person; a Not completed result offers **Complete onsite**.
2. A window with two tabs:
   - **Their phone**: a large QR code, the link in text under it, and a
     30-minute countdown;
   - **This tablet**: opens the same form on the desk tablet in tablet mode.
3. The window checks every few seconds. When the form is submitted it shows
   the person's completed details and either **Check in & print badge** or,
   for a paid rate, **Record payment** first.
4. Staff can close the window and serve the next person. Everyone with an open
   link sits in a **Waiting to complete** list on the panel (kept per desk),
   which turns green when they finish.

### 5.2 On the attendee's phone

The same branded completion page as the emailed link: name and email shown,
not editable; every public form field (§3.3); optional password. On submit the
confirmation page shows the barcode and the confirmation email with the
barcode is sent, as today.

### 5.3 On the desk tablet (`mode=tablet`)

The same form for a shared device: no password field, no autofill kept between
people, and after submitting a "Thank you, please hand the tablet back" screen
that clears itself after a few seconds. The tablet needs no staff login.

### 5.4 The link

- New staff route `POST .../registrations/[registrationId]/onsite-link`
  (`registrations.checkin` on the event): mints a completion link with a
  30-minute expiry through `mintRegistrationFormLink`, returns the URL and a
  QR image, and writes an audit row. It is the only place the raw link is ever
  shown to staff.
- Single use; minting cancels the person's emailed link, so they cannot
  complete twice; an expired link is replaced by pressing the button again.
- The rate comes from the registration's own type, so the organiser fixes a
  wrong type before making the link.

### 5.5 Edge cases

- Not in the system: the walk-in form (§4).
- Already completed: straight to check in & print.
- Wrong email from the import: corrected with the existing Change Email first.
- A paid rate with nothing paid: the badge stays refused until payment is
  recorded, as today.

### 5.6 As built (Oct 29, 2026)

- The link is details-only: it uses the rate-less identifier
  (`detailsOnlyRegistrationFormIdentifier`), which the completion route has
  always read as "keep their type and price". So nothing is re-priced, and
  someone whose payment is already recorded can still complete. Minted by
  `mintOnsiteCompletionLink()` in registration-form-service, which revokes
  their earlier links first; the completion route deletes it on submit.
- `POST .../registrations/[registrationId]/onsite-link` refuses a cancelled
  registration and one already complete (completedAt or an account), and
  returns the URL, a QR PNG as a data URL and the expiry. The audit row
  (`ONSITE_COMPLETION_LINK`) never holds the token.
- Tablet mode (`&mode=tablet` on the same link): no password section,
  autofill off on its fields, and a "please hand the tablet back" screen in
  place of the confirmation redirect; the tab, which the desk opened, closes
  itself after 8 seconds.
- The waiting list is kept per desk in the browser and polls each waiting
  person's own registration every 4 seconds (not the whole list), turns
  green when they finish, and drops people once checked in or once their
  link expires. Clicking a green name opens "Admit now", which records the
  payment first when money is owed.
- Owner, Oct 29: an **Edit** on each desk row for what prints on the badge
  (title, name, position, organisation, country), through the registration
  PUT with its optimistic lock; the email stays on Change Email.
- Review fixes (of `cf9775fd`): a row with no type that holds money, an
  invoice, a refund, a promo code or a group gets no link (`TYPE_REQUIRED`):
  the form would let them pick a type and leave the row priced at it, so the
  organiser sets the type first. Reopening a waiting person's window shows
  their link again instead of minting one (which would revoke the link they
  are typing into); "New link" asks first. The waiting list polls one small
  `GET .../registrations/completion-status?ids=` for everyone, chained, paused
  while the tab is hidden, and drops people who are gone or cancelled. The
  tablet tab opens with `noopener`, autofill is off on every field including
  billing, a form left idle for 5 minutes is cleared, and the hand-back
  screen blanks itself when the tab cannot close. Edit shows only with
  `registrations.update` and reloads on a conflict.
- Second review (of `055680a9`): a live onsite link is never replaced
  silently. The server checks for one and answers `LINK_ACTIVE` with its
  expiry unless the desk confirms `replace`, so a reloaded desk or a second
  desk asks first. Sponsor-paid (INCLUSIVE, or any sponsor) typeless rows
  are refused too. The waiting-list poll needs `registrations.checkin`, the
  same key as making the link; a late answer no longer drops someone added
  meanwhile; it asks 50 at a time. An idle tablet form now leaves the page
  (the token is in the URL), and the idle timer runs only on a loaded form.
  Minting runs in `tenantTransaction`.
- The hand-back screen (owner, Oct 29) shows the event, their name, type and
  email, says the confirmation with the entry barcode was emailed (the
  completion route now returns `emailed`, so a failed send is never claimed),
  and asks them to hand the tablet back, with a 20-second countdown.
- A typeless COMPLIMENTARY row (the CSV import default) was offered the open
  public rate by Complete onsite, and completing it would have made the comp
  owe (BHS2026 #78, Oct 29). Owner: the registration's own type and payment
  status decide, never what an earlier email carried. A link without a rate
  now completes such a row at no charge (`rateFromRegistration` in
  registration-form-pricing.ts): its types are offered free and it stays
  COMPLIMENTARY. A typeless row that owes keeps the open public rate; a row
  with a type keeps its own type and price.
- The desk's search also matches a full name in either order
  (`matchesDeskSearch`); the Registrations page's rule is unchanged because
  its CSV export must hold exactly the rows on screen.

## 6. Owner decisions (Oct 28, 2026)

- Paid walk-ins: the invoice, receipt and email may arrive later.
- Printing: manual print dialog at the desk (no Chrome kiosk printing), and
  only on request since Oct 29 (Print badge on a checked-in row).
- Completing onsite: both the attendee's phone (QR) and a desk tablet.

- Desk QR forms (Oct 29): two forms only, exhibitors and complimentary;
  exhibitors are always exhibitors (the type is locked); an account is made
  without a password and set later through Forgot password; a 30-minute
  token on both QRs, so desk mode works only at the desk.

## 7. Delivery

Three steps, each built, tested, adversarially reviewed and committed on its
own, with the touched screens shown before it is pushed:

1. Foundation (§3), about a day. BUILT Oct 28, 2026 (`154fba99`, fixes `de3d371c`).
2. Walk-in panel (§4), about two days. BUILT Oct 29, 2026 (`26c17807`, review
   fixes `80c565f5`, then the desk page).
3. Complete onsite (§5), about two days. BUILT Oct 29, 2026.

## 8. Step 4: Desk QR forms for exhibitors and complimentary (BUILT, Oct 29, 2026)

The walk-ins that queue in numbers are exhibitors arriving for their stands
and complimentary guests. Both are free, both already have a public rate
form (BHS2026: the Inclusive rate, which needs a sponsor's code, and the
Complimentary rate), and both are slowed down by the same two things: the
password step, and staff typing. Paying walk-ins stay on the walk-in panel
(§4), where the desk takes the money.

### 8.1 At the desk

1. **Walk-in QR** on the desk opens a full-screen panel with two tabs.
2. **Exhibitors**: staff pick the sponsor (the event's sponsor codes that
   cover the whole fee, with the places left beside each). The QR is for that
   sponsor's exhibitors.
3. **Complimentary**: one QR for complimentary guests.
4. The QR sits on the desk screen facing the queue, the link in text under
   it. It renews itself every 15 minutes while the panel is open, so any QR
   on screen has at least 15 minutes left.
5. They submit on their phone and show the barcode on their confirmation
   page; staff scan it to check in, and print on request (§6).

### 8.2 On their phone (desk mode)

- One page: email and details, no password step.
- **Exhibitors**: the type is Exhibitor and cannot be changed; the sponsor's
  code is applied and cannot be removed. They type only their own details.
  The badge prints Exhibitor (`exhibitorBadgeData`), the registration is
  INCLUSIVE and credited to the sponsor.
- **Complimentary**: they pick their type among the types that have the
  event's Complimentary rate (never Exhibitor or Faculty). COMPLIMENTARY,
  Delegate badge.
- The same fields, documents and identity evidence as the public form.
- An email already registered for the event is refused with "You are
  already registered: please go to the desk", where search finds them.

### 8.3 The account

- Desk mode makes the registrant account without a password: a random,
  unusable password hash, the pattern reviewer invites already use.
  `ensureRegistrantAccount` gains that option; an existing account at the
  email is linked, as today.
- The confirmation email adds one line: set a password to manage your
  registration online, linking to the event's Forgot password page with
  their email filled in (the page reads `?email=`). No new token logic.

### 8.4 The token

- The QR link is the rate form with `?desk=<token>`. The token is signed by
  the server (HMAC, a key derived from `NEXTAUTH_SECRET` for this purpose
  only) and carries the event, the kind (exhibitor or complimentary), for
  exhibitors the sponsor's promo code id, the staff member who made it, and
  an expiry 30 minutes out. Nothing is stored per token.
- Desk mode applies only while the token is valid, for that event and that
  kind. Without one, or with an expired one, the link is the ordinary public
  form, exactly as today: a photo of the screen shared later is dead.
- Checked when the form loads and again on submit. Submitted after expiry:
  "This desk QR has expired, please scan the one at the desk again", and
  what they typed is kept (the form's draft).
- Making a token needs `registrations.create` on the event, the walk-in
  panel's key.
- Rotating `NEXTAUTH_SECRET` kills open desk QRs; the panel makes a new one.
  Closing the panel does not kill a QR already shown; 30 minutes bounds it.

### 8.5 The server

- No new registration path: the public register route accepts the token
  and, while it is valid, relaxes exactly four things: the password may be
  absent (8.3), the rate's sales end is ignored (its seat limit is not),
  the type and code come from the token for exhibitors, and the per-IP rate
  limits become a per-token limit (venue Wi-Fi puts the whole queue on one
  IP; 15 a minute would stop it). The per-email limit stays.
- Free only: a desk-mode registration that would cost anything is refused,
  so desk mode can never take a registration that owes money.
- Recorded as PUBLIC_REGISTER with an audit row naming the desk token's
  kind and the staff member who made it (no new enum value, so no migration
  and no rollback hazard).

### 8.6 Edge cases

- An event with no Exhibitor type, or no sponsor codes: the Exhibitors tab
  says so and points to Registration Types / Promo Codes.
- An event with no Complimentary rate: the tab says so.
- A sponsor's places used up: refused with the existing "usage limit
  reached" message; the desk raises the code's limit in Promo Codes.
- A webinar: no desk, no QR.

### 8.7 Printing (deferred, owner Oct 29)

No printed QRs for now: the QR is shown on the desk screen only. A printed
sheet would outlive a 30-minute token, so it needs a longer validity, and
the owner will decide that later. The options discussed: an exhibitor sheet
per sponsor valid to the end of the event (the sponsor's code, attribution
and places limit bound it), and a complimentary sheet valid to the end of
the day with a registration cap counted from the audit rows.

### 8.8 Delivery

About two days: the token and the route changes with their tests first
(token sign and verify, each relaxation only with a valid token, free only,
expiry on submit), then the form's desk mode, then the desk panel, then the
user guide's Onsite desk Q&As. Built, reviewed and committed like steps 1
to 3, and shown in the browser before any push.

### 8.9 As built (Oct 29, 2026)

- `src/lib/desk-qr-token.ts` (sign and verify, server only) and
  `src/lib/desk-qr-rules.ts` (the type, rate, code and price rules, and
  `readDeskQrClaims` for the form's look, client-safe).
- `GET/POST .../registrations/desk-qr`: the panel's options (the Exhibitor
  type's sponsor-code rate, the sponsors' codes with places left, the
  Complimentary rate) and the QR. Each QR shown writes a `DESK_QR_SHOWN`
  audit row with its id, never the token; the registration's audit row
  names the same id (`deskQr`).
- The public register route reads the token before its rate limits. An
  expired or forged token is refused with "scan again", never quietly
  treated as the public form, so nobody is asked for a password at the desk.
- The rate form's desk mode: one page with the email on it, the step
  indicator and Back hidden, Exhibitor only (or never), the exhibitor's code
  read-only, and a rate that closed online reopened while it has seats.
- The account helper makes the account with a random password
  (`withoutPassword`); the confirmation email adds the set-a-password line,
  linking to the event's Forgot password page with the email filled in.
- An event that is COMPLETED (or not published) has no public form, so its
  desk QR opens "Event not found": desk mode does not reopen a finished event.

