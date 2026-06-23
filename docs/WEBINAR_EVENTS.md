# Webinar Events — Implementation Guide

**Last updated:** 2026-04-14
**Status:** Phases 1–6 complete, UX refresh applied, **public session page rebuilt with in-page Zoom embed + tabs + sponsors**

This document is the minimal, end-to-end reference for WEBINAR-type events in EA-SYS.

---

## What it does

Creating an event with `eventType = 'WEBINAR'` turns on a differentiated mode:

1. **Auto-provisions** an anchor `EventSession` and a Zoom webinar
2. **Queues** a 5-phase email sequence (confirmation → 24h → 1h → live-now → thank-you+recording)
3. **Polls Zoom** post-event for cloud recording, attendance, polls, and Q&A
4. **Surfaces everything** on a dedicated Webinar Console at `/events/[eventId]/webinar`
5. **Hides** irrelevant modules (Accommodation, Check-In, Promo Codes, Abstracts, Reviewers) from the sidebar
6. **Embeds Zoom in-page** on the public session URL via the `ZoomWebEmbed` Component View component — attendees watch without leaving the domain (no redirect to zoom.us)
7. **Surfaces sponsors + topics + speaker bios** under a 3-tab layout (Live Video / Session Details / Sponsors) on the public session page
8. **Waiting room + producer-gated admission** (June 23, 2026) — registered attendees land in a branded lobby (live countdown + optional YouTube/Vimeo holding video + message); a producer clicks **"Open the room / Go live"** on the console (sets the anchor session `LIVE`) to admit everyone into the live view
9. **Per-event viewing mode** — attendees watch via the **Zoom SDK embed** (interactive, native Q&A; counts against Zoom capacity) **or** a **custom HLS stream** (one-way broadcast, scales to ~5,000 via CloudFront — see `LIVE_STREAMING.md`)
10. **Real-time presence tracking** — a heartbeat records who's in the lobby / joined live; the console shows a **"Live now"** roster, and the registrations list shows a **"Joined"** badge (`WebinarPresence` table; distinct from the authoritative post-event `ZoomAttendance`)

Non-webinar events are **untouched** — all logic is gated on `eventType` + a registered viewer.

---

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────┐
│              POST /api/events (eventType=WEBINAR)             │
└──────────────────────────────┬───────────────────────────────┘
                               │ fire-and-forget
                               ▼
              ┌────────────────────────────────┐
              │   provisionWebinar(eventId)    │ idempotent
              │                                │
              │   1. Create EventSession       │
              │   2. createZoomWebinar()       │
              │   3. Persist settings.webinar  │
              │   4. Enqueue email sequence    │
              └────────────────────────────────┘
                               │
                   ┌───────────┴───────────┐
                   ▼                       ▼
           ┌───────────────┐       ┌────────────────┐
           │ EventSession  │       │  ZoomMeeting   │
           │  (anchor)     │ 1:1   │ meetingType=   │
           │               │───────│ WEBINAR        │
           └───────────────┘       └────────────────┘

       Registration flow:
       ─────────────────
       POST /api/public/events/[slug]/register
         ├─ if eventType === WEBINAR
         │    └─ sendWebinarConfirmationForRegistration() ← direct, no cron
         └─ else
              └─ sendRegistrationConfirmation()

       Post-event flow (cron workers):
       ───────────────────────────────
       */5   /api/cron/webinar-recordings ─► syncRecordingForZoomMeeting()
       */10  /api/cron/webinar-attendance ─► syncWebinarAttendance()
                                            └─► syncWebinarEngagement()  (chained)
