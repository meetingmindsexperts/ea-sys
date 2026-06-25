# Plan: Speaker-as-Attendee (companion registration) + multi-role, survey-gated certificates

> Status: **Phase 0 SHIPPED (June 25, 2026, commits `20b0e4f` + sweep `c988e64`).
> Phases 1–3 PLANNED.** Foundational change on a LIVE production system →
> additive/idempotent migrations only, phased rollout, reviewed backfill, full
> gate (tsc/eslint/vitest/build) per phase.
>
> **Phase 0 done:** `TicketType.isFaculty` + `RegistrationCreatedSource.SPEAKER_COMPANION`
> (additive migration); `src/lib/speaker-companion.ts` (ensure-faculty-type +
> ensure-companion, idempotent: already-linked → link-same-email → create comp/
> uncapped Faculty companion with barcode/badge, no soldCount); wired into all
> speaker-add paths (service/REST/MCP single + CSV/contacts/MCP bulk;
> import-registrations already links); Faculty type hidden from public
> registration; `scripts/backfill-speaker-companion-registrations.ts` (operator-run).
> **Sweep (0e) done:** `src/lib/faculty-filter.ts` `EXCLUDE_FACULTY_WHERE` applied
> to all delegate counts/stats/analytics/MCP-dashboard/webinar-KPI; `isFaculty`
> exposed in the registrations list API. Operator must run the backfill after deploy.
>
> **Open Phase-0 follow-ups (deferred, not blocking):** a "Faculty vs delegate"
> split tile + a faculty filter toggle in the registrations list UI; speaker→
> companion name/profile edit sync.

## Goal

A speaker added by the organizer must receive **everything a registration
receives** — survey, entry barcode, **DTCM barcode**, **badge**, **check-in** —
and (the certificates motivation) be able to hold **multiple role-specific CME
certificates** (e.g. one person who is Organizing Committee + Speaker + Moderator
gets three certs). The only difference between a speaker and a normal attendee is
the **entry path** (organizer-added, not public self-registration) and that
faculty are comp + don't consume a paid seat.

## Core model decision

A speaker gets a **companion Registration** (the "attendee facet"), created
automatically when the speaker is added, linked via the existing
`Speaker.sourceRegistrationId`. Attendee facilities (badge/barcode/DTCM/check-in/
survey) come **for free** because the speaker now *has a registration* — we reuse
the existing machinery instead of duplicating it onto the Speaker entity.

**Why companion-registration over duplicating onto Speaker:** the alternative is
to add qrCode/badge/checkedInAt/surveyCompletedAt/DTCM to Speaker and teach the
scanner, badge printer, survey, and DTCM import to handle two entity types —
double the surface, guaranteed drift. The companion registration reuses one
machinery.

**Why this reverses the earlier "don't give speakers a registration" caution:**
that was premised on faculty *not* attending. They do attend and need the full
attendee facility set, so they genuinely are attendees + speakers.

## Locked decisions (from planning)

1. **Multi-cert distinction = template-as-role.** Uniqueness flips from "one per
   category" → **one cert per template per person**.
2. **"Organizing/Scientific Committee" = a Speaker** (tagged). No `userId`
   recipient — committee members receive certs as Speakers. Recipient model stays
   `speakerId | registrationId`.
3. **CME hours = static, per template** (organizer types hours into each
   template; snapshot onto the cert at issue, as today).
4. **Survey gate scope = all of a person's role certs** (completing the survey
   auto-issues every auto-flagged template the person qualifies for).
5. **Auto-issue timing = enqueue → existing cert worker delivers** (survey POST
   stays fast + failure-isolated).
6. **Companion registration = automatic for every speaker.**
7. **Existing speakers = backfilled now** via a reviewed one-time idempotent script.
8. **Faculty registration type = auto-provisioned default per event** (hidden,
   comp, uncapped).

---

## Phase 0 — Companion registration foundation (the load-bearing phase)

### 0a. Internal "Faculty" ticket type
- **Schema (additive):** `TicketType.isInternal Boolean @default(false)`.
  Marks the auto-provisioned Faculty type as internal → **hidden from public
  registration** + **uncapped** (companion creation skips `soldCount`).
