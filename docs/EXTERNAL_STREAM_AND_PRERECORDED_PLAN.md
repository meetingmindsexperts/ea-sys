# A partner streams into our webinar, and pre-recorded webinars

**Status: PLANNED, NOT BUILT (Nov 12, 2026).** Owner, Nov 12: "giving our RTMP key to
someone else so that they can stream into our platform, be it Zoom or something else", as
BigMarker allowed for the Mounjaro and Lilly Omvoh webinars; and afterwards "people will
register and sign in only to see a pre-recorded webinar". Nothing below is built. Section 9
lists the decisions that are the owner's. Part B waits for part A.

## 1. The short version

- **Most of the plumbing exists.** EA-SYS already receives a video stream on its own server,
  turns it into a player on the attendee page, serves it through CloudFront and lets only
  registered, approved, paid-up people watch, and only while the room is open.
- **What is missing is narrow.** Today the stream key belongs to *our own Zoom webinar*. A
  webinar produced on someone else's platform has no Zoom webinar of ours, so it has no key,
  and the attendee page answers "No Zoom meeting for this session".
- **Part A (about 6 to 7 working days):** a webinar can be marked **External stream**. It
  gets a server address and a stream key to hand to the partner, valid for a set period,
  replaceable and cancellable, with a "cut the feed" button. No Zoom webinar is created and
  no Zoom licence is used.
- **Part B (about 3 to 4 working days each way):** a pre-recorded webinar. Two different
  things carry that name and the owner chooses (section 9, B1): **on demand** (sign in and
  watch whenever you like) or **scheduled playback** (the recording plays at a set time for
  everyone, with live chat and Q&A). Both need the "webinar with no Zoom behind it" that
  part A builds, which is why B comes second.
- **The alternative that needs no build:** the partner's speakers join *our* Zoom webinar as
  panelists. That works today. Part A is for the partners who must produce on their own
  platform or studio, which is what the BigMarker key was used for.

## 2. What exists today

| Piece | Where | State |
|---|---|---|
| The door a stream comes in by (RTMP, port 1935) | MediaMTX container, `mediamtx.yml` | Live |
| A password on every incoming stream | `POST /api/webhooks/mediamtx-auth`, `src/lib/webinar/livestream.ts` | Live since Nov 5, 2026 |
| The attendee player, with recovery from stalls | `src/components/zoom/live-player.tsx` | Live |
| CloudFront in front of the video | `HLS_CDN_BASE`, [HLS_CDN_PLAN.md](HLS_CDN_PLAN.md) | Live since Nov 9, 2026 |
| Who may watch (confirmed, and paid or nothing owed) | `src/lib/webinar/viewer-entitlement.ts` | Live |
| Nothing is shown until the producer opens the room | `isViewerRoomOpen`, the stream-status route | Live, so a partner can test days ahead and no attendee sees it |
| Chat, Q&A and live polls on the attendee page | Our own (`src/lib/webinar/chat.ts`, `questions.ts`, `live-polls.ts`) | Live, not tied to Zoom |
| Who is watching now, first joined, times joined | `WebinarPresence`, our own heartbeat | Live, not tied to Zoom |
| A replay uploaded to Vimeo, played inside our gated page and in My events | `src/lib/webinar/replay.ts`, `registrant-replays.ts` | Live since Nov 10, 2026 |

Production on Nov 12, 2026 (read-only query):

| Fact | Value |
|---|---|
| Webinar events | 15 |
| Of those, with no room of their own in EA-SYS (run on another platform) | 9 |
| Webinars set to the custom stream | 3 |
| Zoom webinars holding a stream key | 4 |
| Webinars with an uploaded replay | 2 |
| Webinars in the future | 0 |

Nine of fifteen webinars were run outside our room. Not all of those were partner
productions, but it is the group this plan is for.

## 3. What is missing for a partner's stream

1. **The key lives on our Zoom webinar's record** (`ZoomMeeting.streamKey`). Eighteen source
   files refer to it there. A webinar without our Zoom has nowhere to keep a key, and the
   attendee's join call refuses with "No Zoom meeting for this session".
2. **The key staff can copy today does not work for a partner.** The session card shows the
   bare key. Since Nov 5 a stream is accepted only with the key *and* a password, and only
   Zoom is sent the password. A partner given the card's key would be refused.
