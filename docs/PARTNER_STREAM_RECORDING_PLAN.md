# Recording a partner's stream

Status: PLANNED, NOT BUILT (Nov 24, 2026). Owner: "plan it please, partner side for now, we will
use S3 for storage and not disk", and the recording is for both attendees to watch and an archive
file for us and the client.

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
| Do settings sent through the control API survive a restart of the server? | Not found. Planned as if they do not. | Unknown |
| How long is a piece really, with a sender's 2 second keyframes? | The setting is a minimum; where the cut falls is not in the files read. | Unknown |

Not run anywhere yet. Step 0 below proves the unknowns on a throwaway server before any code is
written. I tried to run the server binary on this machine for that and the permission system
refused the download, so step 0 needs either that permission or the owner running one Docker
command.

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
  6 seconds, the folder `/recordings/%path/%Y-%m-%d_%H-%M-%S-%f`, delete after 2 hours. The
  general `all` path inherits them, which is what keeps a per-stream setting "equal apart from
  recording" (section 2, row 2).
- Start: our server calls the control API we already run (`src/lib/webinar/mediamtx-control.ts`),
  adding or patching the setting `live/<key>` with `record: true`. Stop: the same call with
  `record: false`. Nothing else is ever sent in that setting.
- MPEG-TS and not fragmented MP4: each TS piece stands alone, so the pieces are an HLS replay as
  they are, and joined end to end they are the whole programme.
- Settings sent through the API are assumed lost when the stream server restarts. The stream
  watchdog's minute sweep (`worker/jobs/webinar-stream-watchdog.ts`) puts back the setting of
  every recording that should be running, and alerts when a running recording has produced no
  piece for 2 minutes while its stream is live.
- **Never add `action: api` to `authHTTPExclude`** stays true: these calls go through the same
  webhook check as cutting a feed.

### 4.2 Shipping to S3

- A new folder on the box, `recordings/`, is mounted into both the stream server and the worker
  (`docker-compose.prod.yml`). Recreating the stream server container cuts any live stream, so
  this is done between webinars.
- New worker job `stream-recording-ship`, every 10 seconds, singleton like the others. For each
  running recording: every piece except the newest (still being written) is uploaded, recorded as
  a row, then deleted locally. After Stop, the last piece goes too once it has been still for
  5 seconds.
- A piece's length is the gap to the next piece's start time (the file name carries it to the
  microsecond); the last piece's length is read from the file.
- Where: `recordings/{eventId}/{sessionId}/{recordingId}/` (D3 says which bucket). Private,
  registered in `src/lib/upload-prefixes.ts`, read only through signed links.

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
It is finished when the room closes, or when staff press **Finish recording**, or 6 hours after
it began (safety).

All of it lives in a new `src/services/stream-recording-service.ts`, called by the console's
routes and the worker. The key is still read only through `session-stream.ts` and
`external-stream-service.ts`; the test that lists every file naming `streamKey` gains the new
ones. Replacing a partner's key during a recording moves the recording to the new key in the
same service call.

### 4.4 The MP4

- Job `stream-recording-finish`: when every piece is in S3, the pieces are read from S3 in order,
  passed through `ffmpeg` as a copy (no re-encoding), and the MP4 is written back to S3 as it
  comes out. Nothing is written to the box.
- The cost is small because nothing is re-encoded: an estimate of about a minute of one CPU for a
  two hour webinar, measured in step 0. The box averaged 6% CPU over the week before this plan.
- `ffmpeg` is added to the worker image only (D8). The MP4 is the "fragmented" kind, the only kind
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

| | Decision | Proposed |
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
| 0 | **Prove it** on a throwaway stream server with a test stream: switch recording on and off mid-stream and watch that the sender stays connected; the real length of pieces; what a restart does to API settings; a drop and reconnect; pieces joined to an MP4 through `ffmpeg` with no file on disk; the MP4 opened in Chrome, Safari, VLC, QuickTime and uploaded to Vimeo; the pieces played as an HLS replay on an iPhone. | 0.5 |
| 1 | The two tables (additive migration, row policies), `stream-recording-service.ts`, the control API calls, the sweep that puts settings back. | 1 |
| 2 | The shipping job, the disk guard, the waiting-pieces alert. | 1 |
| 3 | The console: agreement tick, Start, Stop, Finish, the REC mark, the Recording tab. | 1 |
| 4 | The finishing job, `ffmpeg` in the worker image, Download, Delete, retention. | 1 |
| 5 | Docs, the user guide, and a production rehearsal with a real partner-style stream of an hour. | 0.5 |
| | **Phase 1** | **5** |
| 6 | The replay rule's third kind, the playlist route, the notice to attendees. | 1 |
| 7 | `ReplayPlayer`, the session page and the portal's replay page. | 1.5 |
| 8 | CloudFront signed links, and a rehearsal on an iPhone and an Android phone. | 1 |
| | **Phase 2** | **3.5** |

Each step is its own commit with its tests, reviewed once, as usual.

## 8. Steps that are the owner's

Handed over as exact commands when their step is reached; none is run by the agent.

- **Before step 2 goes live**, between webinars: create `recordings/` on the box, add it to the
  stream server and the worker in `docker-compose.prod.yml`, put the new `mediamtx.yml` in place,
  recreate the stream server container.
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
- **A recording nobody stops.** It is finished when the room closes, and at 6 hours at the latest.
- **Deleted is not gone at once** in a versioned bucket: the lifecycle rule is what clears it.

## 10. Not in this plan

- Recording Zoom webinars this way. The same switch would work on our own Zoom stream, but
  Zoom's cloud recording already covers it and is the better copy (it does not depend on the
  stream reaching us).
- Editing, trimming, chapters, captions.
- Several qualities for the replay.
- Watch figures for the replay (who watched, for how long).
