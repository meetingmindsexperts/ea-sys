# Parallel webinars: a second Zoom host

**Status: PLANNED, NOT BUILT (Nov 11, 2026).** Owner, Nov 11: "plan for a parallel Zoom
account to run parallel webinars". Nothing below is built. Section 7 lists the decisions
that are the owner's; the build waits on the first one.

## 1. The short version

- Today every webinar EA-SYS creates belongs to **one Zoom user**, and Zoom lets one webinar
  licence run **one webinar at a time**. Two webinars at the same hour cannot both go live.
- EA-SYS itself is already parallel: each webinar has its own room, stream key, video
  stream, emails, recording and attendance. The only single thing is the Zoom host.
- **Recommended: a second licensed user inside the SAME Zoom account** (a second seat with
  its own Webinars add-on). The app then needs one small change: choose which host a webinar
  is created under. Rough size: 2 to 3 working days with tests, review and a real parallel
  test.
- A fully **separate Zoom account** (its own API and SDK credentials) also works but is
  about four times the work, because every Zoom call in the app would have to know which
  account a webinar lives in. Choose it only if the second licence cannot sit in the
  existing account.
- Nothing is urgent: production has never had two webinars overlap, and none is scheduled.
  The plan can wait for the first date that needs it, plus the time to buy the licence.

## 2. Where the limit is

Zoom's rule: a Webinars licence belongs to one user, and that user can have one webinar in
progress at a time. Zoom still lets you **schedule** two overlapping webinars under the same
user. The refusal comes only when the second one is started, which is the worst moment to
find out.

What the code does today (`src/lib/zoom/meetings.ts`):

| Call | Address | Host |
|---|---|---|
| Create meeting | `POST /users/me/meetings` | always "me" |
| Create webinar | `POST /users/me/webinars` | always "me" |
| Create webinar series | `POST /users/me/webinars` | always "me" |
| Everything else (update, delete, panelists, live stream, recording, reports, polls, Q&A) | by the webinar's own id | whoever owns it |

"me" is the one Zoom user the organisation's Server-to-Server app answers as. So all hosting
funnels into one user, and only the three create calls say so. Every other call names the
webinar by id and uses the account-level token, so it should not care which user in the
account owns the webinar (to be confirmed in step 0).

Production on Nov 11, 2026 (read-only query):

| Fact | Value |
|---|---|
| Zoom meetings and webinars created by EA-SYS | 9 (8 webinars, 1 meeting) |
| Distinct Zoom hosts among them | 1 |
| Pairs that ever overlapped in time | 0 |
| Webinars scheduled in the future | 0 |

## 3. What is already parallel (no change planned)

- **The room.** Open and close, the waiting room, the exit screen and the thank-you email
  are kept per event.
- **The video.** Each webinar has its own stream key and its own path on MediaMTX
  (`paths: all` in `mediamtx.yml`), checked per key by the publish webhook. CloudFront serves
  each path separately.
- **The embed.** The Meeting SDK keys belong to the Zoom account, so they sign a join for
  any webinar in that account, whichever user hosts it.
- **After the webinar.** Recording, attendance, polls and Q&A are fetched per webinar id by
  the worker.
- **The box.** MediaMTX repackages the stream and does not re-encode it, so a second stream
  costs little. The load that grows is attendee traffic (waiting-room, stream-status and
  presence calls), which follows the total number of people watching, not the number of
  webinars. The Nov 10 webinar was small (1,029 CloudFront requests, 161 MB); two at once
  has not been measured and is part of the test in step 5.

## 4. The two ways to do it

### Option A (recommended): a second user in the same Zoom account

- Zoom side: add a licensed user, give it a Webinars add-on, and switch on for that user
  what the first has (cloud recording, custom live streaming for webinars, Q&A, polls).
  Setting these at account level and locking them is the safest.
- App side: keep a short list of hosts, and create each webinar under a chosen host
  (`POST /users/{hostId}/webinars`). One set of credentials, one SDK app, no change to any
  other Zoom call.
- Licence size: on a **custom stream** webinar attendees watch our video and never join
  Zoom, so only the panelists count against the add-on, and the smallest add-on is enough
  for the second host. On a **Zoom embed** webinar every attendee joins Zoom, so the second
  host's add-on must fit that audience. Check current prices with Zoom.

### Option B: a separate Zoom account

- A second set of API credentials and a second Meeting SDK app, stored beside the first.
- Every Zoom call (about 20 files call the Zoom library) must be told which account the
  webinar lives in, the token cache must be keyed by account, and `ZoomMeeting` needs to
  record its account.
