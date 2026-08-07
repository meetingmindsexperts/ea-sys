# Multiple surveys per event

**Status: PARKED.** Planned August 7, 2026, decisions locked, build deferred the
same day. Owner: "I think we might not need it." Agreed. Revisit when a real
tenant describes a real second survey; their description is what tells us
whether `allowMultiple` (§4, the only decision adding meaningful work) is needed
at all. Do not start without an explicit go-ahead.

**Why it was parked.** Nobody has asked for it. Three of thirty-five events have
a survey at all and the feature has collected two responses in its lifetime, so
a more configurable version of it optimises a cold path. There is no platform
instance yet, and the named next build is per-tenant Stripe / Zoom / AI keys
([PLATFORM_DECISIONS.md](PLATFORM_DECISIONS.md) item 7), which is a prerequisite
for onboarding anyone. Most "we need more surveys" turns out to be "we need more
questions", which today's model already does; the genuine need is when the
*audience* differs (exhibitors vs delegates) or the *timing* does (per-day), and
neither is on the table. And the restructure sits one field away from the CME
certificate trigger (§2), which is not a reason never to do it, but is a reason
not to do it for a hypothetical.

**The argument NOT to trust.** The first draft of this plan argued "this is the
cheapest moment the change will ever be", on the strength of a five-row backfill.
That does not hold up: a backfill is one `UPDATE` whether it touches 5 rows or
5,000. The only cost that genuinely grows is the blue-green nullable window in
§6, and that is solved by a two-deploy sequence whenever volume makes it matter.
Recorded here so the argument is not recycled as a reason to build.

**What the change is.** Today a survey is a set of columns on `Event`, so an
event structurally cannot have two. A second tenant plausibly needs several: a
day-1 poll and a day-2 evaluation, an exhibitor survey alongside the delegate
one, a per-track feedback form.

**Live state at planning time** (verified read-only against the prod copy):

| | |
|---|---|
| Events with a survey configured | 3 of 35 (10 / 10 / 3 questions) |
| Share links generated | 1 |
| `SurveyResponse` rows, all time | **2** |
| Registrations with `surveyCompletedAt` | 2 |
| Outstanding invite tokens | 2, both expired 2026-07-18 |
| Certificate templates with `autoIssueOnSurvey` | 4 |

Nothing is in flight. The backfill is five rows. This is the cheapest this
change will ever be.

---

## 1. Decisions (locked)

| # | Question | Decision |
|---|---|---|
| D1 | Which survey earns a certificate? | **One flagged survey per event.** `Survey.gatesCertificates`, at most one per event. Only that survey stamps `Registration.surveyCompletedAt` and writes the `survey-completed` tag. Today's single survey becomes it, so certificate behaviour is byte-identical. A per-template pointer (`CertificateTemplate.autoIssueSurveyId`) is the natural later refinement and is deliberately not in v1. |
| D2 | Can one person answer the same survey twice? | **Configurable per survey.** `Survey.allowMultiple`, default false. Default preserves today's one-response-per-person rule, scoped per survey. See §4 for the mechanics, which are the non-obvious part of this plan. |
| D3 | Does a non-gating survey mark the registrant? | **Optional per-survey tag.** Nullable `Survey.completionTag`, merged into `Attendee.tags` on submit. Nothing by default. Lets a tenant build an email cohort from "answered the day-2 poll" without going near the certificate trigger. |
| D4 | Public URL shape | **Unchanged.** `/e/{slug}/survey?token=` and `?share=`. The token itself identifies the survey (§3), so no new route and no change to any link already delivered. |

---

## 2. The coupling that makes this delicate

`Registration.surveyCompletedAt` is not a feedback flag.
[certificates/auto-issue.ts](../src/lib/certificates/auto-issue.ts) polls exactly
it and mints a serialized, audited CME certificate. That is the same coupling
behind the B1 blocker closed on August 7, 2026, whose lesson was: *when a field
becomes a credential trigger, re-audit every writer of that field.*

This change adds writers. D1 is what keeps that safe: the flag keeps its exact
current meaning ("the certificate-gating survey was completed") and only one
survey per event may set it. The consequence is that the entire credential path
is **zero-change**:

