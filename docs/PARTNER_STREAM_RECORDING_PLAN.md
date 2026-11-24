# Recording a partner's stream

Status: IN BUILD (Nov 24, 2026). Steps 1 and 2 of 8 are built and dark (`STREAM_RECORDING_ENABLED` unset);
step 0, the proof on a throwaway stream server, is done (2.1). Owner: "plan it please, partner side for now, we will use S3 for storage and
not disk", the recording is for both attendees to watch and an archive file for us and the client,
then "ok fine, proceed" on the proposals of section 6.

This replaces option 3 of section 4.7 in
[EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md](EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md) ("we record
it", then proposed for later). Zoom webinars are out of scope: Zoom's cloud recording already runs
for them and feeds the replay.

## 1. In short

- An organiser presses **Start recording** in the Webinar Console (or ticks "record when the
  stream starts"). The stream server writes the partner's stream in pieces of about 6 seconds.
  Our worker moves each piece to S3 within seconds and removes it from the box.
- When the webinar is over, one **MP4 file** is made from the pieces, for staff to download and
  hand to the client.
- Attendees watch the replay in one of two ways, the owner chooses (D1): staff upload the MP4 to
  Vimeo as today (nothing more to build), or our page plays the recording itself (phase 2).
- **Phase 1** (record, S3, MP4, download) is about 5 working days. **Phase 2** (our page plays it)
  is about 3.5 more, plus AWS steps that are the owner's.

This is more than the "about 3 days" I gave before the plan. That figure was for writing one file
to the box's disk and moving it at the end. Keeping the recording off the disk, and attendees
watching it, are both additions.

## 2. What is proven and what is not

Read in the stream server's own source code, MediaMTX v1.17.1, the version production runs
(`internal/core/path_manager.go`, `path.go`, `mediamtx.yml`, `docker/standard.Dockerfile`):

| Question | Answer | How sure |
|---|---|---|
| Can recording be switched on and off while a stream is live, without cutting the sender? | Yes. A change to recording settings alone is applied in place: the recorder is started or closed and the stream is kept. | Read in the source |
| Can it be switched for one stream and not the others? | Yes. A setting named for that one stream (`live/<key>`) that differs from the general one only in recording fields is taken over by the live stream without a disconnect. Any other difference disconnects the sender. | Read in the source |
| Can the server write straight to S3? | No. It writes to a local folder only. | Read in the config and README |
| Can the server run a command when a piece is finished? | It has the hook, but the production image has no shell, so the hook cannot run anything. | Read in the Dockerfile |
| Formats | Fragmented MP4 or MPEG-TS. | Read in the config |
| Do settings sent through the control API survive a restart of the server? | No: they are forgotten. The minute sweep puts them back. | Run in step 0 |
| How long is a piece really, with a sender's 2 second keyframes? | 6 to 8 seconds: the cut is at the first keyframe after the minimum. | Run in step 0 |

### 2.1 Step 0: run on a real server (Nov 24, 2026)

Run against MediaMTX 1.17.1 in Docker on the owner's machine (the production image, production's
stream settings plus the recording defaults of 4.1), with a 720p test stream at 2.5 Mbps and
2 second keyframes. 15 of 15 checks passed.

| Checked | Result |
|---|---|
| Start while the stream is live | The sender's connection stayed the same one; pieces appeared within seconds. |
| Stop, then Start again | Same connection throughout; no piece written while stopped. |
| Removing the setting while live | Same connection; recording stopped. |
| The sender drops and reconnects while recording | Recording carried on by itself. |
| Armed before the stream starts | Recording began with the first frame. |
| The control API's answers | As the code assumes: 200 `{"status":"ok"}` for a change, 404 with MediaMTX's error body for a setting that is not there. |
| A setting with nobody publishing | The path is listed with `source: null`, which our readers already take as "nobody". |
| The pieces | 6 to 8 seconds each (cut at the first keyframe after 6 seconds), about 2.2 MB, named by their start time. The last piece before a stop is short (1.3 seconds). |
| One MP4 through a pipe | 15 MB of pieces joined in 47 ms. 45.3 seconds from 45.8 seconds of pieces: the 12 second pause is closed up, not frozen through. |
| The MP4 in a browser | Plays, and seeks across the pause, the reconnect and to the end, with no error. |
| The pieces as an HLS replay | Plays and seeks the same way, with a break mark at the pause and at the reconnect. |

What it changed in the plan:

- **A piece's length must be measured, not inferred.** The first draft took it as the gap to the
  next piece's start. Across a stop or a drop that counts the pause as video (13.4 seconds for a
  1.3 second piece), and the replay's timeline came out 15 seconds too long. Step 2 reads each
  piece's own length (`ffprobe`, so `ffmpeg` joins the worker image at step 2, not step 4).
