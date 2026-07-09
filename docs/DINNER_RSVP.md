# Dinner RSVP

> Invite people to an event's dinners with a **personalized link**, let them RSVP **per
> dinner** (Yes/No + guest count) plus a dietary note, and capture every response in the
> backend for the organizer — per-night headcounts, roster, CSV. Reached from
> **Event → Setup → Dinner RSVP**.

## The model

One event has **many dinners** (Day 1 Dinner, Day 2 Gala…). Each invited person gets **one
token link** that covers **all** the event's dinners. Three tables:

- **`RsvpDinner`** — one row per dinner: `name`, `dinnerAt`, `location?`, `description?`,
  `rsvpDeadline?`, `sortOrder`, `isActive`.
- **`RsvpInvite`** — one row per invited person (event-level, so one link = all dinners):
  `token` (unique, 192-bit base64url), `inviteeName`, `inviteeEmail`, optional soft refs
  `registrationId`/`speakerId`, `dietary`, `status` (`PENDING` → `RESPONDED`), `respondedAt`.
  Unique `(eventId, inviteeEmail)`.
- **`RsvpDinnerResponse`** — the per-dinner answer: `attending` (bool), `guestCount`. Unique
  `(inviteId, dinnerId)` → clean per-night headcount counts.

The token is **plaintext-in-DB** (like `Abstract.managementToken`) so the dashboard can
re-display the link. Lookup is by the unique `token` column, then the invite's event is
asserted against the URL slug.

## Flows

**Organizer** — `/events/[eventId]/dinner` ([page](../src/app/%28dashboard%29/events/%5BeventId%5D/dinner/page.tsx)).
The console opens with a **"How Dinner RSVP works"** instruction card, then:
1. Add dinners (name / date+time / venue / optional RSVP deadline).
2. Add invitees (manual name+email rows) or **import from Registrations/Speakers**; de-duped on
   `(eventId, email)` — re-adding an email is skipped, not errored.
3. Send them their link, three ways: **Email invitations** (bulk to all) / **Remind pending**
   (bulk to non-responders), the per-row **Send** button (email **one** invitee), or **copy** an
   individual link to send it yourself.
4. Read the roster: per-invitee status + which dinners + guests + dietary, per-dinner
   **headcount tiles** ("Day 1: 42 (+8 guests) · 50 seats"), and **CSV export**.

**Invitee** — `/e/[slug]/rsvp/[token]` ([page](../src/app/e/%5Bslug%5D/rsvp/%5Btoken%5D/page.tsx),
public, no login): name/email pre-filled read-only → a checkbox per dinner (+ guest count),
**or an explicit "I won't be able to attend any of the dinners" checkbox** → a dietary note →
submit. Submit is gated on an **explicit choice** (tick ≥1 dinner or decline) so nobody
half-submits. **Re-editable until each dinner's deadline** (server-authoritative replace-all
over open dinners); a prior "declined all" re-opens with the decline box ticked. Dinners past
their deadline show closed and are ignored on submit.

## API

Organizer (session, org-scoped, `denyReviewer` on writes, rate-limited):
- `GET/POST /api/events/[eventId]/dinners` · `PUT/DELETE /api/events/[eventId]/dinners/[dinnerId]`
- `GET /api/events/[eventId]/rsvp-invites` (roster + headcounts; `?export=csv`)
- `POST /api/events/[eventId]/rsvp-invites` (bulk add, ≤500) · `DELETE …/[inviteId]`
- `POST /api/events/[eventId]/rsvp-invites/send` — **one route for single + bulk**. Body is
  `{ inviteId?, target?: "all" | "pending", subject?, message? }` (Zod refine: **`inviteId` OR
  `target`**). `inviteId` → email exactly that one invitee (the per-row Send button); otherwise
  `target` selects the batch ("pending" = remind non-responders). Renders the
  **`dinner-rsvp-invitation` system email template** (per-event override via Communications →
  Email Templates, else the default) with **per-recipient** vars `{{firstName}}`, `{{lastName}}`,
  `{{fullName}}`, `{{email}}`, `{{eventName}}`, `{{dinnerWord}}` ("dinner"/"dinners" — matches the
  event's dinner count so copy stays grammatical), `{{rsvpLink}}` (that invitee's own token link),
  `{{personalMessage}}` (the optional note), `{{organizerName}}`, `{{organizerSignature}}` — so a
  bulk send is personalized identically to a single one (never a shared link). Sends via the
  branded pipeline (`getEventTemplate` + `renderAndWrap` + `sendEmail` + EmailLog); per-recipient
  try/catch, 10/hr/event. The bulk send dialog has a **Preview** button
  (`/api/events/[eventId]/email-preview` by slug → `EmailPreviewDialog`).