- `src/lib/certificates/auto-issue.ts`
- `src/lib/certificates/survey-thankyou-sweep.ts`
- `src/lib/bulk-email-audience.ts`
- the registration detail sheet, the speaker pages, my-details, the
  auto-issue analytics route, `registrations/types.ts`

Roughly nine of the twenty-eight survey-touching files never move, and none of
the money or credential paths do.

---

## 3. Schema

New table, born multi-tenant compliant (org scalar, no FK, indexed, per the
convention every Phase-2 domain sweep established):

```prisma
model Survey {
  id                String   @id @default(cuid())
  eventId           String
  /// Denormalized tenant key, backfilled 1-hop from Event. Backs the flat
  /// RLS policy in prisma/rls/survey.sql (platform-only).
  organizationId    String?

  name              String              // "Post-event evaluation", "Day 1 poll"
  config            Json                // the question array, unchanged shape
  introHtml         String?  @db.Text
  isActive          Boolean  @default(true)
  sortOrder         Int      @default(0)

  /// Real columns, replacing the Event.surveyShareLink JSON blob and its
  /// defensive parse. One share link per survey.
  shareToken        String?
  shareTokenExpires DateTime?

  /// D1. At most one per event, enforced in the write path (see below).
  /// A survey with allowMultiple = true may never set this.
  gatesCertificates Boolean  @default(false)
  /// D2. See §4.
  allowMultiple     Boolean  @default(false)
  /// D3. Merged into Attendee.tags on submit. Null = mark nothing.
  completionTag     String?

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  event             Event            @relation(fields: [eventId], references: [id], onDelete: Cascade)
  responses         SurveyResponse[]

  @@index([eventId, sortOrder])
  @@index([organizationId])
  @@index([shareToken])
}
```

`SurveyResponse` changes:

```prisma
  surveyId             String
  /// D2 dedup key. Equals registrationId on single-submission surveys, NULL
  /// on repeatable ones. See §4 for why this exists.
  dedupRegistrationId  String?

  @@unique([surveyId, dedupRegistrationId])
```

and loses the global `registrationId @unique`. `Registration.surveyResponse`
becomes `surveyResponses SurveyResponse[]`.

**"At most one gating survey per event" is enforced in the write path, not by a
partial unique index.** Prisma cannot represent partial indexes, and the
`migration-replay` CI job asserts `prisma migrate diff --exit-code` is clean
against `schema.prisma`, so a partial index would fail CI. The repo already hit
this once and swapped a partial index for a full composite unique for the same
reason. Setting `gatesCertificates` on survey B clears it on A inside the same
transaction, which is better UX than a 409 anyway. A DB `CHECK` for the
`gatesCertificates AND allowMultiple` combination is optional and must be
verified against the replay job before being added; the write-path refusal is
the requirement.

Session-scoped surveys ("rate this talk") would later need only a nullable
`Survey.sessionId`. Responses key on `surveyId`, so the response model would not
change. Worth preserving even though it is out of scope.

---

## 4. Repeatable surveys (D2), the fiddly part

`allowMultiple` lives on `Survey` and the uniqueness constraint lives on
`SurveyResponse`, and Postgres cannot reference another table in an index
predicate. Hence the denormalized `dedupRegistrationId`: the submit path writes
`registrationId` on a single-submission survey and `null` on a repeatable one.
Postgres treats NULLs as distinct, so:

- single-submission surveys keep a real DB race gate, and the existing P2002
  `survey:submit-race-dedup` branch survives untouched;
- repeatable surveys simply never collide.

Three behaviours branch on the flag:

1. **Token lifetime.** The finalizer deletes the invite token on submit today,
   which is a deliberate single-use property. A repeatable survey must keep the
   token alive until its TTL, otherwise the second submission is impossible.
   **This is a real relaxation of a security property**, scoped to surveys an
   organizer explicitly marks repeatable, and it must be stated in the builder
   UI next to the toggle rather than buried here.
2. **The already-completed short-circuit.** Currently keyed on
   `registration.surveyCompletedAt`. It becomes "a response exists for this
   (survey, registration)" and is skipped entirely for repeatable surveys.
