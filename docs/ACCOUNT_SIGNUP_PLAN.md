# Catalogue branding and account sign-up with ID proof: the plan

**Sections 2 and 3 BUILT Nov 9, 2026** (`7ec521bb` sign-up restored, `db1be3ab`
/my-account, My Details and the profile, then the review fixes): /signup asks the
registration form's questions and the marketing box; an account made there
carries `AccountProfile.signedUpAt` and confirms before signing in; consent
ticked at sign-up counts only once the address is confirmed (double opt-in); a
password reset taking over an unconfirmed sign-up clears its details and
consent; My Details copies changed fields onto upcoming, linked registrations,
never a speaker's companion, a printed badge or a bought DTCM code. Section 1
(catalogue branding) and section 4 (ID proof, waiting on D4/D5) are NOT built.
The Mailchimp mirror waits for the `marketing_consent` column in
contacts_centralv1. Original status: PLANNED (Nov 9, 2026). Owner request: "to catalogue page, we need
to give its own logo and branding, as well as we will proceed with Account
Sign up which should ask the same mandatory questions as public reg form plus,
upload a valid id proof as required (we need one way or other to verify this
id is correct or not, may be add AI here)"; and "account sign up should have
checkbox agree to marketing which will be sent to mailchimp contacts".

Builds on [ACCOUNT_CONFIRMATION_PLAN.md](ACCOUNT_CONFIRMATION_PLAN.md) phase 2
(the light `/signup`: name, email, password, terms), which sits in a stash
waiting on Medhat's call between EA-SYS and a separate app on the API. **That
call still comes first**: everything below assumes sign-up lives in EA-SYS.

Production, Nov 9, 2026 (read-only): 591 attendee accounts, **263 of them made
in the last 30 days** (by registering for an event; there is no sign-up page
yet); 2,158 registrations in 30 days; 9 events in the catalogue; one
organisation.

## 1. The catalogue's own branding

Today the catalogue borrows the ORGANISATION's logo (inverted to white on the
navy hero) and name. Its text, hero photo and sections are already its own
(Settings, Catalogue: `Organization.settings.catalogue`, `src/lib/catalogue.ts`).

Add to `CatalogueSettings`, each falling back to the organisation's when empty:

| Field | Use |
|---|---|
| `brandName` | Nav, footer, page titles, `siteName` in the share tags, JSON-LD publisher |
| `logo` | Full-colour logo, for light surfaces (sign-up, sign-in, emails) |
| `logoOnDark` | For the navy hero and footer; when absent, `logo` inverted as today |
| `favicon` | Catalogue, topic and sign-up pages |
| `brandColor` | Buttons and links, through the same `brandPaletteCss` the event pages use |

Where it shows: `/catalogue`, the topic pages, and the account pages reached
from it (sign-up, sign-in, confirm email), plus the sign-up confirmation email.
Event pages keep the event's own branding. Images go through the media library
and `isCatalogueHeroImageUrl`'s rule (an upload or https, never `..`).

No migration (settings JSON). About **1 day**.

## 2. Account sign-up asking what the registration form asks

**Fields**, the public form's required set (`register/route.ts`
`registrationSchema`) so a later registration needs nothing new: title, role,
first and last name, email, organisation, position, mobile, city, country,
specialty (with "other"); State and Zip optional as on the form; password and
terms. Plus the marketing tick box (§3) and the ID upload (§4).

**Where they live.** An account holds only name and specialty today; every
other detail sits on a registration's Attendee row. A new `AccountProfile`
table, 1:1 with User (additive migration), holds them. The registrant profile
route (`/api/registrant/profile`, which pre-fills registration forms) falls
back to it when the person has no registration yet. A later edit on a
registration does not rewrite the profile (an event may need a different
organisation on the badge).

**Rules carried over from phase 2:** email confirmation before an account
with no registrations can sign in (owner ruling), per-IP and per-email limits,
a honeypot, "account already exists" never saying whether the address is
registered, the 30-day prune of unconfirmed empty accounts.

About **2 to 3 days** on top of the stash.

## 3. Marketing consent, to Mailchimp

