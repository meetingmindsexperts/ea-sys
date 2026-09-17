# Several surveys per event, one of them the certificate survey

**Status: PLANNED, NOT BUILT.** Revived September 17, 2026 (owner: "scale the
surveys without affecting the CME survey, same personalized links but for
something else"). First planned August 7, 2026 and parked the same day; this
revision replaces that plan, because the shareable survey link it designed
around was retired on September 17 and the owner has since named real uses.
Do not start building without an explicit go-ahead on §9.

**Who this is for.** The owner, to confirm the open decisions in §9, and
whoever builds it.

---

## 1. What changes, in one paragraph

Today a survey is four columns on `Event` (`surveyConfig`, `surveyIntroHtml`,
`surveyThankYouHtml`, and the retired `surveyShareLink`), so an event can hold
exactly one. The plan moves surveys into their own table so an event can run
several: a pre-event needs survey, a faculty feedback survey, session ratings, an
exhibitor survey. Exactly one survey per event is the **certificate survey**, and
only it can mark a registration as having completed "the survey", which is what
mints CME certificates. Every other survey stores its answers and nothing else.
Links stay personal (`/e/{slug}/survey?token=…`, the `{{surveyLink}}` variable),
sent from Communications as today.

## 2. Decisions

Locked in conversation on September 17, 2026:

| # | Question | Decision |
|---|---|---|
| D1 | What are the other surveys for? | All four: pre-event needs survey, speaker / faculty feedback, per-session rating, sponsor / exhibitor feedback. |
| D2 | Who receives personal links? | **Registrations only**, as today. Speakers answer through their companion registration, exhibitors through theirs. No new token kind. |
| D3 | Can one person answer a survey more than once? | **Configurable per survey** (§5). |
| D4 | Which survey earns a certificate? | **One certificate survey per event** (carried from the August plan). Only it stamps `Registration.surveyCompletedAt` and adds the `survey-completed` tag. |
| D5 | Link and variable | Unchanged: `/e/{slug}/survey?token=` and `{{surveyLink}}`. The token identifies the survey as well as the person. |

Still open, with a recommendation each: §9.

## 3. Why the certificate survey is not affected

`Registration.surveyCompletedAt` is not a feedback flag. The certificate worker
([auto-issue.ts](../src/lib/certificates/auto-issue.ts)) sweeps exactly that
column and mints a serialized, audited CME certificate, and the thank-you sweep
([survey-thankyou-sweep.ts](../src/lib/certificates/survey-thankyou-sweep.ts))
emails that certificate. The August 7 blocker (B1) taught the rule: when a field
triggers a credential, every writer of that field is part of the credential
path.

This plan adds no writer. The one submit path that sets the column today keeps
setting it, and only when the survey being answered is the certificate survey. A
non-certificate survey writes a `SurveyResponse` row and returns. So these stay
**zero-change**:

- `src/lib/certificates/auto-issue.ts` and its analytics route
- `src/lib/certificates/survey-thankyou-sweep.ts`
- `src/lib/bulk-email-audience.ts` (cancelled registrants stay excluded)
- the registration detail sheet, both speaker surfaces, My Details and
  `registrations/types.ts`, which read `surveyCompletedAt`, not the response
  relation (checked: nothing in `src/` reads `registration.surveyResponse`)

The tests in §8 pin this in both directions, and two of them are
mutation-verified.

## 4. Schema

New table, born tenancy-compliant (org scalar, index, RLS policy in the same
change):

```prisma
enum SurveyResponseMode {
  ONCE              // one response per registration (Phase 1)
  ONCE_PER_SESSION  // one per registration per session (Phase 3)
  REPEATABLE        // any number until the link expires (Phase 4)
}

model Survey {
  id                String   @id @default(cuid())
  eventId           String
  /// Denormalized tenant key, stamped from the event at create.
  organizationId    String?

  name              String               // "Pre-event needs survey"
  config            Json                 // the question array, today's shape
  introHtml         String?  @db.Text
  thankYouHtml      String?  @db.Text
  isActive          Boolean  @default(true) // closed = the link says so
  sortOrder         Int      @default(0)

  /// D4. At most one per event, enforced in the write path (see below).
  gatesCertificates Boolean  @default(false)
  responseMode      SurveyResponseMode @default(ONCE)
  /// Phase 3 only. Empty = every program session of the event.
  sessionIds        String[] @default([])

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  event             Event            @relation(fields: [eventId], references: [id], onDelete: Cascade)
  responses         SurveyResponse[]

  @@index([eventId, sortOrder])
  @@index([organizationId])
}
```

`SurveyResponse` gains three columns and loses its global unique:

```prisma
  surveyId     String?   // nullable through the blue-green window, §7
  /// The duplicate gate. ONCE: registrationId. ONCE_PER_SESSION:
  /// "registrationId:sessionId". REPEATABLE: NULL, which Postgres treats as
  /// distinct, so repeats never collide while the other modes keep a real
  /// database race gate.
  dedupKey     String?
  sessionId    String?   // Phase 3, FK SetNull, plus a sessionName snapshot

  @@unique([surveyId, dedupKey])
  @@index([registrationId])
```

`registrationId @unique` is dropped and `Registration.surveyResponse` becomes
`surveyResponses SurveyResponse[]`.

**One certificate survey per event is enforced in the write path, not by a
partial unique index.** Prisma cannot represent a partial index and the
`migration-replay` CI job fails on any difference from `schema.prisma` (the
repo hit this once already). Marking survey B clears survey A in the same
transaction, and a certificate survey must use `ONCE` (a credential trigger that
can fire twice is the wrong shape).

## 5. How the modes behave

| | ONCE | ONCE_PER_SESSION | REPEATABLE |
|---|---|---|---|
| Used for | needs survey, faculty feedback, exhibitor feedback, the certificate survey | session ratings | nothing named yet |
| Personal link after submit | deleted (today's single-use rule) | kept until it expires | kept until it expires |
| Already answered | "already completed" page | that session shows as rated; others stay open | always open |
| Duplicate gate | `dedupKey = registrationId` | `dedupKey = registrationId:sessionId` | none |
| Can be the certificate survey | yes | no | no |

**Keeping the link alive is a real relaxation of a security property**, limited
to surveys an organizer switches out of ONCE. It lets the holder of the email add
more answers (ratings for other sessions, or repeats); it never lets them change
an answer already given. The builder states this next to the mode setting.

**Session ratings (Phase 3).** One survey covers many sessions. The person's link
opens a page listing the sessions (program sessions only: no breaks, nothing
cancelled, ordered by time), already-rated ones ticked. They pick a session,
answer the same questions, submit, and can come back for the next one until the
link expires. There is no per-session attendance data for conferences, so the
list is every program session, or the ones the organizer ticked (`sessionIds`).
The responses page shows each session's results separately and the CSV carries a
session column. The response keeps the session name as a snapshot so a deleted
session's ratings still read.

## 6. Sending: `{{surveyLink}}` and templates

- **The token names the survey.** The identifier becomes
  `survey:{surveyId}:{registrationId}`. Minting survey B's link then leaves the
  person's survey A link alive; with today's `survey:{registrationId}` the mint's
  `deleteMany` would kill it. A legacy two-part identifier still resolves, to the
  certificate survey, and logs `survey:legacy-token` at info. Production holds one
  live legacy token today and sends made before the deploy can mint more with up
  to 365 days of life, so the fallback stays (it is three lines).
- **The send picks the survey.** The Survey Invitation dialog gets a survey
  picker. The choice rides as `filters.surveyId`, inside `filters` like
  `surveyExpiryDays`, so scheduled sends rebuild it with no new column and no
  worker change. A queued send with no `surveyId` (created before this ships)
  goes to the certificate survey, which is today's behaviour.
- **The send can use a saved template.** The default Survey Invitation wording
  says "Thank you for attending", which is wrong for a pre-event needs survey, and
  a saved custom template sent as a normal template is refused today because no
  link is minted for it. The survey send gains the RSVP console's pattern: pick
  the Survey Invitation template or one of your saved templates; a deactivated
  saved template is refused rather than swapped. `{{surveyName}}` joins the
  variables and the preview samples.
- **The repair stays.** A template with no `{{surveyLink}}`, or a pasted retired
  share URL, still gets the person's own link (`ensurePersonalSurveyLink`,
  shipped September 17). Preview equals send.
- **Precheck.** "The event has a survey built" becomes "the chosen survey exists,
  is active, has questions and belongs to this event", checked at both enqueue
  doors and at fire time. Cancelled registrations stay excluded for every survey.
- **Thank-you email.** Only the certificate survey sends one (the existing
  sweep). Other surveys show their on-page thank-you only (§9, O4).

## 7. Rollout

Additive and idempotent, one deploy per phase. Phase 1's schema, public route and
builder land together because the public form must keep working throughout.

1. Create `SurveyResponseMode` (values added in the phase that builds them) and
   `Survey`; extend `prisma/rls/survey.sql` with a Survey policy, add harness
   fixtures and assertions, and add the new routes to `check-tenant-als.sh`.
2. Backfill one `Survey` per event with a configured survey (four on production):
   `gatesCertificates = true`, `responseMode = ONCE`, name "Post-event survey",
   copying `surveyConfig`, `surveyIntroHtml` and `surveyThankYouHtml`.
3. Add `SurveyResponse.surveyId` and `dedupKey`, backfill both (two rows), drop
   the `registrationId` unique, add the composite.
4. Leave the four `Event` survey columns in place and unread. Dropping a column
   is not blue/green safe; a cleanup migration comes later.

**Accepted gap.** During the swap the old container writes responses with no
`surveyId` and no longer has the `registrationId` unique behind it, so for a few
minutes a double submit could store two rows. Its own `surveyCompletedAt` check
still runs first. At two responses in the feature's lifetime this is not worth a
two-deploy sequence; recorded rather than hidden.

## 8. Tests that pin the certificate path

1. Submitting a non-certificate survey writes the response and never sets
   `surveyCompletedAt`, never adds `survey-completed`, and is never a thank-you
   sweep candidate. **Mutation-verified** (removing the certificate check must
   fail it).
2. Submitting the certificate survey behaves as today: the existing public
   survey route tests pass with only the survey lookup added to their mocks.
3. A legacy `survey:{registrationId}` token opens the certificate survey.
4. Minting survey B's link leaves survey A's live link intact.
   **Mutation-verified** (reverting to the two-part identifier must fail it).
5. Only one certificate survey per event; marking another clears the first.
6. A scheduled send with no `filters.surveyId` resolves to the certificate survey.
7. Phase 3: a second rating for the same session is refused, a rating for another
   session is accepted, and the link survives the submit.

## 9. Open decisions (recommendation first)

| # | Question | Recommendation | Why |
|---|---|---|---|
| O1 | How do we record "answered survey X" for filtering? | **Derive it from the response rows: a "Responded / Not responded to <survey>" filter on the registrations list and in the bulk email dialog. No new field.** | The response row already is the fact. A JSON yes/no on the registration is a second copy that must be written in the same place and can drift from it (and JSON is slow to filter). A tag is an organizer-editable label: it can be deleted or renamed, and tags also route certificate sends, so a survey tag sits one typo away from certificate eligibility. The filter answers the real question ("chase who hasn't answered") with nothing to keep in sync. Tags stay available by hand for anyone who wants a cohort in other tools. |
| O2 | Can the certificate flag move to another survey after the certificate survey has responses? | **No, refuse it (409) once it has responses.** | People already stamped keep `surveyCompletedAt`, so moving the flag would mix two surveys under one credential. Before any response, moving is free. |
| O3 | Session ratings: which sessions appear? | **Every program session by default; the organizer can narrow the list.** | No attendance data exists to do better, and narrowing covers "only rate day 2". |
| O4 | Do non-certificate surveys send a thank-you email? | **No, on-page thank-you only.** | The existing email exists to carry the certificate; a second thank-you email per survey is noise and a new sender to maintain. |
| O5 | Build REPEATABLE now? | **Last, as Phase 4.** | None of the four named uses needs it (session ratings are ONCE_PER_SESSION). It stays in the plan per D3 and costs about half a day when a use appears. |

## 10. Phases and effort

| Phase | What ships | Effort |
|---|---|---|
| 1. Several surveys | `Survey` table and backfill, surveys list plus per-survey builder (questions, intro, thank-you, active, certificate flag), public route by token, legacy token fallback, survey picker and saved-template picker on the send, `{{surveyName}}`, per-survey responses and CSV, clone copies surveys (never responses or tokens), media references, tenancy package. ONCE only. | 2.5 days |
| 2. Responded filter (O1) | Registrations list filter and bulk email audience filter, with the dialog count matching the send (list rows carry the survey ids each registration answered). | 0.5 to 1 day |
| 3. Session ratings | ONCE_PER_SESSION: session picker on the public page, session column and per-session results, session list setting. | 1 to 1.5 days |
| 4. Repeatable | REPEATABLE mode and the ordinal column in the CSV. | 0.5 day |

About 4.5 to 5.5 days for all four, including tests, a local browser pass per
phase, and docs. Phase 1 alone gives the needs survey, faculty feedback and
exhibitor feedback.

## 11. Cost and the alternative

**Performance.** Surveys are a cold path. The heaviest realistic case is session
ratings: 50 sessions times 500 people is 25,000 rows for one survey, which the
in-memory aggregation and CSV already handle at that size. The responded filter
is one indexed `EXISTS` per registration; the registrations list gains one small
relation select. No worker job, no new cron.

**Not building it.** A Google or Microsoft Form link in a Custom bulk email with
`{{firstName}}` works today. It loses: answers tied to the registration (so no
"chase who hasn't answered"), one answer per person, the event's branding, and
keeping attendee data inside EA-SYS, which the posture document given to EHS
relies on.

**Practical notes for the named uses.**

- Faculty feedback reaches speakers through companion registrations, which cloned
  events do not create (ROADMAP "Event clone leaves speakers without companions").
  Run the companion backfill for such an event before sending.
- Exhibitor feedback reaches exhibitors who hold a registration; pick them by
  badge type, tag or sponsor in the send dialog.

## 12. Not in this plan

- Anonymous surveys and links shared outside the person's email (the shareable
  link was retired on September 17 for good reason).
- Opening and closing times per survey (`isActive` covers closing by hand).
- New question types (multi-select, 0 to 10 scale, matrix) and branching logic.
- A "Rate this session" button on the public session page.
- Cross-survey reports and MCP tools (none exist today, so no client reconnect).
- Per-certificate-template survey choice (`CertificateTemplate.autoIssueSurveyId`).
