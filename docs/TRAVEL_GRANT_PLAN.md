# Travel Grant: plan

> **Status: PLANNED, NOT BUILT.** Do not start without an explicit owner
> go-ahead. This file is the decision record; when it ships, the header changes
> to BUILT and any deviation from the plan is recorded here with its reason.
>
> **Planned 2026-08-25.** Every claim about the current system in §2 and §3 was
> read in source or queried read-only against production on that date, not
> recalled.

## 1. What it is

An author submits an abstract. If that author is **not based in the UAE**, their
submission-confirmation email carries a short message and a personal link. The
link opens a one-page form where they **confirm they are not a UAE resident and
that they wish to be considered for a travel grant**, and accept the grant terms.
That consent is recorded with a typed-name signature, a timestamp and an IP.

A UAE-based author sees nothing. No extra email, no empty section, no dead link.

The organizer turns the feature on per event under **Settings → Abstracts**, and
writes the message and the terms under **Content → Abstracts**.

## 2. Owner decisions (locked 2026-08-25)

| # | Decision | Chosen |
|---|---|---|
| **D1** | What the form captures | **Eligibility + interest only.** Not-a-UAE-resident confirmation, wish-to-be-considered, accept the terms, typed-name signature. **Nothing financial.** The money side is already covered by Speaker Reimbursement and must not be duplicated here. |
| **D2** | Scope | **One grant record per person per event**, not per abstract. Three abstracts from one author is one link and one consent. The grant follows the traveller, and a person only travels once. |
| **D3** | Delivery | **A block inside the existing `abstract-submission-confirmation` email**, not a separate send. One email. |
| **D4** | Unknown or unrecognised country | **Do not send, and flag it in the console.** An offer sent to a Dubai resident who is then refused costs more than a missing one, because a missing one is chaseable. |

## 3. Live state on production (read-only, 2026-08-25)

| Fact | Value | Why it matters |
|---|---|---|
| Abstracts, all events, all statuses | **7** | The feature is being built ahead of volume, which is the cheap moment. |
| Of those, author outside the UAE | **2** | The eligible population today is two people. |
| Of those, author with no country recorded | **0** | D4 governs no existing rows. It is a rule for the future, not a backfill. |
| Speakers with a country recorded | 59 UAE, 12 Oman, then Egypt / Qatar / Saudi / Kuwait / Bahrain / Syria | Real distribution: the UAE is the majority, so the feature will usually be quiet. |

**Nothing named travel grant exists in the codebase today.** This is greenfield.

## 4. The eligibility predicate, which is the load-bearing piece

