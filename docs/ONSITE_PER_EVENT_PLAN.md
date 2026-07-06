# Per-event ONSITE (registration-desk) staff — implementation plan

> Status: **PLAN — not yet implemented.** Created July 6, 2026.
> Goal: make the ONSITE role assignable **per event** (a temp desk worker hired
> for "Conference X" sees only Conference X), instead of the current org-wide
> visibility.

---

## 1. Current state (grounded)

ONSITE is an **org-bound team role** today. A temp desk worker invited as ONSITE
can currently open **every event in the org** — their restriction is on *writes*
and *finance*, not on *which events they see*.

The relevant touch-points (18 files reference `ONSITE`):

| Concern | Where | Current behavior |
|---|---|---|
| **Event visibility** | [src/lib/event-access.ts](../src/lib/event-access.ts) | ONSITE falls into the default branch → **all org events** (same as ORGANIZER). ← the core thing to change |
| Write guard | [src/lib/auth-guards.ts](../src/lib/auth-guards.ts) | In `RESTRICTED_WRITE_ROLES` + `TEAM_ROLES`; opted back into create-registration / check-in / badge routes via `REGISTRATION_DESK_ALLOW` |
| Finance | [src/lib/finance-visibility.ts](../src/lib/finance-visibility.ts) | Excluded from `canViewFinance` (money hidden) |
| Write helper | [src/lib/can-write.ts](../src/lib/can-write.ts) | ONSITE handling |
| Navigation | [src/proxy.ts](../src/proxy.ts) `L153` | Confined to `/events` list + **any** event's `/registrations*` + `/check-in*` (does NOT restrict *which* event) |
| Invite | [src/app/api/organization/users/route.ts](../src/app/api/organization/users/route.ts) | Invited **org-wide** via Settings → Users (org-bound account) |
| UI | sidebar, header badge, registrations page, detail sheet, abstracts page, settings page | Gate by role only |

**The template already in the codebase: REVIEWER.** Reviewers are scoped
per-event via `Event.settings.reviewerUserIds` (a JSON array of user ids):
- `buildEventAccessWhere` REVIEWER branch → `settings.path(['reviewerUserIds']).array_contains user.id`
- Assignment: `POST/DELETE /api/events/[eventId]/reviewers` (add by existing speaker OR invite-by-email; creates the account, appends to `reviewerUserIds` via the atomic `updateEventSettings` helper, sends an invite).
- Reviewers are **org-independent** (`organizationId: null`).

We mirror this for ONSITE.

---

## 2. The central design decision

Two models deliver "assign per event." They differ on **whether temp staff stay
org members**:

### Model A — org-bound + per-event scoping (smaller, safer)
ONSITE keeps `organizationId` (still a team member) but `buildEventAccessWhere`
scopes them to `Event.settings.onsiteUserIds` instead of all org events.
- **Pros:** minimal blast radius; keeps the existing invite flow + finance model
  + TEAM_ROLES membership intact; lowest risk on live prod.
- **Cons:** temp staff remain permanent org accounts you must remember to delete
  (they still show in Settings → Users). Less "temp".

### Model B — org-independent, reviewer-style (cleaner "temp", bigger change)
ONSITE becomes `organizationId: null`, scoped **purely** by
`settings.onsiteUserIds` — exactly like reviewers. Pull ONSITE out of
`TEAM_ROLES` so temp accounts don't clutter the staff list; manage them entirely
from a per-event "Onsite Staff" page.
- **Pros:** matches the reviewer precedent exactly; genuinely event-scoped,
  ephemeral temp accounts; conceptually the best fit for "temp … per event".
- **Cons:** bigger blast radius — removing ONSITE from `TEAM_ROLES` ripples into
  the Settings → Users list, the internal-domain org-attach rule, and every
  `isTeamRole`/org-bound assumption; more to verify on live prod.

**Recommendation:** ship **Model A first** (delivers the core ask — per-event
visibility — with the least risk), and treat Model B (making them truly
org-independent/ephemeral) as a follow-up once A is proven. The rest of this plan
is written for **Model A**, with the Model-B deltas called out in §7.

---

## 3. Design (Model A)

### 3.1 Assignment store
`Event.settings.onsiteUserIds: string[]` — JSON array of ONSITE user ids, exactly
mirroring `reviewerUserIds`. **No migration** (settings is JSON). All writes go
through the atomic `updateEventSettings(eventId, patch)` merge helper (avoids the
lost-update race the settings blob is prone to).