- **A break is where a piece does not follow on**: the next piece starts more than a second
  after this one ends, by the clock in their names.
- **File names carry the stream server's own clock zone** (UTC in the container), so the setting
  uses the Unix time form, `%s-%f` (`1795512296-718063.ts`): no zone is ever assumed. Run on the
  throwaway server: the names fell inside the sender's own start and end times.

Small things seen, none blocking: the MP4's first frame is held for 2 seconds (the recording
starts between keyframes); `ffmpeg` reports three out-of-order timestamps at the joins, which
players pass over; QuickTime and Vimeo's upload are not yet tried on the MP4.

**A restart of the stream server forgets every setting made through the control API** (run: the
setting answered 404 after `docker restart`), as the code already assumes; the pieces already on
disk are kept. So a stream server restart during a webinar stops recording until the minute
sweep puts the setting back, a gap of up to a minute on top of the stream's own drop.

## 3. Why the disk is still touched, and how little

"S3 and not disk" cannot be met literally: the stream server can only write to a folder. The
design keeps the folder as a few seconds of buffer and S3 as the only store.

- Pieces are about 6 seconds, 2 to 3.5 MB each. The worker ships every finished piece on a
  10 second beat and deletes it locally. In normal running the folder holds under 20 MB.
- If the worker is down, pieces wait in the folder. The server itself deletes any piece older than
  2 hours (`recordDeleteAfter`), so the worst case is about 4 GB per recording stream, on a disk
  with 18 GB free today (50 GB, 63% used, read from CloudWatch on Nov 24, 2026).
- Start is refused when the disk has less than 6 GB free, and the event's admins are alerted when
  pieces are waiting for more than 2 minutes.
- A deploy does not interrupt a recording: the stream server is not part of the blue and green
  swap (`scripts/deploy.sh`), and a worker restart only delays the shipping by under a minute.

The alternative, the worker copying the live HLS pieces out of the stream server with no disk at
all, was rejected: the server keeps only 28 seconds of them, so a worker restart during a webinar
would leave a hole in the recording that nothing can fill.

## 4. How it works

### 4.1 Recording

- `mediamtx.yml` gains the recording defaults with recording off: format MPEG-TS, pieces of
  6 seconds, the folder `/recordings/%path/%s-%f` (Unix time, 2.1), delete after 2 hours. The
  general `all` path inherits them, which is what keeps a per-stream setting "equal apart from
  recording" (section 2, row 2).
- Start: our server calls the control API we already run (`src/lib/webinar/mediamtx-control.ts`),
  adding or patching the setting `live/<key>` with `record: true`. Stop: the same call with
  `record: false`. Nothing else is ever sent in that setting.
- MPEG-TS and not fragmented MP4: each TS piece stands alone, so the pieces are an HLS replay as
  they are, and joined end to end they are the whole programme.
- Settings sent through the API are assumed lost when the stream server restarts. The stream
  watchdog's minute sweep (`src/lib/webinar/stream-recording-sweep.ts`) makes the stream server
  hold what every open recording says, and keeps removing the setting of a closed one until the
  stream server confirms it is gone. It only finds which recordings to look at; each is then read
  afresh and worked in its own organisation, because acting on a list a minute old undid a Stop
  pressed meanwhile (review of step 1). From step 2 it also alerts when a running recording has
  produced no piece for 2 minutes while its stream is live.
- The recording defaults go under `pathDefaults:` in `mediamtx.yml`, never under `paths: all:`.
  A setting made through the API is built from the defaults, and the sender stays connected only
  while that and the general `all` entry differ in recording fields alone. A test reads
  `mediamtx.yml` and fails if `all` gains anything but its default source.
- **Never add `action: api` to `authHTTPExclude`** stays true: these calls go through the same
  webhook check as cutting a feed.

### 4.2 Shipping to S3

Built in step 2 (Nov 24, 2026), changed from the first draft by what step 0 and the code found:

