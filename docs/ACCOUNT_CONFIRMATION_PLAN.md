# Account confirmation and account sign-up: the plan

PLANNED, NOT BUILT (Nov 5, 2026). Owner ruling: **signing up for an account
needs email confirmation; registering for an event does not.**

## The problem this fixes

An account today is trusted with every registration that carries its email
address, and nobody has proved they own that address:

- When someone sets a password on the registration form, `ensureRegistrantAccount`
  links **every earlier registration with that email that has no account** to
  the new account (the "sweep").
- My events and six registrant routes also match registrations **by attendee
  email**, linked or not.

So if a person once registered as a guest (no password), anyone who later
registers with that person's email and a password gets an account that shows
the guest's registrations, payment status, invoices and certificates. This
was read from the code, not reproduced.

Production, read-only, Nov 5: 562 registrant and submitter accounts, **418
never confirmed**; **192 registrations reach 145 accounts only through the
email match**; no registration is linked to an account with a different email.

## The rule

| Action | Confirmation needed? |
|---|---|
| Register for an event (with or without a password) | **No.** The account is created at once and owns **that** registration: pay, barcode, edit, certificate |
| See **other** registrations made earlier under the same email | **Yes.** They join the account when the email is confirmed |
| Create an account on its own (sign-up page, phase 2) | **Yes**, before it can sign in |

An address is "confirmed" when `User.emailVerified` is set. No new column.

## Phase 1: close the gap (no new pages)

1. **Sweep only on confirmation.** `ensureRegistrantAccount` links just the
   registration being made. The sweep of other unlinked registrations moves
   to the confirm step. For an existing account it runs only if that account
   is confirmed.
2. **No more matching by email.** My events, `findReleasedCertificates` and the
   registrant routes (`registrant/registrations`, `registrant/profile`,
   `resend-confirmation`, `promo`) read **linked registrations only**
   (`userId`). `abstract-start` gets the same rule.
3. **Confirming claims the rest.** The existing `/verify-email` flow
   (`email-verification.ts`, `POST /api/auth/verify-email`) becomes general:
   it sets `emailVerified`, sweeps the unlinked registrations on that address
   (inside the host's tenant lane, as today), and still attaches the
   organisation for an internal domain.
4. **Ask only when there is something to claim.** After registering, if other
   unlinked registrations exist on that email, send one short "Confirm your
   email to see all your registrations" message. My events shows "We found N
   more registrations under your email" with a Send link button.
5. **Existing accounts keep what they see (decision D1).** A one-time script
   links the 192 email-matched registrations to their 145 accounts before the
   email matching is removed. Nobody loses a registration from My events, and
   nothing new becomes visible to anyone. Dry run first, then run it from the
   worker container, reported by count.

Tests: every registrant route refuses an unlinked registration; a new account
sees only its own registration; confirming claims the rest; an existing
unconfirmed account no longer sweeps; the script is idempotent.

## Phase 2: an account sign-up page (only if wanted)

- `/signup` (linked as "Create an account" from sign-in and the catalogue):
  name, email, password, terms. It creates the account unconfirmed and sends
  the confirmation link. **Sign-in refuses an unconfirmed account that has no
  registrations** ("Check your email to confirm your account"), so a
  registration-made account still signs in at once. No schema change.
- Lands on an empty My events with **Browse events**. Registering later is
  pre-filled, as today for signed-in people.
- Guards: per-IP and per-email rate limits like the register route, a
  honeypot field, the same password rule, and "account already exists" that
  never says whether the address is registered.
- Needs **organisation-level terms** (today terms live on each event): a
  terms and privacy link in Settings, Catalogue (decision D3).
- No "new signup" admin notification (today it is per event, and there is no event).
- **Retention:** an account with no registrations that stays unconfirmed for
  30 days is deleted by a worker job; a confirmed one with none for 24 months
  is flagged. Ties into the GDPR retention item.

## Multi-tenancy

Fits the decided model (PLATFORM_DECISIONS §6, per-tenant accounts): the
account is created in the tenant of the host it was made on, and the sweep
already runs inside that tenant's lane. On the platform the confirmation
email needs per-tenant sending (§9, decided, not built); on master it works
today.

## Decisions for the owner

- **D1.** Existing 145 accounts: link their 192 email-matched registrations
  once (recommended), or make them confirm too.
- **D2.** Ask for confirmation in a separate short email only when there is
  something to claim (recommended), or add a line to every registration
  confirmation email.
- **D3.** Phase 2 now, later or never; and if now, where the organisation's
  account terms live.

## Size

Phase 1: about a day, eight files, one script, no migration. Phase 2: about
two days.