```

---

## Data model

| Table | Purpose |
|---|---|
| `Event.settings.webinar` (JSON) | `{ autoCreated, sessionId, autoProvisionZoom, waitingRoom, autoRecording, automationEnabled }` |
| `Event.settings.sponsors` (JSON) | `SponsorEntry[]` — `{ id, name, logoUrl?, websiteUrl?, tier?, description?, sortOrder }`. Six tiers: `platinum` / `gold` / `silver` / `bronze` / `partner` / `exhibitor`. Stored as JSON to ship fast; can be promoted to a dedicated table later without breaking this shape |
| `EventSession` | The **anchor session** — one per webinar event, holds the start/end window |
| `ZoomMeeting` | 1:1 with anchor session. Recording fields (`recordingUrl`, `recordingStatus`, …), `lastAttendanceSyncAt`, `lastEngagementSyncAt` |
| `ZoomAttendance` | One row per join/leave **segment**. Unique key `(zoomMeetingId, zoomParticipantId, joinTime)` so rejoin history is preserved |
| `WebinarPoll` + `WebinarPollResponse` | Polls collapsed to one logical poll per webinar (Zoom's report API doesn't distinguish multiple polls) |
| `WebinarQuestion` | Q&A rows. Unique key `(zoomMeetingId, askerName, askedAt)` |
| `ScheduledEmail` | Reused existing model. `emailType` values in `webinar-*` identify sequence rows |

No `Webinar` parent table — `eventType` is the switch. This keeps webinars inside the same core schema instead of branching it.

---

## File map

| Path | Purpose |
|---|---|
| [src/lib/webinar.ts](../src/lib/webinar.ts) | `isWebinar()`, sidebar filter policy, `WebinarSettings` type (incl. `viewingMode` / `lobbyVideoUrl` / `lobbyMessage`) |
| [src/lib/webinar/lobby-video.ts](../src/lib/webinar/lobby-video.ts) | `parseLobbyVideo()` / `isValidLobbyVideoUrl()` — YouTube/Vimeo URL → host-allowlisted embed src (no arbitrary iframe) |
| [src/components/webinar/waiting-room.tsx](../src/components/webinar/waiting-room.tsx) | Branded lobby — countdown + looped holding video + message |
| [src/lib/webinar-provisioner.ts](../src/lib/webinar-provisioner.ts) | Entry point: creates anchor session + Zoom webinar + email sequence |
| [src/lib/webinar-email-sequence.ts](../src/lib/webinar-email-sequence.ts) | Enqueue / clear / immediate-send helpers for the 5-phase sequence |
| [src/lib/webinar-recording-sync.ts](../src/lib/webinar-recording-sync.ts) | Recording state machine |
| [src/lib/webinar-attendance.ts](../src/lib/webinar-attendance.ts) | Attendance state machine + upsert loop |
| [src/lib/webinar-engagement.ts](../src/lib/webinar-engagement.ts) | Polls + Q&A state machine (transactional for polls) |
| [src/lib/zoom/recordings.ts](../src/lib/zoom/recordings.ts) | `getZoomRecordings()` + `pickBestRecordingFile()` |
| [src/lib/zoom/reports.ts](../src/lib/zoom/reports.ts) | `getZoomParticipants()` paginated |
| [src/lib/zoom/polls-qa.ts](../src/lib/zoom/polls-qa.ts) | `getWebinarPollReport()`, `getWebinarQaReport()` |
| [src/app/(dashboard)/events/[eventId]/webinar/page.tsx](../src/app/(dashboard)/events/%5BeventId%5D/webinar/page.tsx) | **Webinar Console** — sticky status bar + Setup/Analytics/Settings tabs; components: `WebinarStatusBar`, `OverviewCard`, `GlobalRefreshButton`, `PanelistsCard` (with Import from Speakers + optimistic UI), `CardLoading`, `CardEmpty` |
| [src/app/(dashboard)/events/[eventId]/sponsors/page.tsx](../src/app/(dashboard)/events/%5BeventId%5D/sponsors/page.tsx) | Sponsors admin editor — draft-based editing with add/edit dialog (logo upload via `PhotoUpload`), up/down reorder arrows, grouped-by-tier list view |
| [src/components/zoom/zoom-web-embed.tsx](../src/components/zoom/zoom-web-embed.tsx) | `ZoomWebEmbed` — dynamic-imported Zoom SDK v6 Component View wrapper. Handles lifecycle (createClient → init → join → leaveMeeting → destroyClient), StrictMode re-mount races via module-level `pendingDestroy` promise, and `connection-change` events for in-meeting Leave |
| [src/components/zoom/zoom-embed.tsx](../src/components/zoom/zoom-embed.tsx) | Iframe fallback (not imported by default) — kept as belt-and-braces if Component View ever regresses |
| [src/app/e/[slug]/session/[sessionId]/page.tsx](../src/app/e/%5Bslug%5D/session/%5BsessionId%5D/page.tsx) | **Public session page** — sticky CTA + Live Video / Session Details / Sponsors tabs. Dynamically imports `ZoomWebEmbed` and `LivePlayer` so the ~3 MB SDK bundle never hits first paint |
| [src/app/api/public/events/[slug]/sessions/[sessionId]/detail/route.ts](../src/app/api/public/events/%5Bslug%5D/sessions/%5BsessionId%5D/detail/route.ts) | Public detail route — returns session metadata + topics (with per-topic speakers) + speakers with bios + sponsors |
| `src/app/api/events/[eventId]/webinar/*` | REST surface: `route.ts` + `/room` (producer open/close) + `/presence` (Live-now roster) + `/sequence` + `/recording/fetch` + `/attendance` + `/engagement` + `/panelists` + `/panelists/sync-speakers` |
| `src/app/api/public/events/[slug]/sessions/[sessionId]/*` | Public per-session routes: `/zoom-join` (gated embed creds) + `/lobby-status` (cached room state) + `/presence` (heartbeat) + `/stream-status` (HLS liveness) |
| `src/app/api/events/[eventId]/sponsors/route.ts` | Admin sponsors route — `GET` returns the list, `PUT` replaces the entire array (Zod-validated, URL scheme whitelisted, normalizes empty strings to undefined) |
| `src/app/api/cron/webinar-recordings` + `/webinar-attendance` | Two cron workers |

---

## State machines

Each of the three sync helpers is an **idempotent state machine**. Running them twice on the same row is a no-op. Both the cron worker and the manual "Sync/Refetch now" button call the same helper — there is no parallel code path.

### Recording (`syncRecordingForZoomMeeting`)

```
AVAILABLE          → short-circuit, return cached URL
FAILED / EXPIRED   → short-circuit (manual refetch resets to NOT_REQUESTED)
no endTime         → pending, skip
<10 min since end  → pending (Zoom encoding lag)
>7 days since end  → EXPIRED
Zoom 404           → NOT_REQUESTED → PENDING, retry next tick
got file           → AVAILABLE, persist URL/passcode/duration
```

### Attendance (`syncWebinarAttendance`)

```
<30 min since end / >30 days   → pending
Zoom 404                       → pending (report not compiled)
zero participants              → mark synced with zero counts
got participants               → upsert per segment, mark lastAttendanceSyncAt
```

### Engagement (`syncWebinarEngagement`)

```
not webinar type               → skip
<30 min / >30 days             → pending
fetch polls + Q&A in parallel (Promise.all)
polls:  transaction → find-or-create WebinarPoll → delete+create responses
Q&A:    upsert by (meetingId, askerName, askedAt); skip rows w/ missing create_time
mark lastEngagementSyncAt
```

---

## Panelist flow

Two entry points:

```
Manual add (inline form, name + email)
  └─ useAddWebinarPanelist — optimistic onMutate inserts row instantly
      └─ POST /api/events/[eventId]/webinar/panelists  { name, email }
          ├─ denyReviewer + 30/hr rate limit + Zod
          ├─ resolveAnchorZoomMeeting()  ← event + settings.webinar.sessionId → ZoomMeeting
          └─ addWebinarPanelists(orgId, zoomMeetingId, [{name, email}])
              └─ Zoom POST /webinars/{id}/panelists

Import from Speakers (bulk)
  └─ useSyncSpeakersToPanelists
      └─ POST /api/events/[eventId]/webinar/panelists/sync-speakers
          ├─ denyReviewer + 30/hr rate limit (shared bucket w/ single-add)
          ├─ resolveAnchorZoomMeeting()
          ├─ Parallel fetch: SessionSpeaker[] + Zoom listWebinarPanelists
          ├─ Dedup by lowercased email (no 409 Conflict on re-import)
          └─ addWebinarPanelists(orgId, zoomMeetingId, filtered)
```

Both mutations invalidate the `webinarPanelists` React Query cache on settle. Remove uses the same `resolveAnchorZoomMeeting` helper + `removeWebinarPanelist(orgId, zoomMeetingId, panelistId)`.

**Optimistic UI**: optimistic rows carry an `id` prefixed with `optimistic:` (exported as `OPTIMISTIC_PANELIST_PREFIX`). The PanelistsCard detects this prefix and renders rows greyed out + italic + spinner, disables the remove button, then reconciles via the post-settle refetch. Rollback on error restores the previous query data.

---

## Cron workers

| Cron | Frequency | Candidate window | Re-sync rule |
|---|---|---|---|
| `webinar-recordings` | `*/5 * * * *` | session ended 10 min – 7 days ago | Status must be `NOT_REQUESTED` or `PENDING` |
| `webinar-attendance` (chains engagement) | `*/10 * * * *` | session ended 30 min – 30 days ago | Never synced OR (last synced >1h ago AND session ended <24h ago) |

Both use the same hygiene pattern:
- `take: 10` candidates per tick
- **Serial** loop, never parallel (Zoom has a 30 req/s rate limit)
- 500ms delay between rows when `batch.length > 3`
- **Per-row try/catch** so one bad row can't kill the tick
- Structured logs with `durationMs` on every state transition

The **24-hour re-sync cap** on attendance is important: without it, every webinar in the 30-day fetch window would be re-polled hourly forever (~97% reduction in post-48h Zoom traffic).

**EC2 crontab:**
```
*/5  * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://events.meetingmindsgroup.com/api/cron/webinar-recordings
*/10 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://events.meetingmindsgroup.com/api/cron/webinar-attendance
```

---

## Email sequence

5 templates in [src/lib/email.ts](../src/lib/email.ts) `DEFAULT_TEMPLATES`:

| Slug | When fires |
|---|---|
| `webinar-confirmation` | Immediately on registration (direct, not via cron) |
| `webinar-reminder-24h` | 24 h before anchor session start |
| `webinar-reminder-1h` | 1 h before start |
| `webinar-live-now` | At start time |
| `webinar-thank-you` | 30 min after end |

Variables: `{{joinUrl}}`, `{{passcode}}`, `{{webinarDate}}`, `{{webinarTime}}`, `{{recordingUrl}}` + conditional `{{passcodeBlock}}` / `{{recordingBlock}}` HTML fragments.

**Enqueueing** — `enqueueWebinarSequenceForEvent()` creates 4 future `ScheduledEmail` rows (the immediate confirmation is sent directly from the register route). Past-dated phases are dropped; re-enqueue is idempotent.

**Cron worker reuse** — webinar emails piggyback on the existing `/api/cron/scheduled-emails` worker; no new cron needed. `executeBulkEmail()` detects `webinarEmailType.startsWith('webinar-')` and enriches `vars` with the anchor Zoom meeting's fields in **one extra query per scheduled row**, not per recipient.

---

## Webinar Console (UI)

The console at `/events/[eventId]/webinar` is organized top-down:

**1. Header row** — page title + `GlobalRefreshButton` (parallel-fires recording + attendance + engagement syncs; disabled until session ends) + `Re-run provisioner`.

**2. Sticky status bar** — `WebinarStatusBar` component, color-coded by status (blue = Scheduled, red pulsing = Live, gray = Ended). Always visible above the fold. Contents:
- Status icon + pill
- Session window ("Mar 14 · 2:00 – 3:00 PM")
- Inline join URL + copy button + passcode badge
- Context-aware primary action:
  - `Scheduled` / `Live` → **Start as Host**
  - `Ended, no recording` → **Refetch recording**
  - `Ended, recording ready` → **Watch Replay**
- `!hasZoom` → collapses to "Configure Zoom" banner with a "Run provisioner" button

**3. Tabs — Setup / Analytics / Settings.** Default tab is status-driven:
- `scheduled` / `live` → **Setup**
- `ended` → **Analytics**

User can always switch. No URL pin (local state).

### Setup tab
- **Overview card** — merged Anchor Session + Zoom details (previously two separate cards). Session name/status/times on top, Zoom details below a divider. Start as Host + Open Public Page buttons.
- **Panelists card** — inline add form (name + email) + **Import from Speakers** button that pulls all anchor-session speakers with emails in one call. Optimistic UI: new panelist row appears instantly (greyed out + spinner), then reconciles after Zoom returns. Dedup against existing panelists so re-import is safe.
- **Email Sequence card** — per-phase status icons (pending / processing / sent / failed / cancelled) + scheduled/sent timestamps + Re-enqueue button.

### Analytics tab
- **Recording card** — 5 UI states (`AVAILABLE` / `PENDING` / `FAILED` / `EXPIRED` / `NOT_REQUESTED`). Refetch button gated on session-ended.
- **Attendance card** — 4-tile KPI grid (registered / attended / rate / avg watch) + attendee table + CSV export + Sync now button.
- **Polls card** — per-poll view with horizontal bar-chart distribution.
- **Q&A card** — searchable Q&A list with answer blocks.

### Settings tab
- **Webinar Settings card** — auto-provision toggle, waiting room, auto-recording, passcode. Lazy-init local state so the form reflects loaded server values without setState-in-effect.

### Consistent loading + empty states
- `CardLoading` — centered spinner, `py-8`
- `CardEmpty` — dashed border box with message + optional CTA button

Every card uses these primitives instead of ad-hoc markup so scanning feels calm.

### Sidebar filtering
`webinarModuleFilter()` hides Accommodation, Check-In, Promo Codes, Abstracts, Reviewers on WEBINAR events; non-webinar events drop items flagged `webinarOnly: true`.

---

## Public session page + in-page Zoom embed

The public session page at `/e/[slug]/session/[sessionId]` is where attendees watch the webinar. As of the April 14 revamp, they **watch without leaving our domain** — Zoom's Component View mounts inside our page.

### Layout

```
┌─────────────────────────────────────────────┐
│ Event banner + back link                    │
├─────────────────────────────────────────────┤
│ Session title + status + time + location    │
├─────────────────────────────────────────────┤
│ ╔═════ STICKY CTA (top-0 z-10) ═══════════╗ │
│ ║  Scheduled/Live/Ended banner            ║ │
│ ║  Primary action: Join / Replay / Ended  ║ │
│ ╚═════════════════════════════════════════╝ │
├─────────────────────────────────────────────┤
│ [Live Video] [Session Details] [Sponsors]   │ ← tabs
├─────────────────────────────────────────────┤
│ Tab content                                 │
└─────────────────────────────────────────────┘
```

### Sticky CTA states

- **Upcoming, not yet joinable** → amber "Session hasn't started, opens at X" banner
- **Upcoming & joinable** (within 15 min) → blue "Ready to join" + `Join Webinar` button
- **Live** → red pulsing dot + "Live now" + `Join Webinar` button
- **In meeting** (user clicked Join, embed mounted) → green "In meeting" badge + outline `Leave` button that unmounts the embed
- **Ended + recording `AVAILABLE`** → emerald "Recording available" + `Watch Replay` button
- **Ended, no recording** → muted "session has ended" banner

The sticky CTA uses `position: sticky; top: 0; z-10` with a gradient-blur background so content scrolls under it cleanly.

### Tabs

**Tab 1 — Live Video** (default):
- `LivePlayer` (HLS) when the webinar has live streaming enabled (RTMP → MediaMTX → HLS flow from the original Phase 4 work)
- `ZoomWebEmbed` (see below) — only mounts when the user clicks Join in the sticky CTA. This keeps the ~3 MB SDK bundle off the initial paint
- Recording replay card when session ended + recording available
- Recording processing placeholder when session ended + recording pending
- "Ready to join?" / "Session hasn't started yet" placeholders for the scheduled/upcoming states

**Tab 2 — Session Details**:
- Session description (with `whitespace-pre-wrap` for line breaks)
- **Topics** list (numbered, with duration + per-topic speaker chips). Topics come from `SessionTopic` + `TopicSpeaker` — previously only visible in the admin UI, now exposed publicly via the detail API
- **Speakers** grid with photos, jobTitle, organization, and full bios (line 2 previously visible only in the admin, now included in the public API)
- Empty state when a session has none of the three

**Tab 3 — Sponsors**:
- Grouped by tier (platinum → gold → silver → bronze → partner → exhibitor)
- Each sponsor renders as a card with logo, name, optional description. The whole card is a link if `websiteUrl` is set (opens in a new tab, `rel="noopener noreferrer"`)
- Clean empty state for events with no sponsors configured

### ZoomWebEmbed component

[src/components/zoom/zoom-web-embed.tsx](../src/components/zoom/zoom-web-embed.tsx) wraps the Zoom SDK v6 `@zoom/meetingsdk/embedded` entry.

**Why Component View works under React 19** — the `/embedded` entry is a **UMD bundle** (`zoomus-websdk-embedded.umd.min.js`) that ships its own React 18 + ReactDOM internally. That bundled React lives entirely inside the SDK's own DOM subtree and never touches our app's React 19 fiber tree. The two Reacts coexist without knowing about each other. This is the key difference from Client View (the non-embedded entry), which tries to render into the host app's React tree and therefore collides.

**Lifecycle**:
```
createClient() → init({ zoomAppRoot, language, patchJsMedia, leaveOnPageUnload })
  → client.on("connection-change", ...)
  → join({ sdkKey, signature, meetingNumber, password, userName })
  → [user watches]
  → leaveMeeting() → destroyClient()   (either user click or unmount)