- A new folder on the box, `recordings/`, mounted into the stream server (read and write) and
  into the worker **read-only** (`docker-compose.prod.yml`). The stream server writes as root and
  the worker runs as user 1001, so the worker could not delete a piece anyway; instead it asks
  the stream server to (`DELETE /v3/recordings/deletesegment`, run on the throwaway server:
  deleted by its exact start, refused a path with `..`). No container changes its user.
  Recreating the stream server container cuts any live stream, so its mount waits for the
  owner, between webinars; the worker's mount arrives with the next deploy, as an empty folder.
- New worker job `stream-recording-ship`, **every minute** at second 15 (first draft: every
  10 seconds; each run writes a JobRun row and a lease, kept 14 days, and a minute of video is
  about 25 MB). For each recording that is recording, stopped or finishing, inside its own tenant
  (`src/services/stream-recording-shipping.ts`), in **two passes**: first every finished piece not
  yet shipped, oldest first, is read, measured, uploaded and given its row (the totals in the same
  transaction); then, with the time left, the stream server is asked to delete what is shipped or
  unwanted, stopping at the first delete that fails. Shipping first is the review of step 2: with
  the deletes first, a backlog of deletes timing out took each run's whole time, and the stream
  server's two-hour clean-up would then remove footage never shipped. A piece is finished when a
  newer one exists, or when it has not changed for 20 seconds, but the newest never while the
  stream is live and being recorded (a sender that stalls without disconnecting). A run stops
  starting work after 20 seconds and the next takes the rest.
- **A piece's length is read from the timestamps inside it** (`src/lib/webinar/mpegts-duration.ts`),
  in plain code: it matched `ffprobe` to the millisecond on six real pieces with B-frames. So the
  worker image needs no video tools for this step; `ffmpeg` is a step 4 question (the MP4).
- A piece **recorded while the organisers said not to record** (begun inside ANY pause of the
  recording, after Finish, or before the recording began: the stream server was told late, or a
  leftover under the same key) is deleted and never shipped (`pieceWanted`,
  `src/lib/webinar/recording-pieces.ts`). Every pause is kept on the recording (`pauses`, a JSON
  list, migration `20261124120000`): knowing only the last let an earlier pause's footage back in
  after a later Stop (review of step 2). A piece that would be numbered behind one already
  shipped is dropped and said, never put out of order.
- A file error is logged by its code alone: the buffer folder is named by the stream key, and
  Node's file errors repeat their path. A piece over 100 MB is dropped and said, never left to hold
  up the rest. A piece whose length cannot be read is timed by the gap to the next one.
- Safe to stop anywhere: the upload goes to the same name, a piece whose row exists is only
  deleted, a row is never written twice. Pieces go strictly in order and a run stops at the first
  that fails to ship. A failed DELETE does not stop it: with the stream server's API down for two
  hours, its own clean-up would otherwise delete every piece never shipped.
- Said, once in ten minutes per recording: pieces left over two minutes (error,
  `stream-recording-ship:pieces-waiting`); a recording that should be running with nothing new
  for two minutes while its stream is live (`stream-recording-ship:live-but-not-recording`).
- Where: `recordings/{eventId}/{sessionId}/{recordingId}/{piece}`, private, registered in
  `src/lib/upload-prefixes.ts`, read only through signed links.
- Start is refused when the disk has less than 6 GB free, or when that could not be read
  (pessimistic), asked from the app's own container (`src/lib/webinar/recording-disk.ts`): on
  the box all containers and the buffer share one disk.

### 4.3 The record

Two new tables, additive, each with `organizationId` and a row policy file in `prisma/rls/` from
the first day:

- `StreamRecording`: one per session. Status (`RECORDING`, `PAUSED`, `FINISHING`, `READY`,
  `FAILED`), who started it and when, the partner's agreement (who ticked it, when), totals
  (pieces, bytes, length), the MP4's place and size, the error if any, and when it is to be
  deleted (D4).
- `StreamRecordingSegment`: one per piece: order, start time, length, bytes, place, and whether it
  follows a break (the stream dropped, or recording was paused).

One recording per webinar. Stop and Start again continue the same recording with a break marked.
It is finished when the room closes, or when staff press **Finish recording**, or by the sweep
6 hours after the webinar's scheduled end or after recording was last started, whichever is later
(safety). Not counted from when the recording was made: Start before the stream arms it, possibly
hours early.

All of it lives in a new `src/services/stream-recording-service.ts`, called by the console's
routes and the worker. The key is still read only through `session-stream.ts` and
`external-stream-service.ts`; the test that lists every file naming `streamKey` gains the new
ones. Replacing a partner's key changes its password only, never the key itself, so a recording
carries on through it.

### 4.4 The MP4

