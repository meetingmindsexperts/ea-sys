# Webinar interaction on the Custom stream page

**Status: §3 Q&A upvote, §4 handouts and §5 polls BUILT (October 6, 2026); public chat PLANNED,
§6 revised November 6, 2026 (owner chose attendee chat; cached polling instead of a live
connection, see §6.2).** Written
after the owner compared EA-SYS with another platform's host control panel
("how much of this can we do?"). Decisions still open are in §8.

**Who this is for.** The owner, to choose what to build and in what order, and
whoever builds it.

---

## 1. Where we stand

The Custom stream (HLS) attendee page is a one-way broadcast: attendees watch a
video feed and are not in Zoom, so nothing Zoom offers inside a meeting reaches
them. What they can do today is what EA-SYS builds on the page itself.

| Host control | Custom stream page today | Plan |
|---|---|---|
| Q&A: moderated, submission | **Built** (Oct 1, 2026). Attendees ask beside the video (`WebinarViewerQuestion`); moderators choose which questions everyone sees (Webinar Console, Q&A tab, `isPublic`). | Done |
| Q&A upvote | **Built** (Oct 6, 2026) | §3 |
| Handouts | **Built** (Oct 6, 2026) | §4 |
| Polls | **Built** (Oct 6, 2026) for Custom stream. Zoom polls are still pulled after the event (`WebinarPoll`) for people inside Zoom. | §5 |
| Public chat, auto-mute | Not built | §6, large |
| Private chat (attendee and presenter) | Not built | §7, large |
| Attendee mics, mics + cams | **Not possible in Custom stream**: there is nothing to unmute in a video feed. Exists only in Zoom embed mode, controlled by Zoom (panelists, or promoting an attendee). | Not planned |