```

**Critical safety mechanisms**:

1. **Dynamic import** — `await import("@zoom/meetingsdk/embedded")` inside `useEffect`, never at module top. Combined with the parent's `next/dynamic({ ssr: false })` and the user-click gate, the 3 MB bundle is fully deferred.

2. **StrictMode-safe cleanup** — a module-level `pendingDestroy: Promise<void> | null` serializes cleanup across re-mounts. React 19 StrictMode double-invokes effects in dev:
   - Effect 1 → mount → createClient → (async work)
   - Cleanup 1 → schedules async destroy, stores the promise in `pendingDestroy`
   - Effect 2 → mount → **awaits `pendingDestroy`** before creating a new client
   Without this, cleanup 1's destroy can race effect 2's createClient and leave a dangling handle.

3. **`connection-change` subscription** — the SDK emits this event with `{ state: "Closed" }` when the user clicks Zoom's in-meeting Leave button. We call `onLeave()` from there so the parent can unmount. Without this, the embed would tear itself down internally while the parent still thought the user was in the meeting, leaving a black box.

4. **Fallback error state** — any error during `init` or `join` flips to an error overlay with an "Open in Zoom app instead" button that opens `joinUrl` in a new tab (the generic Zoom web client). Guarded against missing `joinUrl`.

5. **User-initiated mount** — the parent page keeps `isJoining` state as `false` on page load. The embed only mounts when the user clicks Join. This means:
   - Users who land on the page to read session details pay zero SDK cost
   - The ~50 MB of WASM + AV assets that Zoom lazy-loads from `source.zoom.us` only hit the network after the click

### API contract

The public detail route ([detail/route.ts](../src/app/api/public/events/%5Bslug%5D/sessions/%5BsessionId%5D/detail/route.ts)) returns:

```ts
{
  event: { name, slug, eventType, bannerImage, organization },
  session: {
    id, name, description, startTime, endTime, location, capacity, status, track,
    speakers: [{ id, firstName, lastName, jobTitle, organization, photo, bio, role }],
    topics: [{ id, title, sortOrder, duration, speakers: [{ id, firstName, lastName, photo, jobTitle, organization }] }],
    zoomMeeting: { recordingUrl, recordingPassword, recordingStatus } | null,
  },
  sponsors: SponsorEntry[],
}
```

The `zoom-join` route ([zoom-join/route.ts](../src/app/api/public/events/%5Bslug%5D/sessions/%5BsessionId%5D/zoom-join/route.ts)) returns either:

```ts
// mode: "sdk" — frontend embeds ZoomWebEmbed
{ mode: "sdk", sdkKey, signature, meetingNumber, passcode, joinUrl, ... }
// mode: "url" — frontend opens joinUrl in a new tab
{ mode: "url", joinUrl, passcode, ... }
```

The signature is generated via `generateZoomSignatureForOrg(orgId, meetingNumber, 0 /* attendee */)`. It's a short-lived JWT (~2 hours); the frontend error state catches expired signatures and falls back to the Zoom app link.

### Sponsors admin editor

Organizers manage sponsors at `/events/[id]/sponsors`:
- Outer page component waits for the `GET` response, then mounts `SponsorsEditor` with `initialSponsors` as a prop. Lazy-init draft state from props avoids the project-wide `react-hooks/set-state-in-effect` lint rule
- `PUT` replaces the entire array (single atomic write, simpler than row-level CRUD for a settings JSON field). The server reassigns `sortOrder` from the array index so client-side drag history doesn't matter
- URL schemes are whitelisted server-side: `logoUrl` accepts `http(s)://` or `/` (for locally-uploaded files), `websiteUrl` requires absolute `http(s)://`. Rejects `javascript:` / `data:` URLs
- `SponsorEntry` type lives in `src/lib/webinar.ts` and is re-exported from `src/hooks/use-api.ts` — single source of truth