- Job `stream-recording-finish`: when every piece is in S3, the pieces are read from S3 in order,
  passed through `ffmpeg` as a copy (no re-encoding), and the MP4 is written back to S3 as it
  comes out. Nothing is written to the box.
- The cost is small because nothing is re-encoded: an estimate of about a minute of one CPU for a
  two hour webinar, measured in step 0. The box averaged 6% CPU over the week before this plan.
- `ffmpeg` in the worker image only (D8), added at this step; step 2 did not need it (4.2). The MP4 is the "fragmented" kind, the only kind
  that can be written without a disk. Browsers, VLC, QuickTime and Vimeo's upload are expected to
  take it; step 0 checks each on a real file before anything depends on it.
- Staff download it from the console's Recording tab through a 5 minute signed link
  (`signStoredFileDownload`), every download audited.

### 4.5 The console

In the **Partner stream** card and the **Recording** tab:

- Before the webinar: the tick "The partner has agreed to this recording" (D5), and "Start
  recording when the stream starts".
- During: **Start recording**, **Stop**, **Finish recording**, a red REC mark with the time
  recorded and the size so far, and a warning line when pieces are waiting on the box.
- After: the MP4 with its size and length, **Download**, **Delete recording** (confirmed, audited).
- Permission: `webinar.manage`, the key the partner stream card already asks (D7). Each action is
  written to the audit log and to the stream timeline.
- Shown only on a server set up for it (`STREAM_RECORDING_ENABLED`, like the presentations switch),
  so a server without the folder and the S3 rule never offers a button that cannot work.

### 4.6 Attendees watch: phase 2

Only if D1 says our page plays the recording.

- `src/lib/webinar/replay.ts` stays THE rule and gains a third kind, "recorded". Order: the
  organiser's Vimeo link, then our recording, then Zoom's. Only when the recording is `READY`, the
  webinar is over and "Show the recording to attendees" is on. The session page, the portal's
  replay page and the emails all follow, because they already ask that rule.
- New public route `GET .../sessions/[sessionId]/replay-playlist`, behind
  `viewer-entitlement.ts` like the recording route, rate limited. It answers an HLS playlist built
  from the piece rows, each line a signed link (D2), with a break mark where the stream dropped.
- New `ReplayPlayer`: the browser's own controls with a seek bar (the live player has none, by
  design), hls.js where the browser needs it, the full screen behaviour of the live player.
- One quality only: what the partner sent. Several qualities means re-encoding, which this box
  cannot do; AWS MediaConvert could, at roughly half a dollar to a few dollars per hour of video
  depending on the qualities made (an estimate, not priced for our case), if weak phone
  connections turn out to matter.

## 5. Costs

| | 720p at 2.5 Mbps | 1080p at 4.5 Mbps |
|---|---|---|
| One hour recorded | 1.1 GB, about 600 pieces | 2 GB, about 600 pieces |
| S3 storage, per month | about 3 cents | about 5 cents |
| The MP4 as well (kept beside the pieces) | double the above | double the above |
| Uploading the pieces (requests) | under 1 cent | under 1 cent |
| Copy to Singapore, if kept in the DR copy (D3) | about 10 cents, once | about 17 cents, once |
| One attendee watching one hour (phase 2), data | 1.1 GB | 2 GB |

Storage is never the cost. If phase 2 is not built, the pieces can be deleted once the MP4 is
`READY`, which halves the storage.

### 5.1 What watching costs (researched Nov 24, 2026)

The first version of this plan said 200 attendees watching a one hour replay cost about 25
dollars. That was the price per GB with the free allowance left out. Read on AWS's own pricing
pages on Nov 24, 2026:

| Route to the viewer | Free every month | After that, per GB |
|---|---|---|
| **S3 behind CloudFront** (pay as you go) | 1 TB of data and 10 million requests, "Always Free" | $0.109 India, $0.110 Middle East, $0.085 Europe and North America |
| S3's own signed links | 100 GB, shared by everything we run on AWS | about $0.11 from Mumbai (not shown on the page read; our earlier figure) |
| Through our app, the way photos and banners are served today | the same 100 GB | the same, and it uses the box's memory and network |

- S3 to CloudFront is free ("free for origin fetches from any AWS origin").
- 1 TB is about **885 viewer-hours a month at 720p**, or 500 at 1080p. Requests are not the
  limit: 600 an hour per replay viewer, so 10 million is over 16,000 viewer-hours.
- **The free TB is shared with live viewing**, which uses the same account. A month with one
  300 viewer live hour (about 340 GB) and 200 replay hours (about 225 GB) is still free.
