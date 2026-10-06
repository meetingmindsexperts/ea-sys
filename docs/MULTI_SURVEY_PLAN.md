# Several surveys per event, one of them the certificate survey

**Status: BUILT, steps 1 to 5 (October 6, 2026).** First use: the webinar
end-of-session survey. Decisions in §13, the step-by-step build plan and what
was built in §14.

**Previous status: PLANNED, NOT BUILT.** Revived September 17, 2026 (owner: "scale the
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
| 2. Responded filter (O1) | **BUILT Oct 6, 2026.** Registrations list filter and bulk email audience filter, with the dialog count matching the send (list rows carry the survey ids each registration answered). | 0.5 to 1 day |
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

## 13. Go-ahead, October 6, 2026: Phase 1 plus the webinar survey

Owner request: "once the webinar is ended by host, attendee pages should pop up
a survey for the user to submit … recorded and ready to be exported later." The
owner chose to build several surveys first rather than reuse the event's single
survey, so a webinar's feedback survey can sit beside a CME survey.

| # | Question | Decision |
|---|---|---|
| O2 | Move the certificate flag after responses? | **Superseded the same day by L1: the flag never moves at all.** |
| L1 | How protected is the CME survey? | **Reserved and locked** (owner: "cme survey should be unaffected by all means, even if you have to keep it reserved or lock it"). Each event has at most one certificate survey, in a reserved slot written only by `saveCertificateSurvey()` (route `PUT /surveys/certificate`) and the old Event-column path. No other write sets, moves or clears the flag: extra surveys are always ordinary, the update input has no flag, and the routes refuse a request that sends one (`.strict()`). The certificate survey cannot be deleted from the new screens even with no answers; it can be edited and opened or closed as today. Its link, gates, the certificate worker and the thank-you sweep are unchanged. |
| L3 | Where does the CME survey's content come from during the build? | **The Event columns, this release** (review of step 2). The migration runs at push time, about 10 minutes before the container swap, while the old code still saves CME edits only to `Event.surveyConfig / surveyIntroHtml / surveyThankYouHtml`. So the personal link, the builder and the reports read the CME survey's questions, messages and open/closed state from those columns (`overlayCertificateFromEvent`), which the new code mirrors on every save. The link behaves exactly as before by construction. Creating the CME survey takes a row lock on its event (`SELECT … FOR UPDATE`), so two first saves cannot make two; a partial unique index would say it in the database but Prisma cannot represent one and CI's schema check would refuse it. The cleanup release that drops the columns must first re-run the catch-up copy, then remove the overlay. |
| L2 | Can an extra survey block the CME survey? | **No, by ordering.** Until step 3 drops `SurveyResponse.registrationId @unique`, a person can hold one response in total, so answering an extra survey would block their CME survey. Therefore no extra survey is answerable before step 3 ships: the personal link opens only the certificate survey in step 2, and the webinar popup (step 4) must not ship before step 3. |
| O4 | Thank-you email for non-certificate surveys? | **No.** On-page thank-you only. |
| W1 | Which survey pops up when a webinar ends? | **Picked in the Webinar Console** ("End-of-webinar survey"), stored as `settings.webinar.endSurveyId`. The same survey's personal link goes into the webinar thank-you email. |
| W2 | How firm is the popup? | **Closable, comes back.** It opens when the host ends the webinar or the room closes, has a "Later" button, leaves a banner on the page and reopens on the next visit until submitted. |
| W3 | People who left early? | **Yes.** The webinar thank-you email (end + 30 min) carries the survey link. |
| Scope | This round | Phase 1 and the webinar survey. O1 (responded filter), O3 and O5 (session ratings, repeatable) stay for later. |

**Identity on the webinar page.** The attendee page already requires a signed-in
registrant, so the popup submits against the viewer's own registration with no
token. Both doors (the token link and the signed-in page) go through one submit
function, because whichever survey is the certificate survey stamps
`surveyCompletedAt`, and every writer of that column is on the credential path
(§3).

## 14. Build plan (October 6, 2026)

Five steps, each its own commit and deploy, each with tests written alongside,
lint and types, the CI gate scripts, a visible local browser check of every page
it touches, and an independent review before push. Steps 1 to 3 are Phase 1;
steps 4 and 5 are the webinar survey. Nothing changes for attendees until step 3.

### Where surveys live today (everything that changes)

| Area | Files |
|---|---|
| Schema | `Event.surveyConfig`, `surveyIntroHtml`, `surveyThankYouHtml` (`prisma/models/core.prisma`); `SurveyResponse` (`prisma/models/engagement.prisma`), `registrationId @unique`; `Registration.surveyResponse` (`prisma/models/registrations.prisma`) |
| Tenancy | `prisma/rls/survey.sql`; `scripts/check-tenant-als.sh` (survey routes listed at lines 69, 148, 172; `surveyResponse` in `SWEPT_MODELS`) |
| Builder | `src/app/(dashboard)/events/[eventId]/survey/page.tsx`, saving through the event PUT (`src/app/api/events/[eventId]/route.ts`, `surveyConfig` / intro / thank-you fields) |
| Results | `survey/responses/page.tsx`; `api/events/[eventId]/survey/responses/route.ts` and `/export/route.ts` |
| Public form | `src/app/e/[slug]/survey/page.tsx`; `src/app/api/public/events/[slug]/survey/route.ts` (token, gates, the one submit transaction) |
| Sending | `src/lib/bulk-email.ts` (token mint `survey:{registrationId}` near line 1991, `ensurePersonalSurveyLink`, precheck); the Survey Invitation option in `registrations/registration-detail-sheet.tsx` (offered only when `surveyConfig` exists) |
| Reset | `api/events/[eventId]/registrations/[registrationId]/survey/route.ts`, `components/survey/reset-survey-dialog.tsx` |
| Other readers | clone (`api/events/[eventId]/clone/route.ts` copies the three columns), `src/lib/media-references.ts` (intro and thank-you HTML), Setup hub status (`setup/page.tsx` reads `surveyConfig`) |
| Untouched by design | `src/lib/certificates/auto-issue.ts`, `survey-thankyou-sweep.ts`, `bulk-email-audience.ts` (they read `Registration.surveyCompletedAt`, which keeps its single writer) |

### Step 1: the table and the copy (no behaviour change)

- Additive, idempotent migration (hand-authored SQL, applied with
  `npm run db:migrate`; never `migrate dev`, never a shadow database):
  `SurveyResponseMode` enum (`ONCE` only), the `Survey` table (§4), and on
  `SurveyResponse` the nullable `surveyId` and `dedupKey` plus
  `@@index([registrationId])`.
- Backfill in the same migration: one `Survey` per event that has a
  `surveyConfig`, named "Post-event survey", `gatesCertificates = true`,
  `responseMode = ONCE`, copying the three columns; then each response's
  `surveyId` (its event's survey) and `dedupKey = registrationId`. Production
  holds 4 configured surveys and 2 responses (re-count with `npm run prod:psql`
  before writing the migration).
- Keep `registrationId @unique` in this step. Readers still use the old columns.
- Tenancy: RLS policy for `Survey` in `prisma/rls/survey.sql`, harness fixtures
  and assertions, `survey` added to `SWEPT_MODELS`.
- Tests: migration replays clean and twice (idempotent); backfill counts.

### Step 2: surveys as their own thing, behind the same screens

- A survey service (`src/services/survey-service.ts`): list, create, update,
  delete, set the certificate survey (clears the previous one in the same
  transaction; refused 409 `CERT_SURVEY_HAS_RESPONSES` once it has responses,
  O2; a certificate survey must be `ONCE`), and **one `submitSurveyResponse()`**
  used by every door. It writes the response with `dedupKey`, and only when the
  survey `gatesCertificates` stamps `surveyCompletedAt` and adds the
  `survey-completed` tag.
- Routes: `api/events/[eventId]/surveys` (list, create) and `/surveys/[surveyId]`
  (read, update, delete), behind the existing survey permission keys; responses
  and CSV export take a `surveyId`.
- Dashboard: the Survey page becomes a list of surveys (name, active, certificate
  badge, response count) with a per-survey builder reusing today's question
  editor, intro and thank-you; responses page per survey.
- Event PUT keeps accepting the old survey fields for one release and writes them
  through to the certificate survey, so a container still on the old build and
  any old client keep working during the blue/green swap.
- Clone copies surveys (never responses or tokens); media references read
  `Survey.introHtml` / `thankYouHtml`; Setup hub status counts surveys.
- **Catch-up in step 2's migration** (review of step 1): re-run the step 1 copy
  as `ON CONFLICT ("id") DO UPDATE SET config, introHtml, thankYouHtml,
  updatedAt` (same "real question list" filter), so a survey built OR edited on
  the old screens between the two deploys is current, then re-run the response
  link (`surveyId IS NULL`), which catches responses submitted in between.
- Tests: the §8 list, items 1, 2, 5; service tests for O2.

### Step 3: links and sending per survey

- Token identifier `survey:{surveyId}:{registrationId}`; a legacy two-part token
  resolves to the certificate survey (logs `survey:legacy-token`).
- Public route resolves the survey from the token, adds the `isActive` gate
  ("This survey is closed"), submits through `submitSurveyResponse()`.
- Before the composite unique: backfill `dedupKey = registrationId` (and
  `surveyId`) on any response written by the old code during the step 2 swap
  window, which carries neither.
- Drop `registrationId @unique`, add `@@unique([surveyId, dedupKey])` and
  `@@index([registrationId])` in the same migration (step 1 left the index out
  because the unique already covers it; the accepted swap gap in §7 applies).
- Survey Invitation send: a survey picker riding as `filters.surveyId` (queued
  sends without one go to the certificate survey), `{{surveyName}}`, precheck on
  the chosen survey at both enqueue doors and at fire time.
- Reset is per survey; resetting the certificate survey also clears
  `surveyCompletedAt` as today.
- Tests: §8 items 3, 4, 6; the existing public survey route tests pass with the
  survey lookup added to their mocks.

**Step 3 as built (Oct 6, 2026):** migration `20261006160000` backfills
`dedupKey`, adds `@@unique([surveyId, dedupKey])` and the `registrationId`
index, then drops the old unique (a gate exists at every moment);
`EXTRA_SURVEYS_ANSWERABLE` set to true in the same change. Extra-survey links are
`survey:{surveyId}:{registrationId}` (`surveyTokenIdentifier`). **The CME
survey's link stays two-part (`survey:{registrationId}`), byte-identical to
every link already sent and readable by the previous release on a rollback**
(review of step 3); a CME re-send revokes both forms. A two-part link, or one
naming the CME survey, opens the CME survey exactly as before
(`resolveTokenSurvey`); a closed extra survey answers 410 "closed". Survey
Invitation sends carry `filters.surveyId` (picker in the bulk dialog and the
single send), `{{surveyName}}` is registered. Reset is per survey: the CME
reset clears completion as before but deletes only the CME answer; an extra
survey's reset deletes only that answer. **Deferred:** the saved-template
picker for survey sends (not needed for the webinar survey).

### Step 4: the end-of-webinar popup

- Webinar Console, Setup tab: "End-of-webinar survey" dropdown listing the
  event's active surveys, saved as `settings.webinar.endSurveyId` (validated to
  belong to the event; cleared if the survey is deleted).
- Public webinar session route (signed-in registrant only, the same identity the
  page already requires): `GET` returns the survey's questions and whether this
  registration already answered; `POST` submits through `submitSurveyResponse()`.
  Rate limited, every refusal logged, no token involved.
- Attendee page: the popup opens when the Zoom embed reports the host ended the
  meeting, or when the room closes (lobby poll sees open to closed, or
  `ended`). "Later" closes it and leaves a banner; it reopens on the next visit
  until submitted. Never shown to someone who already answered, never during the
  live session.
- Tests: route tests for identity (another person's registration, cancelled,
  not registered, survey inactive, already answered), the popup trigger rules as
  a pure helper.

**Step 4 as built (Oct 6, 2026):** `settings.webinar.endSurveyId` picked on
the console's Setup tab; `…/sessions/[sessionId]/end-survey` (GET survey +
answered, POST submit through `submitSurveyResponse`); the popup
(`EndOfWebinarSurvey`) and the shared `QuestionCard`. Rules from its review:
- **Never the CME survey** (L1): from the popup any registrant, attended or
  not, could complete it and be issued a certificate (auto-issue keys on
  `surveyCompletedAt` alone). The picker leaves it out, the webinar PUT
  refuses it (and closed surveys), and the route refuses it again.