---

## Waiting room, producer-gated admission & real-time presence (June 23, 2026)

The attendee live-day flow is **producer-controlled**: registrants wait in a branded lobby until a producer opens the room, then are admitted into the event's chosen viewing mode. None of this involves BigMarker — attendees watch on our gated session page.

### Config (`Event.settings.webinar` JSON — no schema change)
`WebinarSettings` (in `src/lib/webinar.ts`) gained:
- `viewingMode?: "zoom" | "hls"` — Zoom SDK embed (interactive, native Q&A) vs custom HLS stream (one-way, 5k via CDN). Default `"zoom"`.
- `lobbyVideoUrl?: string` — a YouTube/Vimeo holding video, looped + muted in the lobby. Parsed/host-allowlisted by `src/lib/webinar/lobby-video.ts` → only `youtube-nocookie.com`/`player.vimeo.com` embeds are ever produced (no arbitrary `<iframe src>`). Validated on the webinar PUT.
- `lobbyMessage?: string` — optional copy shown under the holding video.

Edited via the **LobbyCard** in the Webinar Console Setup tab.

### "Open the room" (the admit signal)
- `POST /api/events/[eventId]/webinar/room` `{ open }` (`denyReviewer` + org-scoped) sets the **anchor `EventSession.status`** → `LIVE` (open) / `COMPLETED` (close). The session status IS the room-open source of truth — no new column. Re-openable.
- The console LobbyCard renders the **"Open the room / Go live" ↔ "Close the room"** button + a live `Room OPEN/closed` badge.