- Helper `ensureFacultyTicketType(eventId)` — find-or-create a hidden
  `isInternal` "Faculty" type (price 0). Idempotent.

### 0b. Companion-registration helper
`ensureSpeakerCompanionRegistration(speaker, eventId, actor)`:
1. `speaker.sourceRegistrationId` set → done.
2. Else a registration with the same email exists in the event → **link it**
   (set `sourceRegistrationId`) — never duplicate a real registrant.
3. Else **create** a Faculty companion registration:
   - Attendee = copy of the speaker's person fields (name/email/title/org/…).
   - Registration: Faculty (`isInternal`) type, `paymentStatus = COMPLIMENTARY`,
     `attendanceMode = IN_PERSON`, **qrCode minted** (entry barcode),
     `createdSource = "SPEAKER_COMPANION"`, **soldCount NOT incremented**.
   - Set `speaker.sourceRegistrationId = newReg.id`.
- Idempotent; failure-isolated (a hiccup must not fail the speaker create — log +
  recoverable via the backfill script).

### 0c. Wire into every speaker-add path
- REST `POST /speakers` + `speaker-service.createSpeaker` + MCP `create_speaker`
  → ensure companion after create.
- CSV import / import-contacts → ensure companion per created speaker.
- import-registrations → already has the registration; **already links**
  `sourceRegistrationId` (shipped). ✓
- (panelist sync operates on existing speakers — covered by their own create.)

### 0d. Backfill script
`scripts/backfill-speaker-companion-registrations.ts` — dry-run default, `--write`:
- Speaker linked already → skip.
- Speaker unlinked but email-matches a registration → **link** (no new row).
- Speaker unlinked + no match → **create** companion. Idempotent, reviewed,
  run-once after Phase 0 deploys.

### 0e. Faculty correctness across attendee surfaces (the careful part)
- **Capacity/finance:** faculty type is `isInternal` (uncapped) + COMPLIMENTARY →
  excluded from paid-seat counts + revenue. Audit every place that sums
  registrations for **capacity or money** to exclude `isInternal` ticket types
  (dashboards, finance, "sold/available", tier counts).
- **Attendee facilities (included):** badge (Faculty badge type), entry barcode
  (qrCode), DTCM (eligible per event toggle), check-in (qrCode), survey.
- **Registrations list:** faculty companions appear as registrations
  (distinguishable by the Faculty type/badge). Add a filter so organizers can
  show/hide faculty. **Open sub-decision:** default the list to delegates-only
  with a "include faculty" toggle, vs show all.
- **Speaker ↔ companion sync:** editing the speaker's name/email should sync to
  the companion Attendee (same person). Email already goes through the dedicated
  change-email flow; name/profile edits need a sync hook (reuse the
  `contact-sync` fire-and-forget pattern).

---

## Phase 1 status (June 25, 2026) — ✅ COMPLETE (1a + 1b)

**1a SHIPPED (commit `bc09c0c`)** — the enablement: `IssuedCertificate` uniqueness
swapped per-type → **per-template** (migration `20260625140000`, verified
collision-free); eligibility + worker dup-recovery both re-keyed to
`certificateTemplateId`; additive `CertificateTemplate.role` + `cmeHours` columns.
**Multi-role certs work** — issue N role-templates to one person → N certs.

**1b SHIPPED (commit `de008b3`, lockfile fix `8c15f35`)** — per-template tokens +
the editor:
- **`{{cmeHours}}` per-template + `{{role}}` token.** `resolveTokens` resolves
  `{{cmeHours}}` from `template.cmeHours ?? event.cmeHours` and adds `{{role}}` =
  `template.role`. The worker loads `template.role`/`cmeHours` and snapshots
  `cmeHoursSnapshot = template.cmeHours ?? event.cmeHours`.
- **REST** template POST + PATCH accept + persist `role` + `cmeHours`; list GET
  returns them.
- **MCP** `create_/update_certificate_template` accept `role` + `cmeHours`
  (handlers + tool-def params); package 0.4.9 → 0.4.10.
