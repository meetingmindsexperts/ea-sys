# Account confirmation and account sign-up: the plan

PHASE 1 BUILT (Nov 5, 2026); phase 2 not started. Owner rulings: **signing up
for an account needs email confirmation; registering for an event does not**;
"security is top priority".

## As built (differs from the plan below where noted)

- **The proof is a new column, `User.emailConfirmedAt`**, not `emailVerified`.
  Building it found that public submitter sign-up and admin-created accounts
  set `emailVerified` without any proof, so it could not be trusted. The new
  column is set only by a link sent to the address: `/verify-email`, invitation
  accept, password reset. Migration `20261105120000_user_email_confirmed_at`,
  additive, no backfill.
- **One rule, `src/lib/registrant-access.ts`**: `ownRegistrationWhere(scope)`
  is linked registrations, plus those carrying the address once it is
  confirmed (case-insensitive). My events, certificates (registrations and
  speaker records), and the registrant routes (registrations GET, profile,
  resend-confirmation, promo) and abstract-start's registration pre-fill all
  use it. The registrations GET no longer links on every read; it links only
  for a confirmed account.
- **D1 changed on security grounds: no one-time linking script.** The 192
  email-matched registrations of 145 accounts are hidden until each person
  confirms, rather than blessed permanently.
- **D2 as recommended**: a short confirmation email only when there are
  earlier registrations to claim; My events and the event's own page show a
  "Registered before with this email?" notice with a Send button
  (`POST /api/registrant/confirm-email`, 3 per hour, to the account's own
  address from the database). The notice never says how many.
- **Not changed, flagged:** abstract-start still finds a SPEAKER record by
  email, which is how an invited presenter's record is claimed.

## Security review of 7cf4eb3b, fixed in the next commit

- **BLOCKER: the link proves the mailbox, not the account.** Someone could
  register with your address and their own password; the system mailed you
  the link; your click (or a mail scanner's) confirmed THEIR account. Now
  `/api/auth/verify-email` counts only from a signed-in session of the
  account the link names (401 `SIGN_IN_REQUIRED`, 403 `WRONG_ACCOUNT`, the
  token kept), and the page offers "Sign in to confirm" and returns. The real
  owner of an account they did not make takes it over with Forgot password,
  which signs the other person out.
- **HIGH:** a staff email change (`cascadeLinkedUserEmail`) clears
  `emailConfirmedAt`, so a confirmation never carries to a new address.
- **HIGH, partly fixed:** a speaker record linked to one account is never
  moved to another (`SpeakerLinkedElsewhereError`, 409), and abstract-start
  pre-fills from another event's speaker profile only for a confirmed account.
  **Open, owner decision:** an invited speaker with no account can still be
  claimed by anyone who signs up as a submitter with that address.
- **MEDIUM:** a confirmed account's address branch matches unlinked
  registrations only, never one linked to another account.
- **LOW:** confirmation tokens use the lower-cased address; sending a new link
  no longer deletes a pending one.

## Invited speakers, and the re-review of 5b870d59 (owner: "ok add it")

- **An unclaimed speaker record** (the organisers added, invited or imported
  the speaker) is claimed only by an account that has confirmed the address.
  `upsertEventSpeaker(…, accountConfirmed)` writes nothing otherwise and
  returns null; the submitter sign-up still makes the account (so the person
  can sign in and confirm), says so on its success screen and emails a
  "speaker" confirmation link; abstract-start answers 409
  `CONFIRM_EMAIL_TO_CLAIM` and sends the link. Confirming claims it
  (`linkConfirmedSpeakers`). A brand-new speaker needs no confirmation.
  Abstract-start's pre-fill from this event's speaker record follows the
  same rule.
- **A new registration attaches to an existing account only with proof**:
  the caller verified the signed-in session (`linkOnly`), the password
  matches, or the account has confirmed the address. Otherwise it stays
  unlinked and reaches the address's proven owner through the access rule.
- **A password reset no longer confirms the address.** Sessions from before
  the reset live up to five more minutes and could belong to whoever made the
  account; the new owner confirms from their own fresh session. Accepting an
  invitation confirms and revokes earlier sessions (`tokenVersion`).
- The confirm page offers "Reset the password" for an account with no
  password (made at the desk) or one the person did not make.

## Security review of dd21f2c9, fixed in the next commit

- **A revoked session counts for nothing at once.** A non-staff session is
  re-checked only every five minutes, so one a password reset revoked still
  worked meanwhile. The Node session callback now carries the session's
  `tokenVersion` (server only; the Edge mapper does not), and
  `loadRegistrantScope(userId, proof)` treats an account as confirmed only
  when that matches the database; verify-email refuses such a session. The
  password-checked door (abstract-start) passes `"password-checked"`.
- **Nothing changes before the claim can happen.** `speakerClaimPending` runs
  before any write: an existing unconfirmed account keeps its role and
  details (409 `CONFIRM_EMAIL_TO_CLAIM`); a new person still gets the account
  so they can sign in and confirm. The form shows a lasting "Confirm your
  email" screen rather than a toast.
- **The claim's follow-through:** verify-email returns the events whose
  speaker profile it claimed, and the page links back to each event's
  submission page, which now runs the full path (details, presenter rate,
  badge registration) for the confirmed account.
- `linkConfirmedSpeakers` also filters on the host's organisation;
  confirmation emails are limited to 5 per address per hour, whoever
  triggers them.


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
