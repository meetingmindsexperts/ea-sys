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

**Organizer** — `/events/[eventId]/dinner` ([page](../src/app/%28dashboard%29/events/%5BeventId%5D/dinner/page.tsx)):
1. Add dinners (name / date+time / venue / optional RSVP deadline).
2. Add invitees (manual name+email rows; de-duped on `(eventId, email)` — re-adding an email
   is skipped, not errored).
3. Copy each invitee's personalized link to send (email delivery = P2).
4. Read the roster: per-invitee status + which dinners + guests + dietary, per-dinner
   **headcount tiles** ("Day 1: 42 (+8 guests) · 50 seats"), and **CSV export**.

**Invitee** — `/e/[slug]/rsvp/[token]` ([page](../src/app/e/%5Bslug%5D/rsvp/%5Btoken%5D/page.tsx),
public, no login): name/email pre-filled read-only → a checkbox per dinner (+ guest count) →
a dietary note → submit. **Re-editable until each dinner's deadline** (upsert). Ticking none
records "not attending" (not a silent non-response). Dinners past their deadline show closed
and are ignored on submit.

## API

Organizer (session, org-scoped, `denyReviewer` on writes, rate-limited):
- `GET/POST /api/events/[eventId]/dinners` · `PUT/DELETE /api/events/[eventId]/dinners/[dinnerId]`
- `GET /api/events/[eventId]/rsvp-invites` (roster + headcounts; `?export=csv`)
- `POST /api/events/[eventId]/rsvp-invites` (bulk add, ≤500) · `DELETE …/[inviteId]`
- `POST /api/events/[eventId]/rsvp-invites/send` `{ target: "all" | "pending", subject?, message? }`
  — emails each invitee their personalized link via the branded email pipeline
  (`brandingFrom`/`renderAndWrap`/`sendEmail` + EmailLog, `templateSlug: "dinner-rsvp-invitation"`);
  per-recipient try/catch, 10/hr/event. "pending" = remind non-responders.

Public (token-gated, per-IP rate-limited):
- `GET/POST /api/public/events/[slug]/rsvp/[token]`

Shared helpers: [src/lib/rsvp/rsvp.ts](../src/lib/rsvp/rsvp.ts) — `generateRsvpToken`,
`normalizeRsvpEmail`, `computeDinnerHeadcounts`, `isAttendingAny`, and the Zod schemas.

## Migration

`prisma/migrations/20260708120000_add_dinner_rsvp` — additive + blue-green safe (new enum +
three tables; old code ignores them).

## Status / roadmap

- **P1 (shipped):** schema, dinners CRUD, invite list (manual add), public RSVP form, roster
  + headcounts + CSV, copy-link, Setup-hub card.
- **P2 (shipped):** email the personalized links (`{{rsvpLink}}`) via the branded email
  pipeline + **"remind pending"** — "Email invitations" / "Remind pending" buttons on the
  organizer console → optional subject + message → `POST .../rsvp-invites/send`.
- **P3 (partial):** ✅ import invitees from Registrations/Speakers (picker,
  [ImportInviteesDialog](../src/components/dinner/import-invitees-dialog.tsx)); ✅ MCP pull tool
  `list_dinner_rsvps` ([tools/dinner.ts](../src/lib/agent/tools/dinner.ts) — dinners +
  per-night headcounts + per-invitee responses, read-only). ⏳ scheduled/auto reminder cron
  (trigger design pending — the manual "Remind pending" button already covers the core need).