3. **The password cannot be changed or expire.** It is calculated from the key alone. That is
   fine for a value only Zoom's servers hold. It is not fine for a value emailed to an agency:
   it must stop working after the webinar and be replaceable if it leaks, without changing the
   address attendees watch on.
4. **The password depends on the sign-in secret.** `STREAM_PUBLISH_SECRET` is set nowhere, so
   passwords are derived from `NEXTAUTH_SECRET` (ROADMAP, "Webinar streaming", item 1).
   Rotating that secret would silently cancel every key a partner holds.
5. **The producer's controls all speak to Zoom.** Start stream, Stop stream, the watchdog
   that restarts a dropped stream, and the auto-close that trusts "Zoom says it ended". None
   of them can act on a partner's platform. Opening the room in custom-stream mode refuses
   with "the stream isn't set up in Zoom yet".
6. **There is no way to cut a partner's feed.** With Zoom we tell Zoom to stop. A partner's
   encoder keeps pushing until they stop it. Closing the room hides the video from the page,
   but the stream is still arriving.
7. **A second stream with the right password replaces the first** (MediaMTX's
   `overridePublisher`, on by default). Useful for a backup encoder. It also means a leaked
   key lets someone take over the picture, which is why items 3 and 6 matter.
8. **No recording.** The replay today is Zoom's cloud recording or a Vimeo upload. A partner's
   stream never passes through our Zoom.
9. **No Zoom reports.** Attendance, polls and Q&A fetched from Zoom after the webinar do not
   exist. Our own presence record, chat, Q&A and polls do, and become the only record.
10. **The picture quality is the partner's choice.** We do not re-encode. Every attendee
    downloads exactly what the partner sends: a 6 Mbps studio feed stalls phones on mobile
    data and triples the CloudFront bill. There is no setting in MediaMTX that refuses a
    stream for its bitrate.
11. **The door is not encrypted.** RTMP on port 1935 is plain. Zoom accepts that. Some
    corporate platforms insist on RTMPS.

## 4. Part A: the design

### 4.1 A webinar has a source

A webinar's console gets a **Video source** choice:

- **Our Zoom** (today, unchanged): our Zoom webinar, shown by Zoom embed or custom stream.
- **External stream**: a partner pushes video to us from their own platform. No Zoom webinar
  is created, no host link, no panelists, no Zoom licence. The attendee page shows the
  stream player with our chat, Q&A, polls and handouts.

An external-stream webinar does not occupy the one Zoom host, so it can run at the same
hour as a Zoom webinar. That removes some of the pressure behind
[ZOOM_PARALLEL_WEBINARS_PLAN.md](ZOOM_PARALLEL_WEBINARS_PLAN.md).

### 4.2 Where the key lives

A new table, `ExternalStream`, one row per session (additive migration, nothing existing
changes):

| Column | Meaning |
|---|---|
| `sessionId` (unique), `eventId`, `organizationId` | Which webinar |
| `streamKey` (unique) | The path the video arrives on and attendees watch on |
| `secretVersion` | Counts up each time the password is replaced |
| `enabled` | Off = every new stream refused |
| `validFrom`, `validUntil` | The period the key works in |
| `issuedTo` | Free text: who it was given to (agency, technician) |
| `streamStatus`, `lastPublishAt`, `lastPublisherIp` | What we last saw |

**Not** a nullable Zoom id on `ZoomMeeting`. Three background jobs (recording, attendance,
engagement) walk every `ZoomMeeting` row and call Zoom with its id. A row with no Zoom
webinar behind it would have to be skipped in each of them, and the one that forgets fails
in production on a live day.

**One question, one file.** A new `src/lib/webinar/session-stream.ts` answers "what is this
session's stream, and whose is it": our Zoom's or an external one. Every reader asks it and
none reads a key from a table directly: stream-status, the join route, the publish check,
the room route, the watchdog, the overrun rule, auto-close and the console. This is the
largest part of the work and it changes nothing a user can see. It is done first, alone,
with tests that our Zoom webinars behave exactly as before.

### 4.3 What the partner is given

Two values, the same shape every streaming platform asks for:

- **Server:** `rtmp://events.meetingmindsgroup.com:1935/live/`
- **Stream key:** `<key>?user=publisher&pass=<password>`

This is the form Zoom already uses against our server, so it is proven for Zoom. Whether the
partners' other platforms accept a `?` inside the stream key field is step 0.

The password is calculated from the key, its `secretVersion` and a dedicated secret, so the
console can show it again at any time and nothing secret is stored. Consequences:

- **Replace the key** adds one to the version. The old value is refused at the next
  connection. The address attendees watch on does not change.
- **Outside its period** the key is refused, and the refusal is logged with the reason so
  "it does not work" can be answered from the log.
- **Precondition:** `STREAM_PUBLISH_SECRET` is set in the box's `.env` before the first key
  leaves the company (an owner step; then "Re-send stream settings to Zoom" once on any
  upcoming Zoom custom-stream webinar). This closes ROADMAP item 1 at the same time.

Showing, replacing, switching off and cutting are each written to the audit log with who did
it. The key is shown only to people who hold "See Zoom host details" (`zoomHost.view`), the
permission that already guards stream keys. It is never returned to the AI agent.

### 4.4 The console for an external stream

A **Partner stream** card replaces the Zoom controls:

- Server and stream key with copy buttons, the period it is valid for, who it was given to.
- **Signal:** receiving since 14:02, or not receiving. From the same check the attendee page
  uses.
- **Preview the stream** (exists today) so staff can watch a rehearsal with the room closed.
- **Replace the key**, **Switch off**, and **Cut the feed**.
- A **handover sheet** to send the partner: the two values, the period, the encoder settings
  below, and a contact for the day.

Encoder settings we ask for, because the server passes the picture through untouched:

| Setting | Asked for | Why |
|---|---|---|
| Video | H.264 | The player and iPhones need it |
| Audio | AAC | Same |
| Keyframe | every 2 seconds | Our pieces are 4 seconds; a longer gap freezes iPhones (Nov 5, 2026) |
| Size and rate | 720p, 30 frames, about 2.5 Mbps (up to 1080p at 4.5 Mbps) | Every attendee downloads exactly this |

### 4.5 The room, the watchdog and closing

- **Opening the room** no longer asks about Zoom for an external stream. With no signal yet
  it opens and warns the producer; attendees see the "starting shortly" state they see today.
- **A dropped stream** cannot be restarted by us. The watchdog records it on the timeline and
  alerts the event's admins ("the partner's stream stopped arriving at 14:31"), and records
  when it returns. The attendees' players recover by themselves when it does, as today.
- **Closing.** There is no "Zoom ended" to trust. Proposed: the room closes when the stream
  has been absent for 10 minutes after the scheduled end, and otherwise by the existing
  safety net. The producer's Close button is unchanged.
- **Deploys.** The standing rule holds: no deploy, app restart or database work while a
  stream is live, because every new connection asks the app. A partner's encoder reconnecting
  during a deploy would be refused.

### 4.6 Cutting the feed

MediaMTX has a control API that can disconnect a publisher
(`POST /v3/rtmpconns/kick/{id}`). It is off today. The plan:

- Switch it on, reachable only from the app's containers, never published on the box.
- "Cut the feed" switches the key off and disconnects the current connection, so the
  encoder cannot reconnect.
- One trap, found while planning: our `mediamtx.yml` lists which actions skip the publish
  check, and that list **replaces** MediaMTX's default one, which is what exempts the control
  API. As configured today, an API call would be sent to our publish check and refused. The
  list gains `api`, and a test pins that port 9997 is never published.
- Switching it on means recreating the MediaMTX container, which is an owner step and never
  done during a live stream.

### 4.7 Recording and the replay

Three ways, the owner chooses (section 9, A3):

1. **None.** Many sponsored webinars are deliberately not kept.
2. **The partner sends the file,** staff upload it to Vimeo and paste the link. Works today.
3. **We record it.** MediaMTX can write the stream to disk. About 1.1 GB an hour at 2.5 Mbps,
   on a disk that was 65% full in September, so the file must be moved to S3 and removed
   from the box by a job. About 2 more days. Proposed for later, if partners do not deliver.

### 4.8 What is deliberately not in part A