### 3.2 Event scoping — the core change
New ONSITE branch in `buildEventAccessWhere` (before the org-bound default):
```ts
if (user.role === "ONSITE") {
  // Org-bound AND explicitly assigned to the event. The org guard keeps a
  // leaked id from another org from matching; the settings check is the
  // per-event assignment.
  return {
    ...(eventId && { id: eventId }),
    organizationId: user.organizationId!,
    settings: { path: ["onsiteUserIds"], array_contains: user.id },
  };
}
```
Effect: the ONSITE events list, and every registrations/check-in/badge API that
runs through `buildEventAccessWhere`, now returns **only assigned events**. An
unassigned event's data 404s/empties — the real enforcement layer.

### 3.3 Assignment API — mirror the reviewers route
New `POST/DELETE /api/events/[eventId]/onsite-staff/route.ts` (copy the reviewers
route's shape):
- `POST` — add by existing user (pick from org ONSITE users) OR invite-by-email
  (create an ONSITE account + append to `onsiteUserIds` + send a setup invite).
- `DELETE` — remove the id from `onsiteUserIds` (does not delete the account).
- `denyReviewer`-guarded, org-scoped, rate-limited, audited — same as reviewers.

### 3.4 Assignment UI — a per-event "Onsite Staff" page
Mirror the Reviewers page: list assigned staff, add (pick existing / invite by
email), remove. Reachable from the event's Settings (or a sidebar entry for
admins). Reuses the reviewer page's components/patterns.

### 3.5 Invite flow
Two options (confirm in §8):
- **(a)** Keep the org-level Settings → Users invite (creates the ONSITE account),
  then assign per-event from the new page. Two steps, but reuses everything.
- **(b)** Per-event invite that creates **and** assigns in one go (like the
  reviewers "invite by email"). Cleaner for temp staff. Recommended.

### 3.6 Middleware
Largely unchanged — it still confines ONSITE to `/registrations*` + `/check-in*`.
It does **not** need per-event awareness (middleware is Edge, no DB); the
API/page scoping in §3.2 is the enforcement. Optional polish: on an unassigned
event path, the page will already render empty — acceptable, matches reviewers.

---

## 4. Blast radius (Model A)
- **Change:** `event-access.ts` (new branch), new assignment route, new UI page,
  new hook(s), the invite path (if per-event).
- **Unchanged:** `auth-guards` (ONSITE stays restricted-write + team role +
  desk-allow), `finance-visibility`, `can-write`, `proxy.ts`, the registration
  write routes. So the write/finance/nav guards keep working exactly as today —
  only *event visibility* narrows.

---

## 5. Behavior change + backfill (IMPORTANT — confirm)
Today every ONSITE user sees all org events. After §3.2 they see **none until
assigned**. Existing ONSITE accounts would suddenly lose visibility. Options:
- **(a)** Backfill: add every existing ONSITE user to `onsiteUserIds` on all
  current (non-archived) events — preserves today's behavior, they narrow only
  for *future* events. One-time script (dry-run default, `--write`).
- **(b)** Clean slate: require re-assignment; announce it. Fits "temp" but
  surprises anyone mid-event.
Recommend **(a)** so no live desk loses access at cutover.

---

## 6. Phasing (each shippable + gated + reviewed)
- **Phase 1 — scoping + assignment backend.** `onsiteUserIds` + `buildEventAccessWhere`
  branch + the `onsite-staff` POST/DELETE route + backfill script. Unit-test the
  access-where branch (assigned → event visible, unassigned → not; org guard).
  Ship behind the backfill so nobody loses access.
- **Phase 2 — assignment UI.** The per-event Onsite Staff page + hook; per-event
  invite (if chosen). e2e the add/remove/invite.
- **Phase 3 (optional) — Model B.** Make ONSITE org-independent + pull from
  TEAM_ROLES, once A is proven.

---

## 7. Model-B deltas (if chosen instead)
- Drop the `organizationId` guard in the access-where branch (scope purely by
  `onsiteUserIds`, like reviewers).
- Remove ONSITE from `TEAM_ROLES` (`auth-guards.ts`) → it stops appearing in
  Settings → Users; managed only per-event.
- Create ONSITE accounts `organizationId: null`.
- Re-check every `isTeamRole`/org-bound assumption + the internal-domain rule +
  the `organization/users` invite (ONSITE would move to the per-event invite).
- Bigger verification surface — its own PR.

---

## 8. Decisions to confirm before coding
1. **Model A (org-bound + per-event, recommended) vs Model B (org-independent,
   reviewer-style).** A is smaller/safer; B is the truer "temp".
2. **Backfill existing ONSITE users** onto all current events (recommended) vs
   clean-slate re-assignment.
3. **Invite flow:** per-event invite that creates+assigns (recommended) vs keep
   org-level invite + separate per-event assignment.
4. **Assignment UI location:** event-level page (like Reviewers) — confirm it
   lives under the event, not org Settings.
5. **Multi-event assignment:** can one ONSITE account be assigned to several
   events at once (recommended — a staffer working two days/two halls)? The
   `onsiteUserIds`-per-event model supports this naturally.