### Lobby + auto-admit (public page)
- `src/components/webinar/waiting-room.tsx` — branded lobby: live countdown + holding-video iframe + message. Shown when `eventType === WEBINAR` + the viewer is a confirmed registrant (`authState === "ok"`) + the room is **not** open + not past end (`showWaitingRoom`, gated on `!isPast`, NOT `lobby.ended`, so a mid-event close returns attendees to the lobby).
- `GET .../sessions/[sessionId]/lobby-status` — **public, single query (session joined to event), 3s per-container micro-cache** so 5k pollers collapse to ~1 DB hit / 3s. Returns `{ roomOpen, ended, viewingMode, lobbyVideoUrl, lobbyMessage, startsAt, endsAt }`. DRAFT events auto-open (for testing).
- The session page polls lobby-status (~15–20s, jittered). On `roomOpen → true` it **re-mints** join creds via `zoom-join` (a signature minted at page load is likely expired after a long lobby wait) and, for `zoom` mode, auto-mounts the embed (with a "Join now" CTA gesture fallback); `hls` mode renders `LivePlayer`. The admit latch (`admittedRef`) resets on close so a re-open re-admits, and releases on a failed re-fetch so the next poll retries.
- **Overrun:** the HLS view stays mounted past the scheduled end while `roomOpen` (`liveWindowActive = !isPast || (isWebinarEvent && roomOpen)`) — webinars routinely overrun.

### Real-time presence (`WebinarPresence` table)
- Additive migration `20260623000000_add_webinar_presence` — one row per `(sessionId, registrationId)` (`@@unique`), plus a write-once `Registration.webinarFirstJoinedAt`.
- `POST .../sessions/[sessionId]/presence` heartbeat (auth + registration-gated; org staff skipped) — **`upsert`** (INSERT … ON CONFLICT, no interactive transaction) so two-tab first-beats can't collide on the unique key and no pooled connection is held. Escalates `lobby→joined` only (never downgrades). The page beats every ~30–40s while open, paused when the tab is hidden.
- `GET /api/events/[eventId]/webinar/presence` (org-scoped) → registrants present in the last 60s, split lobby/joined → the console **"Live now"** card. The registrations list shows a **"Joined"** badge (`webinarFirstJoinedAt`). **This is OUR-page presence, not Zoom viewing** — keep it distinct from the post-event `ZoomAttendance`.

### 5k stream delivery
HLS playback is **CDN-aware** via `HLS_CDN_BASE` (CloudFront) with the app origin as fallback (emitted by `stream-status` + `zoom-join`); `stream-status` keeps probing the MediaMTX origin internally (cached 3s so 5k pollers share one probe). `LivePlayer` fails over CDN → origin once on a fatal error, then resumes the recovery poll (auto-reconnect) rather than dead-ending. See `LIVE_STREAMING.md §13` for the operator-run CloudFront + Singapore-DR failover provisioning.

---

## Conventions & guarantees

- **Idempotency everywhere** — every sync helper short-circuits on terminal states, and every write path (provisioner, email enqueue, attendance upsert) is safe to replay
- **Observability** — every state transition emits a structured log with `zoomMeetingDbId` + `durationMs`. Grep `webinar-recording:` or `webinar-attendance:` or `webinar-engagement:` to trace a single row
- **Security** — every POST/PUT/DELETE route uses `denyReviewer` + `checkRateLimit` + Zod + `apiLogger.warn` on rate-limit rejection (per CLAUDE.md)
- **Fire-and-forget provisioning** — `provisionWebinar()` is called with `.catch()` from `POST /api/events` so Zoom API failures never block event creation
- **One-way imports** — webinar code imports from core; core never imports from webinar. Extractable into a standalone service later

---

## Edge cases & known limitations