Public (token-gated, per-IP rate-limited):
- `GET/POST /api/public/events/[slug]/rsvp/[token]`

Shared helpers: [src/lib/rsvp/rsvp.ts](../src/lib/rsvp/rsvp.ts) — `generateRsvpToken`,
`normalizeRsvpEmail`, `computeDinnerHeadcounts`, `isAttendingAny`, and the Zod schemas.

## Migration

`prisma/migrations/20260708120000_add_dinner_rsvp` — additive + blue-green safe (new enum +
three tables; old code ignores them).

## Review

Independent adversarial review (2026-07-08) — **no BLOCKER/HIGH**; org-scoping/IDOR, public-token
security, `denyReviewer` coverage, cascade/unique integrity, headcount math, silent-failure logging,
email isolation, React correctness, and migration safety all verified clean. **Fixed:** **M2** the
bulk-add `created` count now comes from `createMany`'s real `{ count }` (not `toCreate.length`), so a
`skipDuplicates`-dropped race isn't over-reported; **M3** the public submit is now server-authoritative
**replace-all over open dinners** (clears the invite's open-dinner responses, re-creates only the
attending ones) so a partial/crafted POST can't leave ghost attendance — closed dinners untouched.
Route tests in [__tests__/api/dinner-rsvp-routes.test.ts](../__tests__/api/dinner-rsvp-routes.test.ts).
Accepted-as-is (consistent with the codebase): organizer `personalMessage` is raw HTML (trusted,
ADMIN/ORGANIZER-only, no invitee-controlled value hits an unescaped sink); MEMBER can read the roster
(no finance data).

## Status / roadmap

- **P1 (shipped):** schema, dinners CRUD, invite list (manual add), public RSVP form, roster
  + headcounts + CSV, copy-link, Setup-hub card.
- **P2 (shipped):** email the personalized links (`{{rsvpLink}}`) via the branded email
  pipeline + **"remind pending"** — "Email invitations" / "Remind pending" buttons on the
  organizer console → optional subject + message → `POST .../rsvp-invites/send`.
- **P3 (shipped):** ✅ import invitees from Registrations/Speakers (picker,
  [ImportInviteesDialog](../src/components/dinner/import-invitees-dialog.tsx)); ✅ MCP pull tool
  `list_dinner_rsvps` ([tools/dinner.ts](../src/lib/agent/tools/dinner.ts) — dinners +
  per-night headcounts + per-invitee responses, read-only). ⛔ **auto-reminder cron —
  deliberately NOT built** (owner decision, 2026-07-08): the manual **"Remind pending"**
  button covers it; a scheduled/automatic reminder wasn't worth the cron + schema field.
- **Follow-ups (shipped, 2026-07-09):** per-invitee **single send** (same route via `inviteId`,
  per-row Send button); **richer per-recipient vars** (`lastName`/`fullName`/`email` alongside
  `firstName`) so bulk personalizes like a single send; public form **explicit "I won't attend"
  checkbox** + submit gated on a choice; organizer **"How Dinner RSVP works" instruction card**;
  **singular/plural handling** — the public form ("Will you be attending?" vs "Which dinners…",
  "I won't be able to attend" vs "…any of the dinners") and the email `{{dinnerWord}}` adapt to
  whether the event has one dinner or several (the common case is one).