- **A pause is not the end:** the room route marks the session COMPLETED on
  close, so a closed room counts as the end only after the scheduled end
  (`isWebinarOver`); the host ending it in Zoom counts at once. The route also
  refuses answers until the session is COMPLETED or past its end and not LIVE.
- **Known limits:** once an event is marked COMPLETED its attendee page stops
  loading (detail, lobby, zoom-join and recording filter it out), so the popup
  lasts only until then; step 5's email link covers later answers. **Owner
  decision, Oct 6, 2026: leave as is.** Completed means closed; organisers keep
  a webinar Published for as long as they want its page (replay, survey,
  handouts) open. A host who
  ends in Zoom and restarts leaves the banner up until the viewer clicks
  Rejoin.

### Step 5: the link in the thank-you email

- When `endSurveyId` is set, the webinar thank-you send (end + 30 min, through
  `executeBulkEmail`) mints each recipient's personal link for that survey, the
  same mint the Survey Invitation uses, and fills `{{surveyLink}}`.
- The default webinar thank-you template gains a survey block that renders only
  when a link exists (a template without the variable gets the button added, the
  way `ensurePersonalSurveyLink` does for invitations). People who already
  answered on the page get no link.
- Tests: link present when set, absent when not set or already answered.

**Step 5 as built (Oct 6, 2026):** [src/lib/webinar-thank-you-survey.ts](../src/lib/webinar-thank-you-survey.ts)
resolves the survey once per send and reads who already answered in one
query; `executeBulkEmail` mints `survey:{surveyId}:{regId}` per recipient
(7-day link, the invitation default) and fills `{{surveyBlock}}` /
`{{surveyBlockText}}` / `{{surveyLink}}` / `{{surveyName}}`, always set so a
template carrying them never trips the unresolved-token guard. Rules:
- **Never the CME survey**, refused again here; a missing, closed or empty
  survey sends the thank-you without the block and logs
  `webinar-thank-you:survey-skipped`. The thank-you is never blocked by it.