| Scenario | Behavior |
|---|---|
| Zoom not configured for the org | Event creates cleanly; provisioner logs `zoom-not-configured-skipping-auto-provision`; Webinar Console shows "Configure Zoom" CTA |
| Anchor session has no `endTime` | Both crons emit `no-end-time` warn and skip the row |
| Duplicate concurrent engagement syncs | Poll section is wrapped in a DB transaction so find-or-create is atomic — no duplicate "Webinar Poll" rows |
| Rejoin in same session | `ZoomAttendance` stores one row per segment; `peakConcurrent` KPI is computed via sorted edge-event sweep to handle this correctly |
| Multiple polls in same webinar | Collapsed to a single logical `WebinarPoll` — Zoom's report API doesn't distinguish, and the Zoom dashboard collapses the same way |
| Q&A without `create_time` | Row skipped + logged — avoids uniqueness collisions from `Date.now()` fallback |
| Registrant cancels after reminder is scheduled | Cron re-evaluates `{ status: CONFIRMED }` filter at fire time, so cancelled registrants are naturally excluded |
| Recording not ready at thank-you fire time | Template renders "recording coming soon" fallback via `{{recordingBlock}}` |
| "Forbidden" from email provider | `executeBulkEmail` now fetches per-event sender fields (`emailFromAddress` etc.) — silently fixed every bulk-email type |
| Import from Speakers run twice | `sync-speakers` fetches the existing Zoom panelist list in parallel with session speakers and dedups by lowercased email — no 409 Conflict on re-import. Response surfaces `skippedAlreadyPanelist` count |
| Panelist add error after optimistic insert | `onError` rollback restores the prior query cache; add form is re-populated with the attempted values so the user doesn't retype |
| Zoom SDK signature expired before user clicks Join | `client.join()` rejects; embed flips to error state with `"Open in Zoom app instead"` fallback button. Future improvement: refetch the signature on Join click instead of page load |
| User clicks Zoom's in-meeting Leave button | SDK fires `connection-change` with `state === "Closed"` → `onLeave()` fires on the parent → `setIsJoining(false)` → React unmounts the embed cleanly |
| StrictMode double-mounts the embed in dev | Module-level `pendingDestroy` promise serializes destroy-then-mount across the double invoke. Effect 2 awaits cleanup 1's destroy before creating a new client |
| Sponsor `logoUrl` contains `javascript:` URL | Server Zod schema rejects with 400. Only `http(s)://` or `/` accepted |
| Admin saves sponsors with new `sortOrder` values | Server reassigns from array index, so client-side reorder history is thrown away and both sides agree after the roundtrip |

---

# Interview deep-dive topics

This section addresses the architectural questions most likely to come up in a system-design interview about this module.

## 1. Why is there no `Webinar` table?

Two valid approaches were considered:

**Option A (rejected)**: A parallel `Webinar` model with its own `sessions`, `attendees`, etc. — clean separation, but every cross-cutting feature (email sequence, communications, media library, contacts) would need duplicate logic or complex polymorphic joins.

**Option B (chosen)**: Use the existing `Event` + `EventSession` + `ZoomMeeting` models and gate behavior on `eventType === 'WEBINAR'`.

**Trade-off**: Option B means a WEBINAR event reuses 90% of the core schema (registrations, tickets, emails, speakers) and only adds the thin layer of webinar-specific tables (`ZoomAttendance`, `WebinarPoll`, `WebinarQuestion`). Feature reuse is the main reason — a registrant who registers for a webinar is still a `Registration`, so the registrant portal, payment flow, and CSV import work unchanged.

**When Option A would win**: if webinars had fundamentally different data (e.g. per-second watch events, 10M+ attendees, required horizontal sharding by webinar).

## 2. Why serial cron processing? Wouldn't `Promise.all` be faster?

Zoom's API is rate-limited to ~30 requests/second per account. Parallel `Promise.all` across 10 rows × 2 API calls per row = 20 concurrent requests. Fine in isolation, but:

1. **Thundering herd after outages** — if the cron misses ticks during a DB outage, the next tick has a backlog. Parallel burst → rate-limit hit → exponential backoff → more missed ticks
2. **Bad rows can't be isolated** — `Promise.all` rejects on the first failure; `Promise.allSettled` works but makes error accounting more complex
3. **Debugging** — sequential logs with `durationMs` per row are trivially greppable; parallel logs interleave