3. **Reads.** The responses list and CSV export get several rows per person.
   That is correct, but the export consumer has to know: add a submission
   ordinal column. `aggregate.ts` needs no change, since it already operates
   over a list of responses and does not care who submitted them.

`gatesCertificates` and `allowMultiple` are mutually exclusive: a credential
trigger that can fire twice is the wrong shape by construction.

---

## 5. Invite tokens and bulk email

The `VerificationToken` identifier becomes `survey:{surveyId}:{regId}`. Without
that, minting an invite for survey B deletes the live token for survey A, since
the mint does a `deleteMany` on the identifier first. There are zero live tokens
(both outstanding ones expired 2026-07-18), so the format can change freely; a
legacy two-part parse is three lines and worth keeping for one release anyway.

Bulk email carries `filters.surveyId`, riding **inside** `filters` exactly like
`surveyExpiryDays` does, so persisted `ScheduledEmail` rows reconstruct it at
fire time with no new column and no worker change. Absent (a row queued before
this ships) resolves to the event's gating survey, preserving today's behaviour.

`precheckBulkEmailViability`'s "the event must actually have a survey built"
check becomes "the chosen survey exists, is active, and belongs to this event",
and fails synchronously at both enqueue doors as it does now.

---

## 6. Rollout

Additive and idempotent, one deploy:

1. Create `Survey`, plus `prisma/rls/survey.sql` extended with a Survey policy,
   harness fixtures and assertions, and `check-tenant-als.sh` entries. This is
   the born-compliant tenancy package a new domain ships with.
2. Backfill one `Survey` row per configured event (`gatesCertificates = true`,
   `allowMultiple = false`, copying `surveyConfig`, `surveyIntroHtml` and the
   share token). Three rows.
3. Add `SurveyResponse.surveyId` and `dedupRegistrationId`, backfill both (two
   rows), drop the global `registrationId` unique, add the composite.
4. **Leave `Event.surveyConfig`, `surveyIntroHtml` and `surveyShareLink` in
   place**, unread. Migrations are keep-don't-touch; a cleanup migration can
   come later once no old container can write.

**Known gap, accepted deliberately.** `surveyId` stays nullable, because during
the blue-green window the old container still writes rows without it and a NOT
NULL would fail those writes. For that window the dedup gate is weaker on a
feature with two lifetime responses. The alternative is a two-deploy sequence,
which is not worth it at this volume. Named here rather than hidden.

---

## 7. Work breakdown

Changes (roughly 19 files):

- **Core**: new `src/lib/survey/survey.ts` (load by event, resolve the gating
  survey, resolve by share token), `schema.ts` unchanged, `share-link.ts`
  reshaped onto the real columns.
- **Dashboard**: survey list page, per-survey builder, per-survey responses,
  export and share-link routes, and removal of `surveyConfig` /
  `surveyIntroHtml` from the event PUT.
- **Public**: `src/app/api/public/events/[slug]/survey/route.ts` (1007 lines:
  token parse with legacy fallback, share-token lookup, preview branch, the
  shared submit finalizer) and the public form page (835 lines).
- **Bulk email**: survey picker in the dialog, `filters.surveyId`, precheck.
- **Peripheral**: clone (clone N surveys, never the share tokens),
  `media-references` (intro HTML moves per-survey), setup and communications
  tiles, `event-visibility` if the restricted select needs it.

Zero-change, listed in §2.

Order: the schema, the public route and the builder have to land in one deploy,
because the public form must keep working throughout. Staged commits on one
branch, one deploy. Estimate: one to one and a half days including tests and the
tenancy package.

---

## 8. Deliberately not in v1

- Open and close windows per survey (`opensAt` / `closesAt`). Additive later.
- Session-scoped surveys. Schema does not preclude them (§3).
- Anonymous responses.
- New question types, conditional or branching logic.
- Cross-survey analytics.
- MCP tools. There are none today, so no client reconnect and no package bump.
- Per-template certificate gating (`CertificateTemplate.autoIssueSurveyId`).
  The natural next step after D1, but not in the same round as the restructure.