- What we use today: the live distribution has served 2.76 GB in total since it went live on
  Nov 9, 2026 (CloudWatch), which is 0.3% of one month's allowance.
- If a month ever passes 1 TB: CloudFront's flat Pro plan is 15 dollars a month for one
  distribution with 50 TB and 10 million requests and no overage bill (past the allowance AWS
  may serve from fewer or farther locations). An extra TB at pay as you go is about 110 dollars.
- Looked at and not needed at this size: Cloudflare R2 (no charge for data out, $0.015 per GB
  stored, a second vendor to run), Bunny CDN ($0.06 per GB in the Middle East, no free TB).

So watching is free at our size **only through CloudFront**. Our own photos and banners are in
the same S3 bucket but are served through the app (`src/app/uploads/[...path]/route.ts`, which
reads the whole file into memory and sends it from the box). That is right for a 200 KB image
and wrong for video: a viewer-hour is the size of about five thousand images.

CPU: recording and shipping copy bytes that are already arriving. Expect a few percent of one CPU
per recording and almost no memory. Disk writes are under 1 MB a second against a volume rated
for 125.

## 6. Decisions that are the owner's

**Decided Nov 24, 2026** (owner: "ok fine, proceed"): each as proposed below. D1 means phase 1 is
built first and attendees watch through Vimeo until phase 2; D2 follows the research of 5.1.

| | Decision | Proposed, and decided |
|---|---|---|
| D1 | How attendees watch: staff upload the MP4 to Vimeo (works on phase 1 alone), or our page plays the recording (phase 2). | Phase 1 first, with Vimeo. Phase 2 once a real recording has been seen. |
| D2 | If phase 2: links through CloudFront with its own signing key, or S3's signed links. | CloudFront. It is the route with 1 TB free a month, against 100 GB (5.1); S3 links signed by the box also stop working when the box's credentials rotate, which can be mid-viewing; and CloudFront is closer to viewers. More AWS steps. |
| D3 | Where: the uploads bucket under `recordings/` (as presentations), or a bucket of its own. And whether recordings are in the hourly copy to Singapore. | The uploads bucket, with a rule that clears old versions; in the Singapore copy, since a client's archive is not replaceable. |
| D4 | How long a recording is kept. | 12 months, then deleted, changeable per recording. Staff can delete sooner. |
| D5 | The partner's agreement: a tick that must be made before recording can start, stored with who and when. | Yes. Many sponsored webinars are deliberately not kept. |
| D6 | Attendees are told: "This webinar is being recorded" on the page while it records. | Yes. Attendees are not in the picture (the stream is one way), but the speakers are. |
| D7 | Who may record, download and delete. | The people who hold `webinar.manage`, as for the partner stream card. |
| D8 | What makes the MP4: `ffmpeg` in our worker, or AWS MediaConvert. | `ffmpeg`: no new AWS service, and the work is a copy. |

## 7. Steps

| | Step | Days |
|---|---|---|
| 0 | **DONE Nov 24, 2026** (2.1). Prove it on a throwaway stream server with a test stream: switch recording on and off mid-stream and watch that the sender stays connected; the real length of pieces; what a restart does to API settings; a drop and reconnect; pieces joined to an MP4 through `ffmpeg` with no file on disk; the MP4 opened in Chrome, Safari, VLC, QuickTime and uploaded to Vimeo; the pieces played as an HLS replay on an iPhone. | 0.5 |
| 1 | **BUILT Nov 24, 2026.** The two tables (additive migration `20261124100000`, row policies), the rules (`src/lib/webinar/stream-recording.ts`), `stream-recording-service.ts` (start, stop, finish), the control API calls (`setPathRecording`, `clearPathRecording`, the body pinned to `record` alone), and the sweep that puts settings back and closes a recording nobody finished, run from the stream watchdog job. Nothing calls start yet. | 1 |
| 2 | **BUILT Nov 24, 2026** (4.2). The shipping job, the disk guard, the waiting-pieces and not-recording alerts, the piece length reader, the stream server's recording defaults in `mediamtx.yml`, and the two mounts. | 1 |
| 3 | The console: agreement tick, Start, Stop, Finish, the REC mark, the Recording tab. | 1 |
| 4 | The finishing job, `ffmpeg` in the worker image, Download, Delete, retention. | 1 |
| 5 | Docs, the user guide, and a production rehearsal with a real partner-style stream of an hour. | 0.5 |
| | **Phase 1** | **5** |
| 6 | The replay rule's third kind, the playlist route, the notice to attendees. | 1 |
| 7 | `ReplayPlayer`, the session page and the portal's replay page. | 1.5 |
| 8 | CloudFront signed links, and a rehearsal on an iPhone and an Android phone. | 1 |
| | **Phase 2** | **3.5** |