- **Editor UI** — Role + CME-hours inputs in the template editor header
  (commit-on-blur). CME hours entered manually per template; issuance tag-driven.
- +2 tests (per-template override + event fallback + role token).

**Verify on prod after deploy:** create a template, set role + CME hours, drop
`{{role}}`/`{{cmeHours}}` text boxes, issue one → confirm the rendered PDF shows
them (the one thing tests can't fully prove).

## Phase 1 — Multi-role certificates (template = role)

### Schema
- `CertificateTemplate.cmeHours Decimal? @db.Decimal(4,1)` — static per-template CME hours.
- `CertificateTemplate.role String?` — designation label (e.g. "Speaker",
  "Moderator", "Organizing Committee"); drives a `{{role}}` token. (Template
  `name` can default it.)
- **Uniqueness swap (the one non-additive migration):**
  - DROP `@@unique([eventId, type, registrationId])`, `@@unique([eventId, type, speakerId])`.
  - ADD `@@unique([eventId, certificateTemplateId, registrationId])`, `@@unique([eventId, certificateTemplateId, speakerId])`.
  - **Safe on live data (verified reasoning):** every existing `(event, type, person)`
    holds ≤1 cert and a template belongs to one type, so no two certs can collide on
    `(event, template, person)`; legacy null-template certs are distinct under
    Postgres null semantics. Migration: drop-then-add, idempotent guards, no backfill.

### Behavior
- Issue flow already picks a template → issuing N role-templates to one person now
  yields N certs (one per template). Eligibility stays tag-driven.
- `{{cmeHours}}` + `{{role}}` resolve from the template; snapshot onto the cert.

## Phase 2 — Survey-triggered auto-issue

### Config (per template)
- `CertificateTemplate.autoIssueOnSurvey Boolean @default(false)`.
- `CertificateTemplate.autoIssueTag String?` — the tag a person must hold for this
  template to auto-issue (stored, vs the manual flow's at-issue tag).

### Flow
1. Survey submit (`finalizeSubmission`) sets `surveyCompletedAt` → **enqueue** an
   auto-issue check for that registration (a lightweight queue row; no inline
   render/SES).
2. Resolve the person: registration + linked speaker (`sourceRegistrationId`
   reverse / email) → gather **all tags** (attendee + speaker).
3. For each template with `autoIssueOnSurvey` AND person-holds-`autoIssueTag` →
   enqueue issuance to the correct recipient (speaker certs → `speakerId`,
   attendance → `registrationId`).
4. The **existing cert worker** drains the queue → render PDF + email.
   **Idempotent** via the per-template uniqueness (re-submit / manual-first can't
   duplicate).
- Works for speakers now — they have a companion registration that can complete
  the survey.

## Phase 3 — Manual issue / reissue override (mostly exists)
- Existing tag-driven Issue flow + resend route already cover "issue to someone
  who didn't survey" and "reissue/resend". Verify compatibility with per-template
  uniqueness + new fields. Manual flow ignores the survey gate (organizer-driven).

---

## Live-system safety checklist
- Migrations additive **except** the Phase 1 cert-uniqueness swap (verified
  no-collision; drop-then-add, idempotent).
- Backfill script: dry-run default, idempotent, reviewed before `--write`.
- Companion creation failure-isolated; recoverable via backfill.
- Every capacity/finance aggregation audited to exclude `isInternal` faculty regs.
- Full gate per phase; each phase independently shippable + revertible.

## Recommended build order
**Phase 0 first** (foundation — gives speakers all attendee facilities + unblocks
survey-gated certs for speakers), validated on prod, then **Phase 1** (multi-role
certs), then **Phase 2** (auto-issue), with **Phase 3** as a verification pass.

## Open sub-decisions (flag, not blocking)
1. Registrations list default: delegates-only + "include faculty" toggle, vs show all.
2. Speaker→companion name/profile sync: sync-on-edit now, or defer.
3. Reporting: a "faculty vs delegate" split tile (likely yes, Phase 0e).