- Minting replaces only this survey's link, so the person's CME link stays
  alive. A later Survey Invitation for the same extra survey replaces the
  thank-you's link, as two invitations would.
- A saved thank-you without `{{surveyBlock}}` or `{{surveyLink}}` gets the
  block before `{{organizerSignature}}` (else at the end), only for people who
  have a link; everyone else's email is the template as saved.
- **The organiser's switch** (owner, Oct 6, 2026): "Also send the link in the
  thank-you email" on the console card (`settings.webinar.thankYouSurveyLink`;
  unset means on, `false` sends the thank-you without it, and the survey is not
  even read).
- Tests: `bulk-email-webinar-thank-you-survey.test.ts` (the answered and CME
  guards mutation-checked, the switch, per-part placement).

**Full review of steps 1 to 5 (Oct 6, 2026):** no HIGH or MED; the CME survey
unaffected on every path. LOWs:
- Fixed: deleting a survey clears it as a webinar's `endSurveyId` (one
  `#-` statement, so other settings are never overwritten); the template
  placement checks the HTML and text parts separately (a text-only token no
  longer doubled the link); the preview blanks `{{surveyLink}}` too when there
  is nothing to link.
- Documented: do not roll back below step 3 once extra surveys have answers
  (docs/ROLLBACK.md); a re-sent thank-you replaces the earlier thank-you link
  (the raw token is never stored, so it cannot be reused).