Serial with a 500ms delay between rows (only when batch > 3) gives us:
- Steady ~2 req/s average
- Natural circuit-breaker (one bad row doesn't starve others)
- Debuggability

For scale, the fix is not parallelism — it's **more cron ticks with smaller batches** (e.g. `take: 5` every 2 minutes instead of `take: 10` every 5 minutes).

## 3. How is idempotency guaranteed?

Three different techniques, one per sync helper:

| Helper | Technique |
|---|---|
| Recording | **State machine** — `AVAILABLE` / `FAILED` / `EXPIRED` short-circuit on entry. The `PENDING → AVAILABLE` transition is a single Prisma `update` which is atomic by itself |
| Attendance | **Upsert by natural key** — `(zoomMeetingId, zoomParticipantId, joinTime)`. The triple is stable across Zoom report re-fetches, so re-running produces the same DB state |
| Engagement (polls) | **Transaction** — find-or-create + deleteMany + createMany in `$transaction`. Without the transaction, two concurrent syncs could both `findFirst → not found → create`, producing duplicate "Webinar Poll" rows (Postgres nullable unique keys don't enforce NULL uniqueness) |

**Why not use a distributed lock instead?** For this scale, a transaction is simpler and has lower ops overhead. If we had 100+ concurrent workers, a Redis lock with a lease would become more attractive.

## 4. Why store per-segment attendance rows instead of one row per attendee?

Zoom returns one row per join/leave **segment**. A single attendee who disconnects and rejoins appears as two rows with different `join_time` values. You have two options:

**Option A**: Collapse to one row per attendee, summing duration. Simpler to display, loses history.

**Option B (chosen)**: Store one row per segment with unique key `(zoomMeetingId, zoomParticipantId, joinTime)`.

Option B is required for **peak concurrent** — the KPI answers "what was the maximum number of people watching at any moment?" Computing peak needs a per-segment join/leave timeline, which Option A loses.

**Algorithm for peak concurrent**: build a sorted array of `{ time, delta }` edges (+1 for join, -1 for leave), walk it tracking a running counter, return the max. O(n log n) on sort, O(n) on sweep. Corner case: back-to-back leave/rejoin at the same timestamp is ordered leave-before-join so concurrent count never artificially spikes.

## 5. Why not use a job queue (BullMQ, SQS) instead of crons?

The cron approach has real downsides:
- Fixed latency (up to the cron interval)
- No retry with exponential backoff
- No dead-letter queue
- Can't scale horizontally

But for this workload, it's the right call:
- **Volume is small**: typical orgs run 1-10 webinars/month
- **Latency is tolerable**: users don't expect real-time recording URLs
- **Ops simplicity**: EC2 crontab is already there for other crons (`scheduled-emails`, etc.)
- **Monolith constraint**: introducing a queue means introducing Redis, a worker process, and a new deploy target

**When to migrate**: if we start running 100+ concurrent webinars or if watch-time analytics become real-time. The sync helpers are already factored out, so a migration would swap the cron route for a queue consumer — no changes to the sync logic itself.

## 6. What happens if the provisioner crashes mid-execution?

Walk through the failure modes:

1. **Crash after creating `EventSession`, before creating `ZoomMeeting`**: Event has an orphan anchor session. Running provisioner again finds `settings.webinar.sessionId`, verifies it still exists, and short-circuits with `already-attached: false`. User can click "Re-run provisioner" in the console to retry Zoom creation.

2. **Crash after creating ZoomMeeting, before persisting `settings.webinar`**: Event has a ZoomMeeting but no settings pointer. The next provisioner run creates **another** anchor session + another Zoom meeting. This is the worst case — two webinars on Zoom.

   **Mitigation (not implemented)**: wrap the whole provisioner in a DB transaction, creating the session and the settings.webinar update atomically. Not currently worth it because the provisioner is fire-and-forget from event creation; failures are rare and visible in logs.

3. **Crash after persisting settings.webinar, before enqueueing email sequence**: next provisioner run is idempotent no-op; email sequence re-enqueue is safe because `enqueueWebinarSequenceForEvent` checks for existing `webinar-*` rows first.

The real guarantee is: **the user can always click "Re-run provisioner"** and the system will converge toward a valid state. Idempotency is the crash-safety net.

## 7. How do you prevent duplicate email sends from the scheduled cron?

The existing `ScheduledEmail` cron (reused by the webinar sequence) uses an **atomic claim**:

```sql
UPDATE "ScheduledEmail"
SET status = 'PROCESSING'
WHERE id = ? AND status = 'PENDING'
```

Only the worker whose `UPDATE` affected a row proceeds. A second worker racing the first sees 0 rows affected and skips. There's also a "stuck processing" sweeper that flips rows back to `FAILED` after 10 minutes so crashed workers don't hold rows hostage.

For the **immediate** webinar-confirmation (sent directly from the register route, not via cron), there's no claim — we rely on the register route itself being idempotent (same user clicking submit twice would already fail on `Registration` unique constraints before reaching the email).

## 8. How is the "peak concurrent attendees" KPI calculated correctly when attendees rejoin?

The naive approach — count distinct `zoomParticipantId` values where `joinTime < T < leaveTime` — is O(n × points-to-check) and gets the answer wrong if you check at fixed intervals.

The correct approach is an **edge-event sweep**:

```typescript
const edges: Edge[] = [];
for (const row of attendanceRows) {
  edges.push({ time: row.joinTime.getTime(), delta: +1 });
  if (row.leaveTime) edges.push({ time: row.leaveTime.getTime(), delta: -1 });
}
// Sort: time asc, leave (-1) before join (+1) at same instant.
edges.sort((a, b) => a.time - b.time || a.delta - b.delta);

let current = 0, peak = 0;
for (const e of edges) {
  current += e.delta;
  if (current > peak) peak = current;
}
```

Complexity: O(n log n) sort, O(n) sweep, O(n) memory. Handles rejoins, dropouts, and back-to-back segments correctly. The tie-breaker (leave before join at the same timestamp) ensures a user who rejoins instantly doesn't inflate the peak.

## 9. How is extensibility preserved? (Decouplability boundary)

All webinar code lives under tightly-scoped namespaces:

```
src/lib/webinar*                          ← helpers + state machines
src/lib/zoom/{recordings,reports,polls-qa}.ts  ← Zoom API clients
src/app/api/events/[eventId]/webinar/*    ← dashboard REST
src/app/api/cron/webinar-*                ← cron workers
src/app/(dashboard)/events/[eventId]/webinar/  ← UI
```

Rule: **webinar imports from core; core never imports from webinar**. Violations are caught by manual review (no lint rule yet). To extract into a standalone microservice:

1. Copy the namespaced files into a new repo
2. Replace direct Prisma calls in webinar code with HTTP calls to an `ea-sys-core` API
3. Swap the in-process provisioner invocation (`POST /api/events` → `provisionWebinar(eventId)`) for a queue publish
4. Point the crontab at the new service

Estimated effort: 1-2 days. The boundaries are already drawn — extraction is a plumbing job, not a rewrite.

## 10. Why are polls collapsed to one logical poll per webinar?

Zoom's `/report/webinars/{id}/polls` endpoint returns a **flat list of (participant, question, answer) tuples**, with no poll-id field to distinguish multiple polls run during the same webinar. You can't reconstruct the original poll boundaries from this report alone.

Zoom's own dashboard collapses the same way — it shows all poll questions and answers in one list per webinar.

**Alternative**: call the `/webinars/{id}/polls` (definitions) endpoint first to get poll ids + question lists, then match answers back. Would require a join on the question string, which is fragile. Not worth the complexity for a feature where Zoom itself doesn't distinguish.

**Future-proofing**: `WebinarPoll.zoomPollId` is nullable and the schema supports multiple `WebinarPoll` rows per `ZoomMeeting` if we ever want to split them.

## 11. How does the Zoom SDK embed work under React 19 when the SDK bundles React 18?

The key insight is that **Zoom's `@zoom/meetingsdk` exposes two entry points**:

- `@zoom/meetingsdk` (index.js) — the **Client View**. This is a React component that tries to render into your app's React fiber tree. Under React 19, hooks fail because the SDK's bundled React 18 and our React 19 see different versions of `useState` and the reconciler throws the classic "you might have more than one copy of React" errors.
- `@zoom/meetingsdk/embedded` (embedded.js) — the **Component View**. This is a UMD bundle (`zoomus-websdk-embedded.umd.min.js`) that exposes `ZoomMtgEmbedded` as a module-level singleton. It ships its own React 18 + ReactDOM + Redux internally, but they all live inside the UMD closure — they never interact with the host app's React tree. Zoom's SDK mounts its UI into an HTMLElement you hand it (`init({ zoomAppRoot: el })`) and does all rendering inside that subtree.

**Trade-off**: Component View's API is factory-style (`createClient().init().join()`) instead of declarative React props. You lose JSX composition but gain version isolation. For our use case — a full-panel embedded webinar viewer — that's a great trade.

**Why we didn't discover this in the first audit**: the first audit read `package.json` and saw `react: "18.2.0"` in the SDK's peerDependencies and concluded "blocked". It didn't distinguish between the two entry points. When the second audit ran `npm pack @zoom/meetingsdk@6.0.0 --dry-run` and saw both `index.js` and `embedded.js` listed separately, the isolation became obvious.

**When Client View would come back**: only if a future Zoom SDK version drops the bundled React entirely and uses our host React. Until then, stick with Component View via `ZoomWebEmbed`.

## 12. What race conditions does the embed guard against, and how?

Three concrete races were identified during audit:

**Race 1: StrictMode double-invoke.** In React 19 dev mode, effects run twice:
1. Effect 1 → `mount()` starts (async: import, createClient, init, join)
2. Cleanup 1 → schedules async destroy (`leaveMeeting()` + `destroyClient()`)
3. Effect 2 → `mount()` starts again

The naive cleanup fires destroy as a fire-and-forget async IIFE. Effect 2 then calls `destroyClient()` → `createClient()` immediately. If cleanup 1's destroy runs *between* effect 2's createClient and init, the new client handle becomes invalid.

**Fix**: module-level `pendingDestroy: Promise<void> | null`. Cleanup 1 assigns to it, and effect 2 awaits it at the start of `mount()`. Order is now deterministic.

**Race 2: Parent thinks user is in meeting, but Zoom says otherwise.** When the user clicks Zoom's own in-meeting Leave button, the SDK tears down its UI but the parent's `isJoining` state is still `true`. User sees a black box.

**Fix**: subscribe to `client.on("connection-change", payload => ...)`. When `payload.state === "Closed"`, call `onLeave?.()` which the parent uses to flip `isJoining` to `false` and React unmounts the component.

**Race 3: Stale `onLeave` callback.** The `useEffect` is deliberately mount-once (`[]` deps) because prop changes would require a full re-mount anyway. But `onLeave` is closed over from the first render — if the parent re-renders with a different callback, the embed still fires the original one.

**Fix**: `onLeaveRef = useRef(onLeave); onLeaveRef.current = onLeave;`. The effect reads `onLeaveRef.current?.()` so it always hits the latest handler without forcing a re-mount.

## 13. Why is sponsor data in `Event.settings.sponsors` JSON instead of a dedicated Prisma table?

Same pattern as `Event.settings.webinar` — the JSON escape hatch. Trade-offs:

**Pros**:
- **Zero migration cost**. Ships in one commit. No foreign keys to manage, no join complexity, no cascading delete semantics.
- **Atomic updates**. `PUT /api/events/[id]/sponsors` replaces the whole array in a single write. No row-by-row diffing.
- **Tight colocation**. Reading a sponsor list is a field-read on the event row, not a join.

**Cons**:
- **No cross-event queries**. "Which events did Acme sponsor?" is now a `jsonb_array_elements` query instead of a simple `WHERE sponsorId`. Acceptable — we don't need that query today.
- **No row-level permissions**. The entire list is one Prisma write; you can't have per-sponsor edit locks.
- **Limited indexing**. GIN indexes on JSON work but are heavier than normal B-trees. Not a concern at our expected scale (<100 sponsors per event).

**When to promote**: the moment we want to query sponsors independently of events, or add sponsor-level analytics (click tracking, impressions), or share sponsors across multiple events. Until then, JSON is the right call.

**Upgrade path**: the `SponsorEntry` type shape matches what a future `Sponsor` Prisma table would hold. A one-time migration script would walk `Event.settings.sponsors` and insert into the new table, then drop the JSON field. No application code changes beyond the Prisma read/write calls.

---

## Verification checklist

| Action | Expected |
|---|---|
| Create WEBINAR event | DB: `settings.webinar.autoCreated=true`, one EventSession, one ZoomMeeting. Sidebar hides Accommodation/Check-In/etc, shows Webinar Console |
| Register a test user | Immediate `webinar-confirmation` email with join URL. DB: 4 `ScheduledEmail` rows with `emailType` in `webinar-*` |
| Trigger scheduled-emails cron | Due rows flip PENDING → SENT |
| End test webinar, run recordings cron | `recordingStatus=AVAILABLE`, URL populated. Public session page shows "Watch Replay" |
| Run attendance cron (30 min post-end) | `ZoomAttendance` rows exist, Console Attendance tab shows KPIs + CSV export works. Engagement chains automatically |
| Webinar Console → Panelists → Add | Panelist appears in Zoom web UI |
| **Sponsors** → Admin editor → add 3 across tiers → Save | DB: `event.settings.sponsors` populated with normalized `sortOrder`. Dirty-state discard works |
| **Public session page, scheduled** | Sticky CTA shows "Session hasn't started" with joinableAt time. Tab 1 placeholder matches. Tabs 2+3 render. Sponsors tab shows cards grouped by tier |
| **Public session page, live** | Sticky CTA shows "Live now" + `Join Webinar`. Click it → `ZoomWebEmbed` mounts in Tab 1 in a 16:9 container → video plays in-page. Click the `Leave` button in the sticky CTA → embed unmounts cleanly, CTA returns to Join state |
| **Public session page, live, click Zoom's in-meeting Leave button** | `connection-change` fires → parent receives `onLeave` → embed unmounts automatically, no black box |
| **Public session page, ended with recording** | Sticky CTA shows "Recording available" + `Watch Replay` (opens in new tab) |
| **Public session page, session details tab** | Description, numbered topics with per-topic speakers, speakers grid with bios and photos. Old right sidebar gone |
| Lint + typecheck | `npm run lint && npx tsc --noEmit` → zero errors |

---

## Related docs

- [CLAUDE.md](../CLAUDE.md) — Recent Features → "Webinar events as first-class"
- [docs/DEVELOPMENT_STATUS.md](./DEVELOPMENT_STATUS.md) — Recent Updates → "Webinar Events as First-Class"
- [CHANGELOG.md](../CHANGELOG.md) — 2026-04-13 entry
- [docs/ZOOM_INTEGRATION.html](./ZOOM_INTEGRATION.html) — underlying Zoom OAuth + SDK setup