**`Speaker.country` holds a display name, not an ISO code.**
[country-select.tsx:28](../src/components/ui/country-select.tsx#L28) writes
`c.name`, so production holds the string `"United Arab Emirates"`. But line 21 of
the same file resolves a stored value on **either** `code` or `name`, which means
the rest of the app tolerates a legacy row holding `"AE"`.

**So `country !== "United Arab Emirates"` is wrong**, and wrong in the expensive
direction: a row holding `"AE"` would be classified as overseas and a Dubai
resident would receive a travel grant offer.

### The shape

A new client-safe `src/lib/travel-grant/eligibility.ts` exports:

```ts
export type ResidencyClass = "uae" | "overseas" | "unknown";
export function classifyResidency(country: string | null | undefined): ResidencyClass;
```

**Three states, deliberately not a boolean.** A boolean makes the unknown case
unrepresentable, so it would have to be silently folded into one of the other
two, which is precisely the mistake the per-type supporting-document work
corrected in August by keeping `requiresDocument` and `documentRequired` as two
separate flags. D4 is only expressible because `unknown` has a name.

Normalisation: trim, lowercase, collapse internal whitespace, strip full stops.
The UAE set is an explicit enumeration (`united arab emirates`, `uae`, `ae`,
`u a e`), **not a substring match**. Empty, whitespace-only and anything not in
the country list resolve to `unknown`.

**Pinned by test in both directions**, and the mutation to verify against is
replacing the enumeration with `country !== "United Arab Emirates"`, which must
fail the `"AE"` case.

### Snapshot at consent, do not re-derive

`Speaker.country` is editable after the fact. The consent record therefore
**snapshots the country as it was when consent was given**, the same way
`Speaker.agreementTextSnapshot` snapshots the agreement and
`SpeakerReimbursement` snapshots the speaker's details. A later profile edit must
not rewrite what somebody signed.

## 5. Data model

One new table, plus two nullable content columns on `Event`. Settings JSON, no
column, for the on/off switch.

```prisma
enum TravelGrantStatus {
  PENDING    // invited, has not opened or has not submitted
  CONSENTED  // confirmed eligibility and interest
  DECLINED   // opened the form and said no thanks
}

model TravelGrant {
  id             String            @id @default(cuid())
  eventId        String
  organizationId String?           // denormalized tenant key, stamped from Event at create
  speakerId      String
  token          String            @unique
  status         TravelGrantStatus @default(PENDING)

  // Snapshot at consent time. Never re-derived from Speaker.
  countryAtConsent String?
  fullName         String?
  institution      String?
  termsSnapshot    String?         @db.Text

  signedName  String?
  submittedAt DateTime?
  submittedIp String?

  invitedAt   DateTime?            // when the link was last put in front of them
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@unique([eventId, speakerId])   // D2: one per person per event
  @@index([eventId, status])
}
```

Two new `Event` columns, both `String? @db.Text`, both edited on the
**Content → Abstracts** tab beside `abstractGuidelinesHtml`:

- **`travelGrantMessageHtml`**: the message that appears in the email above the
  button. This is the "personal message" from the request.
- **`travelGrantTermsHtml`**: what the form shows and what the author is
  consenting to. Ships with a sensible default the way
  `DEFAULT_SPEAKER_AGREEMENT_HTML` does, so an organizer who enables the toggle
  and writes nothing still gets a coherent form rather than a blank one.

**Two texts, not one, because they answer different questions.** The email says
*here is why you are receiving this*; the form says *here is what you are
agreeing to*. Collapsing them would put the terms in the email body and leave the
consent page with nothing to consent to.

The switch lives in `Event.settings.travelGrant = { enabled: boolean }`. Settings
JSON, so **no migration for the toggle**, consistent with `abstractLimits` and
`sessionProposalDeadline`. The event PUT accepts `settings` as an open
`z.record`, so this is not a dead write; that was verified before relying on it,
because a switch that saves and is read by nothing is worse than no switch.

Migration is **additive and idempotent**: one enum, one table, two nullable
columns. Nothing existing changes.

## 6. The flow, end to end

### 6a. At abstract submission

`sendAbstractSubmissionConfirmation()` in
[abstract-notifications.ts](../src/lib/abstract-notifications.ts) is already the
one sender for both first submission and resubmission. It gains one step before
rendering:

1. Feature off for this event, or abstract not `SUBMITTED` (a draft is not a
   submission) → block renders empty, nothing is created.
2. `classifyResidency(speaker.country)` is `uae` or `unknown` → block renders
   empty, nothing is created. **`unknown` additionally logs at warn**, so the
   organizer can find the person in the console and decide by hand. D4 is a
   refusal that leaves a trace, not a silent drop.
3. `overseas` → find-or-create the `TravelGrant` row on `(eventId, speakerId)`,
   mint the token on create only, stamp `invitedAt`, render the block.

Find-or-create rather than create is what makes D2 hold: a second abstract from
the same author reuses the same row and the same link.

**Failure-isolated by contract.** A travel-grant failure must never stop the
abstract confirmation from going out, exactly as
`ensureSpeakerCompanionRegistration` is isolated from speaker creation. Wrapped,
logged at error, and the email still sends without the block.

### 6b. The email variable

Modelled directly on `buildAgreementBlock()` in
[speaker-agreement.ts:110](../src/lib/speaker-agreement.ts#L110), which already
solves this exact problem for the speaker agreement.

`buildTravelGrantBlock()` returns one of four states:

| State | Renders |
|---|---|
| Feature off, or author is UAE / unknown | **Empty string.** Not a heading with nothing under it. |
| Eligible, not yet consented | The organizer's `travelGrantMessageHtml`, then a CTA button to the personal link. |
| Eligible, already consented | A short confirmation note. **Never asks again.** Mirrors the green already-signed note on the agreement block. |
| Eligible, declined | Empty. They said no; do not re-ask on their next abstract. |

Exposed as `{{travelGrantBlock}}` (added to `DEFAULT_RAW_HTML_KEYS`, since it is
organizer-authored HTML and not recipient-controlled) and
`{{travelGrantBlockText}}` for the plain-text alternative.

> ### The trap that has bitten this repo twice, and will bite here
>
> **Adding the token to the DEFAULT template reaches nobody who already has a
> saved template row.** The templates list GET auto-seeds system defaults as
> editable rows, and 24 events already hold a materialised
> `abstract-submission-confirmation`. Adding `{{travelGrantBlock}}` to the
> default alone means every one of those events silently sends the old body.
>
> This is exactly what happened to the presenter-registration quote block on
> 11 August, and to `{{itemWord}}` in the RSVP round. **The fix is the same one
> that worked before: append the block when the resolved template does not
> already contain the token.** Pinned by a test that asserts a saved template
> lacking the token still receives it.

### 6c. The public form

`/e/[slug]/travel-grant/[token]`, mirroring
`/e/[slug]/reimbursement/[token]` which is the closest existing analogue.

- Token looked up unique, event slug asserted against the token's event so a
  valid token cannot be replayed against another event's URL.
- Renders the event banner, the author's name, `travelGrantTermsHtml`, one
  required tick ("I confirm I am not a UAE resident and I wish to be considered
  for a travel grant"), a typed-name signature field, Submit and a Decline
  action.
- Submit is a **conditional claim on `status = PENDING`**, so a double submit
  commits once. This is the same shape as the reimbursement submit and the RSVP
  submit, and it is the reason two browser tabs cannot produce two records.
- On success: snapshot country / name / institution / terms, stamp
  `submittedAt` + `submittedIp`, set `CONSENTED`.
- Reopenable by the organizer (`CONSENTED` back to `PENDING`, audited), same as
  reimbursement, because people mistype their own names.
- Rate limited per IP **and** per token, both logged on rejection.

### 6d. The organizer console

`/events/[eventId]/travel-grants`, reachable from the Abstracts area and from the
Setup hub, rendered only when the feature is enabled.

- Status tiles: invited, consented, declined, **plus "country not recorded"**,
  which is where D4's refusals surface. That tile is the whole reason D4 is safe:
  the people we deliberately did not email are visible rather than lost.
- Table: author, country, status, consented-at, link copy, resend, reopen.
- **Send invitations** action, for the retroactive case below.
- CSV export, audited via `recordExport` like every other PII export.

> **The retroactive case matters and is built in v1, not deferred.** An organizer
> who enables the toggle *after* abstracts have already come in reaches nobody,
> because the trigger is the confirmation email. The console's send action covers
> them. This is the same limitation the survey-gated certificate work shipped
> with and had to document as a footgun ("flag before surveys go out"); there is
> no reason to repeat it.

### 6e. Settings and content

- **Settings → Abstracts**: an Enable travel grant switch, sitting with
  Submissions / Session Proposals / Themes / Review Criteria. That tab already
  exists and is already `!isWebinar` gated.
- **Content → Abstracts**: two Tiptap panels, the email message and the form
  terms, beside the existing Guidelines and Presenter Agreement editors.

## 7. Tenancy, security and access

**Born tenancy-compliant**, per the standing rule for a new domain: org stamped
from the Event at create, every write inside `runWithTenant`, a flat policy in
`prisma/rls/travelgrant.sql`, an entry in `check-tenant-als.sh`, and fixtures plus
assertions in the isolation harness. All in the same change, not retrofitted.

**Console access = `denyReviewer`**, which resolves to SUPER_ADMIN, ADMIN and
ORGANIZER, matching Speaker Reimbursement. **MEMBER is deliberately excluded**
even though MEMBER is internal read-only staff, because this is a list of who has
asked to have their travel paid for, which is a financial-adjacent decision list
rather than an operational one. Stated explicitly so nobody later "fixes" it by
reaching for a close-enough predicate.

**The token is a credential.** Stored unique, never logged, and the roster route
is guarded like the RSVP roster is, for the same reason: the link impersonates
the author.

## 8. Tests

- `classifyResidency` truth table, including `"AE"`, `"ae"`, `" United Arab
  Emirates "`, `""`, `null`, and a country not in the list. **Mutation-verified**
  against the naive `!== "United Arab Emirates"` implementation.
- Block renders empty for UAE, for unknown, and when the feature is off.
- Block renders the CTA once and the confirmation note after consent.
- **A saved template lacking `{{travelGrantBlock}}` still receives it** (§6b).
- Second abstract from the same author does not mint a second row or a second
  token.
- Concurrent submit commits once (conditional claim).
- Token from event A refused against event B's slug.
- Console RBAC matrix, including MEMBER refused.
- Harness: cross-tenant read, write, and org re-home all blocked.

## 9. Build order

1. `classifyResidency` + tests. Pure, no dependencies, and it is the piece most
   likely to be wrong.
2. Migration + model + tenancy package (policy, gate entry, harness fixtures).
3. Settings toggle + the two Content fields, both reading through defensive
   readers that fail safe.
4. `buildTravelGrantBlock` + the wiring in `sendAbstractSubmissionConfirmation`,
   including the saved-template append.
5. Public form + routes.
6. Organizer console, including the retroactive send.
7. Docs: a section in the user guide so the help assistant can answer it, and a
   `CLAUDE.md` entry.

## 10. Deliberately NOT in v1

- **Award tracking.** The organizer decides who actually gets a grant offline.
  The enum has room for `AWARDED` / `REJECTED` but v1 does not implement a
  decision workflow, because the request was to capture consent.
- **Any financial capture.** No amounts, no bank details, no passport. Speaker
  Reimbursement already owns that, and duplicating it here would create two
  places to look for the same person's money.
- **Automatic reminders.** The console's send action is manual, matching the
  decision taken for RSVP.
- **Eligibility on anything other than the submitting author's country.**
  Co-authors carry an optional country and are not considered.
- **MCP tools.** A read-only `list_travel_grants` is an obvious fast-follow; it
  is not needed to make the feature work.

## 11. Open questions worth answering before the build starts

1. **Is "not a UAE resident" really the rule, or is it "not employed in the
   UAE"?** We match on the address country recorded at submitter registration.
   A UAE-resident doctor who registered with a home address abroad would be
   classified as overseas, and vice versa. The field is a proxy; the plan should
   say so out loud in the terms text so the author self-declares rather than
   relying on our inference alone. The required tick already does this, which is
   why D1's wording matters.
2. **Should the block also appear on the abstract acceptance email?** Today the
   trigger is submission. If most grants are decided after acceptance, the
   acceptance email is arguably the better moment, or the second moment.
3. **Does a declined or non-consenting author need chasing?** If yes, the console
   needs a "chase pending" action rather than only "send invitations".
