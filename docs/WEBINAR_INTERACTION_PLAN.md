# Webinar interaction on the Custom stream page

**Status: PLANNED, NOT BUILT (October 6, 2026).** Written after the owner
compared EA-SYS with another platform's host control panel ("how much of this
can we do?"). Nothing here is implemented yet. Decisions still open are in §8.

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
| Q&A upvote | Not built | §3, small |
| Handouts | Not built | §4, small |
| Polls | Not built for Custom stream. Zoom polls are pulled after the event (`WebinarPoll`), but only reach people inside Zoom. | §5, medium |
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
| 4 | Live messaging foundation (§6.1) | about 1.5 days | owner decision D2 |
| 5 | Public chat | about 2 to 3 days | 4 |
| 6 | Private chat | about 3 days | 4, 5 |

Items 1 to 3 need no new infrastructure and can ship one per deploy. Items 4 to
6 add an always-on live connection per attendee and are a separate decision.

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

## 6. Public chat

A chat panel beside the video. The producer can switch it on or off, mute
everyone (auto-mute: attendees can read but not post), and delete any message.

### 6.1 Live messaging foundation

Chat needs messages to reach every viewer within a second or two. The Q&A box's
"ask every few seconds" approach is fine for questions but too heavy for chat at
1,000+ viewers (one request per viewer every 2 to 3 seconds).

| Option | What it is | For | Against |
|---|---|---|---|
| A. Server-sent events from the app | Each viewer holds one HTTP stream from a Next.js route; messages are pushed down it; posting is a normal POST. | No new container; works through nginx; one-way push is all chat needs to receive. | Long-lived connections on the web container; a message posted on one container must reach viewers on another during a blue/green swap (needs a shared channel, e.g. Postgres LISTEN/NOTIFY). |
| B. A separate WebSocket service | A small container beside MediaMTX (the same idea as the online venue's live colleagues in `docs/EVENT_BLUEPRINT_PLAN.md` §5.4). | Built for many open connections; isolates load from the app. | A new service to deploy, monitor and secure; auth bridging to the EA-SYS session. |

Recommendation: **A first** (server-sent events plus Postgres LISTEN/NOTIFY),
with a load test at the largest expected audience before it is switched on for a
big webinar. Move to B only if the test shows the web container struggling. The
same foundation later serves live poll results and the venue's live colleagues.

### 6.2 Chat itself

- **Data:** `WebinarChatMessage` (`eventId`, `sessionId`, `registrationId` or
  `userId` for staff, `authorName`, `body` up to 500 characters, `deletedAt`,
  `deletedBy`, tenancy columns), indexed by `(sessionId, createdAt)`.
- **Rules:** signed-in registrants and staff only; rate limited per person (for
  example one message every 3 seconds); the existing language filter idea from
  the venue can be reused for a profanity list later.
- **Producer controls (console):** chat on/off, mute all, delete a message,
  mute one person for the session.
- **Retention and export:** the chat is exportable after the webinar and kept
  with the event; deleted messages stay in the export marked deleted, for
  moderation records.
- **Privacy:** attendee names are visible to other attendees. That needs a line
  in the registration privacy notice before it goes live (§8, D4).

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
| D2 | Chat at all, and which foundation | Decide when a webinar needs it; if yes, server-sent events first with a load test (§6.1). Zoom embed mode already offers chat for webinars that need it now. |
| D3 | Who moderates chat during a live webinar | A named producer per webinar; chat stays off unless one is assigned. |
| D4 | Privacy notice for chat names | Counsel adds a line before chat goes live. |
| D5 | Show poll results to attendees by default | Off by default; the producer shows them per poll. |