Every feature below is per webinar, switched on by the producer in the Webinar
Console, available only to signed-in registrants (the page's existing gate), and
logged on every refusal like the rest of EA-SYS.

## 2. Order of work

| # | What | Effort | Depends on |
|---|---|---|---|
| 1 | Q&A upvote | about half a day | nothing |
| 2 | Handouts | about half a day | nothing |
| 3 | Polls | about 2 days | nothing |
| 4 | Public chat with cached polling (§6, revised Nov 6) | about 4 days | D4 (privacy notice line); the rest decided Nov 6 |
| 5 | Private chat | about 3 days | 4 |

Items 1 to 3 need no new infrastructure and can ship one per deploy. Item 4 needs no new
infrastructure either since the Nov 6 revision (cached polling, §6.2).

## 3. Q&A upvote

Attendees upvote the questions moderators have made public; the console sorts by
votes so the most-wanted question is easy to pick.

- **Data:** `WebinarQuestionVote` (`questionId`, `registrationId`,
  `organizationId`, `createdAt`), `@@unique([questionId, registrationId])`, so a
  person votes once per question; a second vote removes it (toggle). Tenancy
  columns and an RLS policy in `prisma/rls/` from day one.
- **API:** `POST /api/public/events/[slug]/sessions/[sessionId]/questions/[questionId]/vote`
  (toggle; only public questions; signed-in registrant; rate limited). The
  public questions list returns `voteCount` and `votedByMe`. The console list
  returns `voteCount` and offers "sort by votes".
- **Console switch:** "Let attendees upvote questions" (`settings.webinar.qaUpvote`),
  default on.
- **Tests:** one vote per person, toggle, private questions refuse votes,
  another session's question refused.

**As built (Oct 6, 2026):** migration `20261006180000` (table, RLS policy in
`prisma/rls/webinar.sql`, swept for the tenancy gate); the gate shared with the
ask route in `src/lib/webinar/viewer-question-access.ts`; votes are per
registration (staff testing the page can read counts, not vote), and a
double-click race counts once. The attendee list is sorted by votes then
newest on each refresh (not on click, so a question never jumps under the
pointer); the console shows counts and a "Sort by votes" button. The switch
sits at the top of the console's Q&A tab. Tests in
`webinar-viewer-questions.test.ts`.

## 4. Handouts

A "Handouts" card on the attendee page (under the panelists) listing files the
producer chose: slides, a PDF, a reading list.

- **Data:** no new table. `settings.webinar.handoutMediaIds` (ordered ids of the
  event's `MediaFile` rows), validated to belong to the event.
- **Console:** a "Handouts" section on the Branding tab or its own card: pick
  from the event media library or upload, reorder, remove.
- **API:** the public session detail route returns the handouts (name, size,
  download link) for a signed-in registrant only; files stream through the
  existing uploads path.
- **Tests:** a foreign media id refused at save; not served to an anonymous
  visitor.

**As built (Oct 6, 2026), with the owner's two decisions:** the event media
library takes images only (2 MB), so handouts do not use it. They are their
own files, **private** (owner: "signed-in registrants") under the
`webinar-handouts/{eventId}/` prefix, which the public `/uploads` route
refuses; **PDF, PPTX or DOCX up to 8 MB** each (owner; under the box's 10 MB
nginx limit), checked by extension and first bytes, at most 10. The list lives
in `settings.webinar.handouts` (src/lib/webinar/handouts.ts), written only by
`updateHandouts` under a row lock. Console: a Handouts card on the Setup tab
(add, reorder, remove with confirmation; read-only without
`webinar.manage`). Attendee page: a Handouts card under the panelists,
refreshed every minute; the list and each download go through routes with
the Q&A gate (signed-in registrant or org staff), a download reads only
through this event's own prefix, PDFs open in the browser and Office files
download. Handouts stay available after the event is marked COMPLETED.
Tests in `webinar-handouts.test.ts`.

**Review of handouts (Oct 6, 2026): 0 HIGH; every MED and LOW fixed.** One
reader for both downloads (`src/lib/webinar/handout-download.ts`): this
event's folder only, a missing file is a 404, no second copy of the bytes, 60
downloads an hour per person. Every delete is guarded to the event's own
folder. The provisioner no longer writes its snapshot of `handouts` back, and
the general event-settings save keeps the stored list (`keepStoredHandouts`),
so neither can lose or plant an entry. An upload whose list write fails
removes its file; deleting an event removes its handout files. Staff open a
handout from the console card (read access is enough), and the attendee page
fetches handouts only once its sign-in check has settled.

## 5. Polls

The producer launches a question during the webinar; attendees answer beside the
video; results update live in the console and can be shown back to attendees.

- **Data:** `LivePoll` (`eventId`, `sessionId`, `question`, `options` JSON,
  `allowMultiple`, `status` DRAFT / OPEN / CLOSED, `showResults`,
  `openedAt`, `closedAt`, tenancy columns) and `LivePollVote` (`pollId`,
  `registrationId`, `choices` JSON, `@@unique([pollId, registrationId])`). Named
  apart from `WebinarPoll`, which holds the polls pulled from Zoom afterwards.
- **Console:** a Polls card on the webinar's Live tab: draft polls ahead of
  time, Launch, Close, "Show results to attendees", live counts.
- **Attendee page:** the open poll appears as a card above the Q&A; after
  voting, the attendee sees "Thanks" or the results if shown. The page already
  polls lobby state every few seconds; the open poll rides that same request,
  so no new connection is needed.
- **Export:** per-poll CSV (question, option, count; and per-person answers)
  from the console, plus a column in the attendance export.
- **Tests:** one vote per person per poll, votes refused when closed, results
  hidden until the producer shows them.

**As built (Oct 6, 2026):** migration `20261006200000` (`LivePoll`,
`LivePollVote`, RLS, swept). Owner: an **"Enable live polls" switch per
webinar, off by default** (`settings.webinar.livePolls`); while off nothing
reaches attendees and nothing can be launched, drafts can still be prepared.
Console: a Polls tab beside Q&A (custom stream): drafts (2 to 6 options,
optionally several answers), Launch (closes any other open poll in the same
write), Close, Reopen, "Show results to attendees" per poll, counts refreshed
every 5 s, delete only while nobody answered, CSV per poll (counts, then each
person's answer; `webinar.attendance.export`, recorded as an export). Attendee
page: the poll rides the Q&A refresh (no new request; appears within 15 s),
one answer, final; closing a poll takes it off the attendee page at once,
results and all (owner, Nov 5, 2026: one poll at a time, never an earlier
poll's results left on screen). Results are cached per poll for 5 s so 1,000 viewers do not each read
every vote. Not done: the attendance-export column (§5 export bullet).
Tests in `live-polls.test.ts` (lib and api).

**Review of polls (Oct 6 to 7, 2026): 1 HIGH, 2 MED, 5 LOW, all fixed.** HIGH:
shown results never replace the question for someone who can still answer.
A cancelled registration's answer stops counting (the export keeps the row,
marked). Launch locks the session row, so two launches at once cannot leave
two polls open (a partial unique index was rejected: Prisma cannot express it
and CI's schema parity check would fail). Edit and delete are conditional on
state at write time; an open poll cannot be deleted. No cache flush per vote.
The poll read runs beside the question reads. Switching polls off closes any
open poll.

## 6. Public chat (revised November 6, 2026)

**Owner, Nov 6, 2026: plan attendee chat** (chosen over a one-way producer broadcast). The Oct 6
version of this section is replaced; what changed is below.

A chat panel beside the video on the Custom stream page, for the people who may watch. Attendees
and staff post short messages; producers moderate live. Zoom embed mode keeps Zoom's own chat.

### 6.1 What changed since October 6

- **The realistic audience is smaller than the old plan assumed.** There is no CDN (no CloudFront
  distribution, `HLS_CDN_BASE` unset, checked Nov 5), so the box serves every viewer's video. A
  t3.large sustains roughly 0.5 Gbps: about 300 to 500 live viewers. Chat sized for 5,000 is
  premature until a CDN exists (ROADMAP, "Webinar streaming", item 4).
- **The gate exists now.** `src/lib/webinar/viewer-entitlement.ts` (Nov 5) is the rule for who
  may watch, and the room gate says when. Chat reads and posts go through the same two checks,
  so a pending or unpaid registration can neither read nor post.

### 6.2 Live delivery: cached polling first, not a live connection

| Option | How a message reaches viewers | For | Against |
|---|---|---|---|
| **A. Cached polling (recommended)** | Each open page asks `GET .../chat?after=<last id>` every 3 s. The route keeps the session's last 200 messages in a per-container cache, rebuilt at most every 2 s (one DB query per 2 s per container, as `lobby-status` does), and returns only what is newer than `after`. | No new infrastructure; nothing to drain on a blue/green swap (a page simply asks the other container); same shape as `lobby-status`, Q&A and polls, which are proven on prod. | A message takes 2 to 5 s to show. About 170 requests a second at 500 viewers, each cheap (session check plus a cache read). |
| B. Server-sent events | Each viewer holds one HTTP stream; posts are pushed down it, shared across containers by Postgres LISTEN/NOTIFY. | Under a second. | Thousands of long-lived connections on the web container, nginx buffering and timeouts to tune, every connection dropped and replayed on each blue/green swap. |
| C. A separate WebSocket service | A small container beside MediaMTX. | Built for many connections. | A new service to deploy, secure and monitor. |

**Recommendation: A.** A 2 to 5 s delay reads as normal for webinar chat. Move to B only if a CDN
lifts audiences past about 1,000 and a load test shows A struggling. The post route and the data
stay the same either way, so A is not thrown away.

### 6.3 Chat itself

- **Data:** `WebinarChatMessage` (`eventId`, `sessionId`, `organizationId`, `registrationId` or
  `userId` for staff, `authorName`, `authorKind` attendee / staff / speaker, `anonymous` (bool), `body` up to 500
  characters, `kind` message / handout, `handoutId?`, `pinnedAt?`, `deletedAt`, `deletedBy`),
  index `(sessionId, createdAt)`. Additive migration; an RLS policy in `prisma/rls/webinar.sql`
  from day one, like every webinar table.
- **Who:** staff, and registrations that may watch (`viewerRegistrationWhere`); only the anchor
  session of a WEBINAR event in Custom stream mode (`loadQuestionContext`, as Q&A).
- **When (owner, Nov 6):** open while the room is open, read-only after it closes until the page
  shows the thank-you screen. A producer switch "Open chat in the waiting room" for pre-show
  chatter, off by default.
- **Limits:** one message every 3 s and 20 a minute per person, 500 characters, the same refusal
  logging as Q&A. Server-side, never trusted from the page: the author name comes from the
  registration, never the request.
- **Sharing documents (the original ask):** a producer can share a handout into the chat. It shows
  as a card ("Slides: Session 2.pdf, Download") that opens the existing gated handout route, so a
  non-entitled person who gets the message still cannot open the file. A producer message can be
  pinned at the top of the panel.
- **Links from attendees (owner, Nov 6):** shown as plain text, never clickable (phishing and
  spam are the main chat risk). Staff messages and shared handouts stay clickable.

### 6.4 Producer controls (Webinar Console, Chat tab)

- Chat on / off per webinar (off by default), and "Open chat in the waiting room". **Chat can be
  switched on only once a moderating producer is named for that webinar** (owner, Nov 6), so it is
  never live with nobody watching it; the named producer is shown on the Chat tab.
- **Mute everyone** (attendees read but cannot post) and **slow mode** (one message every 15 s).
- Delete any message (gone for viewers at their next poll; kept for the record, see below).
- Mute one person for the rest of the webinar (stored per session, logged).
- The live feed with author, time and a delete button; the same view after the webinar.

### 6.5 Records, privacy and load

- **Kept with the event**, exportable as CSV after the webinar (deleted messages included, marked
  deleted, with who deleted them). Never cached (`private, no-store`), the export rate limited, as
  the attendance export.
- **Names (owner, Nov 6):** the attendee chooses, per message, "Post as <full name>" or "Post
  anonymously" (shown as "Attendee"). Producers always see the real name in the console, so a
  muted or deleted message is still attributable. The full name comes from the registration,
  never the request. Needs a line in the registration privacy notice before chat goes live (D4).
- **Load test before a big webinar:** 500 simulated viewers polling while 20 post, on the local
  standalone build, watching the web container's CPU and the pool.

### 6.6 Effort

| Step | What | Effort |
|---|---|---|
| 1 | Model, migration, RLS policy; post and read routes with the gate, limits and cache; tests | **BUILT Nov 6** |
| 2 | Attendee panel (beside Q&A on desktop, a tab on a phone), pinned message, handout cards | **BUILT Nov 6** |
| 3 | Console Chat tab: switches, mute all, slow mode, delete, mute a person, export | **BUILT Nov 6** |
| 4 | Load test, browser verification on a phone and desktop, docs | **DONE Nov 6** |

About 4 days in all, shippable in two deploys (1 + 2 behind the off-by-default switch, then 3 + 4).

**Built Nov 6 (steps 1 and 2):** `WebinarChatMessage` (migration `20261106120000`, RLS policy in
`prisma/rls/webinar.sql`); `src/lib/webinar/chat.ts` (rules, client-safe), `chat-server.ts` (the 2 s
snapshot, found through `resolveEventTenant`, and the per-person viewer cache);
`GET/POST /api/public/events/[slug]/sessions/[sessionId]/chat`; the panel
(`components/webinar/chat-panel.tsx`) and the Chat / Q&A tabs (`webinar-side-panel.tsx`). Owner,
Nov 6: nothing may arrive unseen behind the other tab, so the Chat tab shows a dot for new messages
from others, and the Q&A tab "Poll" for a poll waiting on this viewer and a dot for a newly shared
question or an answered one of theirs.

**Built Nov 6 (step 3):** the Webinar Console's Chat tab (`components/webinar/chat-moderation-panel.tsx`)
over `GET/PATCH/POST /api/events/[eventId]/webinar/chat`: the feed with real names (and "Shown as
Attendee" for anonymous posts), "Make me the moderator" (whoever holds `webinar.manage` names
themselves, so the moderator can always moderate; switching chat on with nobody named names you),
the switches (on, open in the waiting room, mute everyone, slow mode), delete and restore (the row
stays, with who and when), pin, mute and unmute a person, a host message, a handout shared as a
card, and the CSV record (`webinar.attendance.export`, 30 an hour, `private, no-store`). Settings are
written under the event row lock through `updateEventSettings`, only the `chat` key.

**Load test, Nov 6 (step 4):** `loadtest/k6/webinar-chat.js` against the production build
(standalone, local copy of prod), 500 signed-in viewers polling every 3 s and 20 posting, 3 minutes:
about 30,500 polls (155 a second), **0 errors**, polls p95 84 to 106 ms and p99 197 to 374 ms, posts
p95 51 to 70 ms, about 600 messages (200 a minute, a very busy chat). The chat table was read about
once per post (570 reads in 3 minutes); the polls themselves came from the snapshot. The first run
showed each poll resending about 15 messages from the 5 s late-commit window, so it was cut to 2 s
(about 6). **Limits of the test:** a laptop is faster than the t3.large, and the video was not
running; on the box, video bandwidth is the ceiling (about 300 to 500 viewers without a CDN,
ROADMAP "Webinar streaming"), well before chat is.

## 7. Private chat

On top of §6: an attendee can message the presenters (and, if switched on,
presenters can reply privately). Attendee-to-attendee private chat is left out
of this plan: it is the hardest to moderate and the least asked for.

- **Data:** `WebinarPrivateMessage` (`sessionId`, `fromRegistrationId` or
  `fromUserId`, `toUserId` or `toRegistrationId`, `body`, `readAt`).
- **Console:** a presenter inbox in the Webinar Console (unread count, reply).
- **Attendee page:** a "Message the presenters" tab in the chat panel.

## 8. Open decisions (recommendation first)

| # | Question | Recommendation |
|---|---|---|
| D1 | Build order | Upvote and handouts now, polls next, chat only on a real need. |
| D2 | Chat at all, and which foundation | **Owner, Nov 6: build attendee chat.** Foundation: cached polling (§6.2); server-sent events only if a CDN lifts audiences past about 1,000. |
| D3 | Who moderates chat during a live webinar | **Owner, Nov 6: a named producer per webinar**; chat cannot be switched on until one is named. |
| D4 | Privacy notice for chat names | Counsel adds a line before chat goes live. |
| D5 | Show poll results to attendees by default | Off by default; the producer shows them per poll. |
| D6 | Names other attendees see in chat | **Owner, Nov 6: the attendee chooses per message, full name or anonymous**; producers always see the real name (§6.5). |
| D7 | Links posted by attendees | **Owner, Nov 6: plain text, never clickable**; staff links and handout cards clickable (§6.3). |
| D8 | Chat in the waiting room | **Owner, Nov 6: with the room**; a producer switch opens it in the waiting room, off by default (§6.3). |