- **A page for the partner's technician** (a secret link showing "we are receiving your
  signal" and a preview, so they can test without calling us). Useful, about 2 days, proposed
  as the first follow-up.
- **A backup server address.** Large platforms give a primary and a backup. We have one box;
  the DR box receives no stream.
- **Showing the measured bitrate** in the console and warning above 4.5 Mbps. Needs the
  control API from 4.6; a small follow-up once that is on.
- **RTMPS.** MediaMTX supports it on port 1936 with a certificate. It needs a firewall rule
  and a certificate that MediaMTX re-reads on renewal. Build it when a partner's platform
  demands it, not before.
- **The partner's speakers seeing our Q&A.** Questions arrive in our console. Someone on our
  side relays them, or the partner's moderator is given an account. A decision, not a build.
- **The platform instance.** The publish check looks keys up without a tenant, which row
  level security hides there (ROADMAP item 2). Unchanged by this plan; master is unaffected.

## 5. Part A: the steps

| Step | What | Size |
|---|---|---|
| 0 | Tests with no code, on a laptop: publish to a local MediaMTX with the key-and-password form from the platforms partners use (another Zoom account's custom live streaming, OBS or vMix, Teams or Webex if they are used). Push a 6 Mbps 1080p feed and watch it on a phone. Confirm the control API disconnects a publisher and how its own access is checked. | half a day |
| 1 | The `ExternalStream` table and `session-stream.ts`; every reader moved to it. No visible change. Tests pin that Zoom webinars behave as before. | 1.5 days |
| 2 | Issue, replace and switch off a key; the publish check learns the version, the period and the switch; refusals logged with reasons; audit entries. | 1 day |
| 3 | The Video source choice, the Partner stream card, room opening, the watchdog and closing for an external stream; webinar emails checked for Zoom wording. | 2 days |
| 4 | Cut the feed: the control API, the app's call, the config test. Owner recreates MediaMTX. | 1 day |
| 5 | The handover sheet, the user guide, `LIVE_STREAMING.md`, the changelog. | half a day |
| 6 | A rehearsal on production: a real outside encoder into a test webinar, the room, the player on a phone and a laptop, a dropped connection, a replaced key, cut the feed. Then the first partner webinar. | half a day |

Each step is its own commit with its own review, and steps 1 and 2 can ship before anything
is visible. The migration is additive; rolling back leaves an unused table.

## 6. Part B: pre-recorded webinars

"Pre-recorded webinar" means one of two products. They share the registration and the
sign-in, and little else.

| | **On demand** | **Scheduled playback** |
|---|---|---|
| What the attendee gets | Signs in and watches whenever they like, pausing and rewinding | Signs in at the advertised time; the recording plays for everyone together, like a live webinar |
| Chat, Q&A, polls | None (nobody is there at the same time) | Yes, with our moderator answering live |
| Waiting room, reminders, "starting soon" emails | No | Yes, as for a live webinar |
| Afterwards | Stays available until a closing date | Becomes a replay, as today |
| Where the video is | Vimeo, inside our gated page | The file is played into our own stream door by a job at the start time |
| Built on | The replay page that exists | Part A: we become the "partner" |

### 6.1 On demand

Most of it exists: the Vimeo player inside a page that checks the registration, the portal
page that keeps working after the event is completed, and the rule for who may watch. What
is missing:

- **A webinar format with no live moment.** Today a replay appears only once the webinar is
  over. An on-demand webinar is "over" from the start: it needs an opening and a closing
  date in place of a session time.
- **The right emails.** The confirmation carries a Watch now button. The reminder and
  "starting in an hour" sequence must not be queued.
- **The public page and the catalogue** say "On demand, available until 31 December" in
  place of a date and a countdown.
- **Who watched, and how much.** The sponsor will ask. The Vimeo player reports play,
  progress and finish to the page around it; we record that per registration.
- **Survey and certificate.** The certificate survey exists and can issue on answer.
  Whether the survey opens only after most of the video is watched is a decision (B3).

Honest limit: a video limited to our site cannot be opened elsewhere, but a signed-in person
can still record their screen. Approval of the registration is what keeps it to HCPs.

### 6.2 Scheduled playback

Technically this is part A with our own server as the partner. A worker job starts pushing
the stored file into the stream door at the start time, with its own key, and stops at the
end. The room, the player, chat, Q&A, polls, presence, the thank-you email and the replay
all behave as for a live webinar, because to them it is one.

- The file is prepared once to the settings in 4.4, so playing it costs the box little.
- New: uploading the file (S3), the job that plays it, and what happens when the job fails
  at the start time (alert, and a Start playback button in the console).
- The attendee page must not say "live" where that would mislead. Wording is a decision.

### 6.3 Sizes

- On demand: about 3 to 4 working days.
- Scheduled playback: about 3 to 4 working days after part A.
- Both: about 6 to 7.

## 7. Risks

| Risk | What limits it |
|---|---|
| A partner's platform cannot send the key-and-password form | Step 0 tests the real platforms before any code. The fallback is a separate arrival path that is copied to the watching path, which costs a process per stream |
| Moving every reader of the key to one file breaks a Zoom webinar | Step 1 ships alone, with tests on the existing behaviour, and no webinar is scheduled |
| A leaked key lets someone replace the picture | The key works only in its period, can be replaced in one click, and the feed can be cut |
| The partner sends too heavy a picture | The handover sheet states the limits; the rehearsal is watched on a phone; the measured bitrate follows |
| The partner's stream drops and we cannot restart it | Alert to the event's admins, attendees see the waiting state and recover by themselves; a named contact on the day |
| One box receives every stream | Known and unchanged. MediaMTX passes video through without re-encoding; two streams at once has not been measured |
| A deploy during a partner's live stream refuses their reconnect | The standing no-deploy rule, written on the handover checklist for the day |
| Sponsor asks for a Zoom-style attendance report | Our presence record answers who joined and when; minutes watched per person needs checking against what the console exports today |
| Pre-recorded content is copied | Vimeo limited to our site, registration approval, and no download link. Screen recording cannot be prevented |

## 8. Not verified

- That Teams, Webex or a studio encoder accept `?user=&pass=` inside the stream key field.
  Only Zoom is proven. Step 0.
- MediaMTX's settings (RTMPS, the control API, recording, publisher takeover) were read from
  the reference configuration of version 1.17.1, the version pinned on the box, on Nov 12,
  2026. None was run.
- How the control API's own access is checked once `api` is exempted from the publish check,
  and that it cannot be reached from outside the box. Step 0 and step 4.
- Which platforms the Mounjaro and Omvoh webinars were produced on, and whether BigMarker
  gave those partners RTMP or RTMPS.
- Whether the worker image has what scheduled playback needs to play a file into the door
  (no `ffmpeg` in either Dockerfile today).
- What the webinar emails say when there is no Zoom webinar. Checked in step 3.
- Whether the console's attendance export covers minutes watched, or only first joined and
  times joined.

## 9. Decisions that are the owner's

**Part A**

1. **Which platforms do partners stream from?** Their own Zoom, Teams, Webex, a studio
   encoder. Step 0 tests those and nothing else.
2. **How long a key works.** Proposed: from the moment it is issued until 24 hours after the
   scheduled end, changeable per webinar.
3. **Recording.** None, the partner sends the file (works today), or we record (2 more days,
   proposed for later).
4. **The technician's test page.** In the first build or as the first follow-up (proposed).
5. **Closing the room.** Proposed: when the stream has been absent 10 minutes after the
   scheduled end. The alternative is by the producer only.
6. **Questions from attendees.** Who relays them to the partner's speakers: our moderator,
   or an account for theirs.
7. **Who may hand out a key.** Proposed: the people who hold "See Zoom host details" today.
   The alternative is a permission of its own.
8. **Is the no-build route enough for some partners?** Their speakers as panelists in our
   Zoom webinar needs nothing new.

**Part B**

1. **On demand, scheduled playback, or both,** and which first.
2. **Where the video lives.** Vimeo, as replays do today (proposed), or our own storage.
3. **Watching and the certificate.** Record who watched and how much (proposed: yes). Should
   the survey, and so the certificate, wait until most of the video is watched?
4. **How long an on-demand webinar stays open** by default.

**Both**

5. **When.** No webinar is scheduled. Build part A now, or when the first partner date is
   known (allow two weeks before it, including the rehearsal with their technician).
