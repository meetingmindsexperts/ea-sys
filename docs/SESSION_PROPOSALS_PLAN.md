# Session Proposals — plan of record (July 30, 2026)

> Owner request: "something like abstract submission but for **session proposals** — same
> like abstracts it has its own themes, but **no reviewer, no accepted/rejected** (may need
> it later, not now)."
>
> Status: **v1 IN BUILD** (owner: "plan, then build v1 now"). This doc is the blueprint +
> decision record; update it when v2 (review workflow / convert-to-session) starts.

---

## 1. Owner decisions (locked July 30, 2026)

| Decision | Choice |
|---|---|
| Access model | **Account-based like abstracts** — proposer registers a SUBMITTER account (existing `/e/[slug]/abstract/register` flow), submits + edits from the dashboard. No token links. |
| Organizer v1 scope | **List / view / export only.** No review, no accept/reject, no convert-to-session. |
| Fields | **Core only** — title, description, theme, proposed format, expected duration. No proposed-speakers block. |
| Timing | Plan doc + **build v1 immediately**. |

## 2. What v1 is

A per-event **Session Proposals** inbox mirroring the abstracts-submission shape minus all
review machinery:

- **Proposers** (SUBMITTER accounts, same registration as abstracts — one login covers both)
  submit a session idea: title, description (300-word cap? — no; proposals are free-length,
  description is `@db.Text`), theme (from the event's own proposal-theme list), proposed
  format, expected duration. Draft → Submit; **after submit the proposal is locked to the
  author** (abstracts' `SUBMITTED_LOCKED` rule, same July-2 rationale — changes go through
  the organizer).
- **Organizers** see the full list (status/theme visible, search, CSV export with
  `recordExport` audit), read proposals in a detail sheet, manage the theme list, and can
  mark a proposal WITHDRAWN. That's all — deliberately an inbox, not a workflow.

## 3. Data model (additive + idempotent migration)

```prisma
enum SessionProposalStatus {
  DRAFT
  SUBMITTED
  WITHDRAWN
  // v2 room (additive enum values later): UNDER_REVIEW, ACCEPTED, REJECTED
}

model SessionProposal {
  id              String                @id @default(cuid())
  eventId         String
  organizationId  String?               // denormalized tenant key, stamped at create
                                        // (born multi-tenant-ready per the Phase-2 convention;
                                        // app-level where-scoping is defence #1, RLS later)
  speakerId       String                // the proposer's Speaker facet (SUBMITTER linkage)
  title           String
  description     String                @db.Text
  themeId         String?
  proposedFormat  SessionType?          // program kinds only (SESSION/WORKSHOP/SYMPOSIUM),
                                        // validated in the route via SESSION_TYPE_KIND —
                                        // reusing the enum keeps v2 convert-to-session free
  durationMinutes Int?
  status          SessionProposalStatus @default(SUBMITTED)
  submittedAt     DateTime?
  createdAt / updatedAt

  event   Event                 @relation(onDelete: Cascade)
  speaker Speaker               @relation(onDelete: Cascade)
  theme   SessionProposalTheme? @relation(onDelete: SetNull)

  @@index([eventId, status])
  @@index([organizationId])
  @@index([speakerId])
}

model SessionProposalTheme {  // mirrors AbstractTheme exactly
  id / eventId / organizationId? / name / sortOrder / timestamps
  @@unique([eventId, name])
  @@index([eventId])
}
```

**Deliberately separate from `Abstract`** (no `kind` discriminator): Abstract carries review
machinery (reviewers, submissions, criteria, decision emails) that proposals must not
inherit, and the two lists diverge in every surface. Themes are likewise separate tables —
"its own themes" was explicit.

## 4. RBAC (mirrors abstracts, with one improvement)

- **Middleware** ([src/proxy.ts](../src/proxy.ts)): the SUBMITTER/REVIEWER event-path
  allow-list extends from `abstracts*` to also pass `session-proposals*`.
- **API routes** use the modern guard form `denyReviewer(session, { allow: ["SUBMITTER"] })`
  on submitter-reachable writes (cleaner than abstracts' hand-rolled role checks), plus:
  - SUBMITTER list/read scoped by `speaker.userId === session.user.id` server-side
    (404 on foreign ids — no existence leak, same as abstracts).
  - SUBMITTER create binds `speakerId` to their own linked Speaker; PUT allowed **only while
    DRAFT** (`SUBMITTED_LOCKED` 403 code); status escalation refused (create accepts
    DRAFT|SUBMITTED only).
  - Organizer writes (theme CRUD, WITHDRAWN, delete) are org-scoped `denyReviewer` +
    `buildEventAccessWhere` — REVIEWER has **no** proposal access in v1 (nothing to review).
- **Improvement over abstracts:** the proposal-themes **GET** authorizes via
  `buildEventAccessWhere` (org staff OR linked submitter) instead of `requireOrgId`, so
  submitters can actually see the theme picker on the form. (The abstract-themes GET
  requires an org context — org-null submitters can't read it; noted as a latent abstracts
  gap, not fixed here.)
- **Event scoping**: `buildEventAccessWhere` already handles SUBMITTER via Speaker linkage —
  zero changes needed there.

## 5. Surfaces

- **`/events/[eventId]/session-proposals`** — one page, dual-mode like the abstracts list:
  organizer sees all (status tiles, theme badge, search, CSV export, detail sheet, themes
  manager card, Withdraw action); a SUBMITTER sees "My Session Proposals" (own rows only,
  server-scoped) + a Submit CTA.
- **`/events/[eventId]/session-proposals/new`** — full-page submit form (abstracts/new
  shape): title, description, theme select, format select (program kinds), duration,
  Save-draft / Submit. Own-speaker resolution via the speakers list (`userId` match — the
  abstracts/new trick).
- **Sidebar**: "Session Proposals" in the Abstracts section; added to the restricted-role
  allow-list AND to `WEBINAR_HIDDEN_MODULES` (webinars don't collect proposals, same as
  abstracts).
- **Emails**: new editable system template **`session-proposal-confirmation`** (in
  `DEFAULT_TEMPLATES` + the `SYSTEM_TEMPLATE_SLUGS` mirror — drift test covers it) sent to
  the proposer on submit/resubmit; `notifyEventAdmins("New Session Proposal")`. Both
  failure-isolated from the create.

## 6. Deliberately NOT in v1 (recorded so nobody builds them opportunistically)

- **Review workflow** — no reviewers, scores, or ACCEPTED/REJECTED. The status enum +
  separate-model design leaves v2 room: reviewer machinery would mirror the abstracts
  service shape (`session-proposal-service`), never bolt onto `abstract-service`.
- **Convert-to-session** — the v2 payoff feature: one click pre-fills an agenda
  `EventSession` (name/description/duration/type — `proposedFormat` already speaks
  `SessionType`) and links back. Owner explicitly deferred.
- **Proposed-speakers block** (co-author-style JSON) — owner chose core fields only.
- **MCP tools** (`list_session_proposals`, theme CRUD) — fast-follow when an integration
  needs it; requires the usual pkg bump + client reconnect.
- ~~**Dedicated public register page**~~ — **✅ SHIPPED July 30, 2026 (same day, owner
  request — see §8)**: `/e/[slug]/proposal/register`.
- **Theme filter on the organizer list** — abstracts doesn't have one either; add to both
  together if asked.

## 7. Multi-tenancy

Born ready: both tables carry a denormalized `organizationId` stamped at create (nullable,
convention of LoginEvent/HelpChatQuery), app-level org scoping on every organizer query
(defence #1). NOT wrapped in `runWithTenant` — per the Phase-2 rule, only swept domains
wrap; the program-domain sweep picks these tables up with flat RLS policies when it runs.
Theme names are per-event (`@@unique([eventId, name])`), so tenant vocabulary never
collides by construction.

## 8. Proposer onboarding + attendance (same-day follow-up, July 30, 2026)

Owner framing: *"session proposal should work like abstract submission — create an
account, fill in all details; the proposer will attend the conference, mostly
complimentary, like faculty."* Decisions locked (after an explicit mid-build reversal):

1. **Dedicated public register page** — `/e/[slug]/proposal/register`, a thin variant
   wrapper over the new shared [`SubmitterRegisterPage`](../src/components/public/submitter-register.tsx)
   (the abstract register page is the other wrapper — ONE implementation, the
   no-cross-caller-duplication rule). Same 2-step account+details form, same
   `POST /submitter` + `abstract-start` backends (one SUBMITTER login covers abstracts
   AND proposals); only copy, the welcome HTML source
   (**`Event.sessionProposalWelcomeHtml`**, editable under Content → Session Proposals,
   additive migration `20260730180000`), the abstract-only gate/deadline, and the
   post-login destination differ (`?redirect=session-proposals` named branch in the
   event login; existing-account sign-in lands on `/events/[id]/session-proposals`).
   A **Copy proposer link** button sits on the organizer's Session Proposals page.
2. **Attendance model: auto-comp + organizer REVOKE** (owner initially picked
   organizer-GRANTS-per-person, then reversed mid-build — "we allow them; organizer can
   remove"). Signup keeps auto-minting the comp Faculty companion registration (badge /
   entry barcode / check-in) exactly like abstract submitters; the organizer removes free
   entry per person via **Revoke registration** on the proposal detail sheet (cancels the
   companion through the normal `POST .../cancel` — only offered for COMPLIMENTARY, never
   a PAID delegate registration). **Known accepted trade-off:** on a paid event the signup
   link is a free-entry backdoor until revoked; mitigations = targeted link sharing, the
   visible Faculty badge, and a registrations-list Badge=Faculty audit.
3. **Grant/re-grant counterpart** — new `POST /api/events/[eventId]/speakers/[speakerId]/grant-companion`
   (ADMIN/ORGANIZER via default `denyReviewer`; event via `buildEventAccessWhere`; 60/hr;
   audited `COMPANION_GRANTED` on real grants only). Idempotent via
   `ensureSpeakerCompanionRegistration`, **with a cancelled-link override**: a revoked
   companion leaves `Speaker.sourceRegistrationId` pointing at the CANCELLED row, which
   would short-circuit "already-linked" — the route passes `sourceRegistrationId: null`
   in that case so a fresh companion is minted + the pointer re-homed. Surfaced as
   Grant/Re-grant buttons on the proposal sheet + the speaker page's Registration card
   (the card's empty state doubles as the provisioning-hiccup recovery, replacing the
   "run the backfill" instruction). Route tests:
   [`grant-companion-route.test.ts`](../__tests__/api/grant-companion-route.test.ts).