- An SDK app that is not published on Zoom's marketplace can only join meetings of its own
  account (Zoom developer forum; not confirmed in Zoom's documentation), so the embed needs
  the second account's own SDK keys, chosen per webinar.
- Settings, "Test connection" and the credential checks all become per account.
- Worth it only if the second licence belongs to another company or billing account.

### Not recommended: "alternative host" on the one licence

Naming a second person as alternative host lets them start a webinar, but the webinar still
runs on the scheduler's Webinars licence. Zoom community answers disagree on whether two can
then run at once, so this is not something to plan a live event on.

## 5. Plan for option A

Each step ends in something that works on its own. Steps 1 and 2 are useful even before a
second licence exists.

**Step 0. Check the assumptions on the real account (half a day, no code shipped).**
- Who "me" is (the existing "Test connection" already asks Zoom).
- That the Server-to-Server app may list the account's users and create a webinar for
  another user (it needs the account-wide user and webinar scopes).
- That update, panelists, live stream, recording and reports work on a webinar owned by the
  second user. One throwaway webinar under the second user, created and deleted by id.
- Whether Zoom can move an existing webinar to another host, or whether it must be deleted
  and created again (assume the second until checked).

**Step 1. Warn about a clash (useful today, with one host).**
- The Webinar Console and the event date settings say so when another webinar on the same
  Zoom host overlaps this one in time, with a buffer either side (proposed: 30 minutes, for
  rehearsal and overrun).
- One rule in `src/lib/zoom/` that every surface asks, never a second copy of the overlap
  test.

**Step 2. The host list.**
- Settings, Integrations, Zoom: a "Webinar hosts" list. Add a host by email; the app looks
  the user up in Zoom, checks it has a Webinars licence, and stores its Zoom user id, email
  and a label ("Host A", "Host B").
- Stored in `Organization.settings.zoom.hosts`, beside the credentials. An empty list means
  exactly today's behaviour (`/users/me`), so nothing changes until a second host is added.
- `ZoomMeeting` records its host: two nullable columns, `zoomHostId` and `zoomHostEmail`,
  filled at creation and backfilled from the stored Zoom response for existing rows. An
  additive migration; an older image ignores the columns.

**Step 3. Choosing the host.**
- When a webinar is created (the provisioner, the session's Zoom form, the agent tool, a
  clone), the app picks the first host on the list that is free for that time, using the
  step 1 rule. All three create calls take the host.
- When every host is busy, nothing is created on Zoom and the message says which webinars
  hold the hosts. The organiser picks another time or adds a host.
- The Webinar Console shows the host and lets an organiser choose another before the
  webinar is created.

**Step 4. Moving a webinar.**
- Changing a webinar's time re-runs the clash check and warns when its host is now busy.
- "Move to another host" recreates the Zoom webinar under the new host (unless step 0 finds
  Zoom can move it). The attendee link is our own page, so attendees notice nothing.
  **Panelist join links change**, so the console says so and offers to resend them. Best
  done before panelists are invited.

**Step 5. A real parallel test on production.**
- Two test webinars at the same time under the two hosts, each started from its own "Start
  as Host" link (two people, or one person in two browser profiles, since the link signs in
  as that host).
- Check for both: the room, the custom stream on the attendee page, the Zoom embed, the
  stream watchdog, the recording, attendance, and the thank-you email (test emails to the
  owner's address only).
- Watch the box (CPU, memory, MediaMTX log) while both streams run.
- Then update the user guide, `docs/ZOOM_INTEGRATION.html` and the changelog.

## 6. Risks

| Risk | What limits it |
|---|---|
| The second user lacks a setting the first has (custom live streaming, cloud recording), found at go-live | Step 0 checks them; the app already reports a refused live-stream start in the console |
| Panelist links change when a webinar moves host | The console warns and offers a resend; choose the host before inviting |
| Both hosts busy on a date | The create is refused with the reason, never a silent double booking |
| A producer starts host B's webinar while signed in to Zoom as host A | The "Start as Host" link carries the host's own sign-in; the console names the host beside the button |
| The app's scopes do not allow acting for another user | Found in step 0, fixed in Zoom's app settings, no code |
| Two streams load the box more than expected | Measured in step 5 before any real parallel event |

## 7. Decisions that are the owner's

1. **Same account or separate account?** A second user in the existing Zoom account
   (option A, recommended) or a separate Zoom account (option B). Everything else follows
   from this.
2. **How many at once?** The host list handles any number; the question is how many
   licences to buy. Two is assumed.
3. **Who picks the host?** Proposed: the app picks a free one and the organiser may change
   it. The alternative is that the organiser always picks.
4. **The buffer** around a webinar when testing for a clash. Proposed: 30 minutes before and
   after.
5. **The two new columns on `ZoomMeeting`** (step 2), or keep reading the host from the
   stored Zoom response and add no column. The columns are proposed because the clash test
   runs on every create and retime.
6. **When.** No webinars are scheduled and none has ever overlapped. Build now, or when the
   first parallel date is known (allow about a week before it, plus the licence).

## 8. Not verified

- Zoom's rules were read from Zoom community and developer forum answers on Nov 11, 2026,
  not tested on the account: one webinar at a time per licence, and the SDK limit across
  accounts.
- Whether "me" for a Server-to-Server app is always the account owner. On production all 9
  rows carry one host id, so it is one user in practice.
- That every by-id call works for a webinar owned by another user in the account (step 0).
- Whether Zoom can change a webinar's host without recreating it (step 0).
- Licence prices and which add-on sizes Zoom sells today.

Sources read: [Zoom community: concurrent webinars](https://community.zoom.com/t5/Zoom-Webinars/Concurrent-Webinars-x1-500-webinar-licence-with-several/td-p/105790),
[Zoom community: webinars at the same time with an alternative host](https://community.zoom.com/webinars-19/holding-webinars-at-the-same-time-but-having-an-alternate-host-2241),
[Zoom developer forum: Meeting SDK cross-account join policy](https://devforum.zoom.us/t/meeting-sdk-cross-account-join-policy/106590),
[Zoom developer forum: Meeting SDK with a non-public app](https://devforum.zoom.us/t/meeting-sdk-with-a-non-public-app/103677).