- Checked, no fix needed (Oct 6, 2026): someone holding two registrations
  linked to one account could answer twice (page, then the thank-you on the
  other registration). Production has **zero** people with two non-cancelled
  registrations on one event, and only 2 of 89 speaker companions carry a
  `userId`. Revisit only if that changes: exclude by attendee email. And before the platform instance launches,
  check that the worker's thank-you send reads the Survey row inside a tenant
  context (on master tenant scoping is a passthrough).

### Phase 2 as built (Oct 6, 2026): the responded filter

- One rule, `src/lib/survey/responded-filter.ts`: the Registrations page
  filter and both bulk email counts (Registrations, Communications) use
  `matchesSurveyResponded` on each row's `answeredSurveyIds`; the send uses the
  equivalent Prisma where (`surveyResponses: some | none` of
  `responseWhereForSurvey`, so the CME survey counts its legacy rows like its
  results do). Checked locally: 54 not answered / 2 answered on the page, in
  the dialog and in the send's own query.
- The registrations list reads the event's response rows once per request.
- Bulk email `filters.surveyResponded { surveyId, answered: yes | no }`,
  registrations only, the survey must be this event's (refused at enqueue).
  Applied at fire time, so a scheduled chase reaches whoever still has not
  answered then. Scheduled sends cannot edit filters, so it is kept as saved.
- UI: a "Survey" dropdown (Answered / Not answered for each survey) in the
  Registrations filter bar and in the bulk email dialog's filters, for people
  who can read surveys; the page's choice seeds the dialog.

### Effort and order

| Step | Effort |
|---|---|
| 1. Table and copy | 0.5 day |
| 2. Surveys service, routes, builder, results, clone | 1.5 days |
| 3. Links and sending | 0.5 to 1 day |
| 4. End-of-webinar popup | 1 day |
| 5. Thank-you email link | 0.5 day |

About 4 to 4.5 days in total. Steps 1 to 3 are worth shipping on their own;
step 4 needs step 2's single submit function, step 5 needs step 3's mint.

### Risks

- **Credential path.** Any mistake that lets a non-certificate survey stamp
  `surveyCompletedAt` would issue CME certificates. Guarded by the single submit
  function and the mutation-verified test in §8.
- **Blue/green window.** Old and new containers run side by side for minutes;
  step 2's write-through and step 3's legacy token keep both working.
- **Live events.** Each step deploys separately and is checked on a test event
  before the next starts.