Each step is its own commit with its tests, reviewed once, as usual.

**Owed by later steps, noted while building step 1:**

- Step 3: the room closing calls `finishStreamRecording` (reason `room-closed`). Deleting a
  session or an event already removes that stream's recording setting from the stream server
  (`capturePartnerStreamsBeforeDelete`, with the key captured before the delete), since the
  recording's row goes with the session and the sweep can no longer know. If that one call
  fails nothing retries it: the key is dead and its sender disconnected, so the setting records
  nothing, and it is gone at the stream server's next restart.
- Step 3: whoever starts a recording must name its organisation (`StartCaller`). A start fired
  by the stream beginning, where no organisation is at hand, reads it from the event first.
- Set `STREAM_RECORDING_ENABLED` only AFTER the `mediamtx.yml` change is on the box. Before it,
  a recording would use the stream server's own defaults: fragmented MP4, inside the container,
  kept a day.
- Step 4: nothing moves a recording out of `FINISHING` until the finishing job exists, which is
  why the switch stays off until then. Deleting an event or a session removes the rows by
  cascade and leaves the files, so step 4 also needs the sweep that clears files no row claims
  (as the supporting documents prune does).
- A setting made through the control API makes the stream server list that path even with
  nobody publishing. The readers in `mediamtx-control.ts` already take a path without a source
  as "nobody"; step 0 confirms it on a real server.
- The sweep finds recordings across organisations in the privileged lane and works each in its
  own, so it is right on an instance with row policies too.

## 8. Steps that are the owner's

Handed over as exact commands when their step is reached; none is run by the agent.

- **Before recording is switched on**, between webinars (the stream server is restarted, which
  cuts any live stream): on the box, from `/home/ubuntu/ea-sys` after a deploy that carries
  step 2, check the new `mediamtx.yml` loads in a throwaway copy, then recreate the stream server
  so it picks up its new mount and settings, and check it is up:
  `docker run --rm -v "$PWD/mediamtx.yml:/mediamtx.yml:ro" bluenviron/mediamtx:1.17.1` (it must
  start without a config error; stop it with Ctrl-C), then
  `docker compose -f docker-compose.prod.yml up -d --force-recreate mediamtx` and
  `docker logs ea-sys-mediamtx --since 1m`. The recordings folder appears on its own.
- **S3**: a lifecycle rule on `recordings/` (old versions cleared, unfinished uploads cleared
  after a day), and whether the Singapore copy includes it (D3). The box's role should already
  reach that prefix, since it reads and writes the rest of the bucket; checked at that step.
- **Then** `STREAM_RECORDING_ENABLED=true` on the box.
- **Phase 2 only**: the bucket as a second origin of the CloudFront distribution, readable only
  by CloudFront, a signing key, and a behaviour for the replay path; the private key into the
  box's `.env`.

## 9. What can go wrong

- **The stream drops and comes back.** The recording carries on with a break marked; the MP4 has
  a jump at that point. Step 0 checks the MP4 still plays through it.
- **The stream server restarts mid-webinar.** The stream itself drops, as today. Recording comes
  back within a minute, when the sweep puts the setting back.
- **The recording is exactly what was sent**: holding slides, a test pattern, a technician's
  voice before the start. Start and Stop are the only edit. Trimming is not planned.
- **A long webinar at 1080p** is 2 GB an hour. Nothing on the box grows with it, only S3.
- **Two webinars recorded at once** double the buffer and the shipping, both small. The 6 GB
  disk guard is per start.
- **The picture is single quality.** An attendee on a weak connection may buffer in phase 2.
- **A recording nobody stops.** It is finished when the room closes, and by the sweep 6 hours
  after the webinar's scheduled end at the latest.
- **Deleted is not gone at once** in a versioned bucket: the lifecycle rule is what clears it.

## 10. Not in this plan

- Recording Zoom webinars this way. The same switch would work on our own Zoom stream, but
  Zoom's cloud recording already covers it and is the better copy (it does not depend on the
  stream reaching us).
- Editing, trimming, chapters, captions.
- Several qualities for the replay.
- Watch figures for the replay (who watched, for how long).