A tick box, **unticked by default** and separate from the terms ("Send me
news about upcoming events and CME. You can unsubscribe at any time."). Opt-in
must be an action, never a default, for the consent to count.

Stored on the account: `marketingConsentAt`, the IP, the exact wording's
version, and `marketingConsentWithdrawnAt`. My events gets a switch to
withdraw it (and give it later).

**Mailchimp is not integrated from EA-SYS and should not be.** Your n8n flow
already pushes `contacts_centralv1` (which EA-SYS feeds,
`src/lib/contacts-central-sync.ts`) into Mailchimp nightly, and today it pushes
**every** EA-SYS contact as `subscribed`, with no consent signal at all.
So the change is in two places:

1. **EA-SYS:** two new mirror columns, `marketing_consent` (true / false /
   null for "never asked") and `marketing_consent_at`, written by the sync.
2. **Your n8n flow:** status by consent. `true` goes in as `subscribed`;
   `false` (withdrawn) is unsubscribed; `null` (registrations, which never
   asked) per D8 below.

Worth deciding with it: the event registration form asking the same question
(D8), since that is where 99% of new contacts come from.

About **1 day** in EA-SYS; the n8n change is yours.

## 4. ID proof

### First: what is the ID for?

The answer picks the document, and it changes the plan.

- **"Is this a real person, with this name?"** A passport, national ID or
  driving licence. Proves identity, says nothing about profession.
- **"Is this a healthcare professional?"** (pharma-sponsored education and CME
  are usually restricted to HCPs.) A national ID cannot answer that. A
  **professional licence** can (DHA, DOH, MOHAP in the UAE; the medical
  council elsewhere), and the UAE licences can be checked against the
  regulators' public registers, which is real verification, not a guess
  from a photo.

### The gap to close either way

Accounts are also made by registering for an event (263 in 30 days), with no
ID. If only `/signup` asks for ID, the requirement is one click from being
skipped. So decide what an UNVERIFIED account cannot do (D5): for example
register for an HCP-only event, or download CME certificates. Without that,
the upload collects sensitive documents and gates nothing.

### Storing it

An ID document is the most sensitive file this system would hold.

- A private prefix like supporting documents (blocked from the public
  `/uploads` route, `src/lib/supporting-document.ts`), S3 with the KMS key,
  PDF/JPEG/PNG, magic-byte checked, 5 MB.
- Viewable only by staff holding a new permission key `identity.review`,
  every view audited.
- **The image is deleted once decided** (verified or rejected). What stays:
  document type, issuing country, expiry, last 4 characters of the number,
  who decided, when, and how. Nobody can leak a passport scan that no longer
  exists.
- **Residency:** uploads sit in Mumbai (ap-south-1); the UAE region move is
  deferred. UAE national IDs stored outside the UAE need a legal check (PDPL)
  before this goes live. It belongs on the GDPR/PDPL backlog either way.

### Verifying it: the options

| | How | Proves | Cost | Effort |
|---|---|---|---|---|
| **A. Staff review** | A queue: open the file, compare with the sign-up, approve or reject with a reason | What a person can see | Staff time | ~1.5 days |
| **B. AI pre-check + staff** | Claude reads the image: document type, name, date of birth, expiry, number; compares the name with the sign-up; flags expired, mismatched, not-an-ID, cropped or obviously edited. Staff decide, with the AI's reading beside the image | Consistency, not authenticity: it sees no hologram or chip and has no government database, so a good fake passes | Cents a check | +2 days (our AI layer has no image support yet) |
| **C. KYC vendor** (Sumsub, Veriff, Onfido, Persona) | Hosted capture with a live selfie: document security features, face match, liveness | Authenticity | Roughly $1 to $3 a check, plus a contract and a data processing agreement (to confirm with the vendor) | 3 to 5 days + procurement |
| **D. UAE Pass** | Sign in with the government digital identity | Government-verified identity | Free | Government onboarding; UAE residents only, so not for international delegates |
| **E. Licence lookup** (if the goal is HCP) | Licence number checked against the DHA / DOH / MOHAP public register, by staff or automated where the register allows | Current professional licence | Free | 1 to 3 days per register |

**Recommendation:**

- **If the goal is HCP status,** use E with A, and skip the national ID
  entirely. It verifies what you actually care about and stores less.
- **If the goal is identity,** start with B: the AI reads and flags, staff
  decide. Never let the AI approve or reject on its own. It cannot tell a
  good fake from a real one, and a wrong rejection locks a real doctor out.
  At today's volume (about 9 new accounts a day), a reviewer clears the queue
  in minutes. Move to C if fraud actually shows up or the volume outgrows the
  reviewer.
- **If AI is used at all,** the image goes to Anthropic's API, which means
  data leaving our infrastructure. Check the API's data retention terms and
  name it in the privacy notice before the first upload.

### States

`UNVERIFIED` (signed up, no file) → `PENDING_REVIEW` (file uploaded, AI read
attached) → `VERIFIED` or `REJECTED` (reason shown to the person, who may
upload again). Every change is in the audit log; the person is emailed on a
decision.

## Phases

| # | What | Size | Waits on |
|---|---|---|---|
| 1 | Catalogue branding | 1 day | nothing |
| 2 | Sign-up with the full profile (phase 2 stash + `AccountProfile`) | 2 to 3 days | Medhat (EA-SYS or separate app) |
| 3 | Marketing consent + the mirror columns | 1 day | D7, D8; then your n8n change |
| 4 | ID upload, private storage, staff review queue, delete-on-decision | 2 days | D4, D5, D6, the residency check |
| 5 | AI pre-check (or the vendor, or licence lookup) | 2 to 5 days | D4 |

## Decisions for the owner

- **D1.** Sign-up in EA-SYS or a separate app on the API (Medhat, already open).
- **D2.** Catalogue brand: one brand name and logo for the whole catalogue,
  shown on sign-up, sign-in and the confirmation email too (recommended).
- **D3.** Are the profile fields exactly the public form's required set
  (recommended), or more?
- **D4.** What the ID proves: identity (passport / national ID) or HCP status
  (professional licence, recommended for medical events).
- **D5.** What an unverified account cannot do, and whether accounts made by
  registering for an event must verify too. Without this the upload gates
  nothing.
- **D6.** Verification method: staff only, AI pre-check + staff
  (recommended to start), a KYC vendor, UAE Pass, or the licence lookup.
- **D7.** Marketing wording, and whether withdrawal on My events is enough or
  you also want an unsubscribe link handled by Mailchimp alone.
- **D8.** Whether the event registration form gets the same tick box, and what
  the n8n flow does with contacts who were never asked (`null`): today they
  all go in as `subscribed`.
