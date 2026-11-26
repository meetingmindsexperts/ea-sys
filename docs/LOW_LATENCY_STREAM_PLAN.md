# Shorter delay on the custom stream: plan

**Status: PLANNED, NOT STARTED (Nov 25, 2026; revised Nov 26, 2026 after an outside review).** Production runs
standard HLS (`hlsVariant: mpegts`, 4 second pieces). Nothing in this plan has been changed on the box. It builds on
the decision record in `docs/LIVE_STREAMING.md` §14 (Oct 2, 2026), which weighed the options; read that first. This
file is the order of work, what each step must prove, and what the owner decides.

**What the Nov 26 revision changed.** An outside review found the one real flaw in the first version: it assumed
CloudFront could cache low-latency playlists. MediaMTX's own documentation says they "cannot be cached and are
always requested from the server" (§4, step 3). That makes a load test through CloudFront a step of its own
(step 4), and adds smaller checks to steps 1 and 2. The buffering baseline was also wrong and is corrected below.

## 1. Why now

During MENA HemeConnect Wave 1 (Nov 25, 2026: 242 registered, 102 watched, peak 66 at once, 43 of the 63 watching
at 8:10 pm Dubai on phones) an attendee complained of a 30 second delay. The stream itself was healthy: no drops,
no errors. Buffering over the whole evening was 9.6 seconds per viewer, across an average of 41 minutes watched
(about 14 seconds per viewer-hour), with 27 reconnects the player recovered from on its own. The delay is the
design: one-way HLS behind Zoom's RTMP output.

## 2. Where the 30 seconds comes from

| Part | Estimate | Ours? |
|---|---|---|
| Zoom's room to its RTMP output | 10 to 30 s (third-party reports; Zoom publishes no figure) | No: nothing on our side changes it |
| Our HLS: 4 s pieces, and the player holding about 3 of them | about 12 to 16 s | Yes |

Both are estimates until step 1 measures them on our own pipeline.

**Correction to what was said on the night:** the "hold 2 pieces instead of 3" tweak (hls.js
`liveSyncDurationCount`) reaches only viewers on hls.js. Chrome (since 2025) and Safari play HLS with their own
built-in players (`live-player.tsx`: native first, hls.js otherwise), and their buffer is theirs. On Nov 25 that was
nearly all of the audience (by 8:10 pm Dubai: Chrome 58, Safari 26, Samsung Internet 17, Edge 4, of 106 who opened
the page; Samsung Internet and Edge may run hls.js, which step 2 checks). So that tweak is off the table; low-latency
HLS is the lever, because the built-in players follow the playlist's own low-latency hints.

## 3. What to expect

Low-latency HLS (LL-HLS) splits each piece into sub-second parts and lets the player sit 1 to 3 seconds behind the
newest one. Apple's target is 1 to 2 seconds from live; real deployments report 3 to 7. **Our part should fall from
about 14 s to 3 to 6 s; Zoom's part stays.** If Zoom's part is 15 s, the attendee goes from about 30 s behind to
about 18 to 21 s behind. Step 1 measures Zoom's part, and if it is most of the 30 s, this plan is not worth doing
(§7).

The goal is the shortest delay that still plays reliably on a phone, not the smallest number a lab can reach.

Not considered further (§14.3 of LIVE_STREAMING.md has the reasons): WebRTC (under 1 s, but low hundreds of viewers
per box, no CDN, firewall relays), Amazon IVS (3 to 5 s of its own, so the same 15 to 20 s behind Zoom, at a per
viewer-hour price), more server resources (the delay is packaging, not load; the box was not stretched).

## 4. The steps

Each step has a gate: do not start the next until it passes. Change one thing at a time: never upgrade MediaMTX
and switch the HLS variant in the same test.

### Step 1. Measure (no change anywhere)

On the next practice webinar or rehearsal, with nothing else live:

- In the Webinar Console's Waiting Room card, **Preview the stream**, then **Open the clock page**, share that window
  in Zoom, and press **Measure Zoom delay** (built Oct 2, 2026; LIVE_STREAMING.md §14.8). It reports Zoom's part and
  ours separately.
- **Take at least three readings** across the rehearsal, a few minutes apart, and write down each one, not only the
  average. One reading is not enough to justify a change to the server.
- This also settles the open question in §14.8: whether MediaMTX 1.17.1 writes the arrival stamps
  (`EXT-X-PROGRAM-DATE-TIME`). If "Our delay" reads "estimate", only the total is measurable; record that as the
  measurement's limit.
- Note the stream's bitrate from the browser's network panel (LIVE_STREAMING.md §14.5).

**Gate:** our part is at least 8 seconds of the total, in every reading. That is a decision threshold (what a viewer
would notice), not a technical limit. If Zoom's part is most of it, stop here and tell the organisers the delay is
Zoom's (§7).

### Step 2. Lab test (a laptop, never the box)

Run the same MediaMTX image (`bluenviron/mediamtx:1.17.1`, pinned in `docker-compose.prod.yml`) locally with
`hlsVariant: lowLatency`, fed by OBS or ffmpeg with a keyframe every 2 to 3 seconds (as Zoom sends), behind an nginx
location copied from `deploy/nginx.conf`'s `/stream/`. Read the 1.17.1 configuration reference for the LL-HLS
settings rather than the current documentation, which may describe a newer version. Prove each:

1. **The fMP4 warning.** `mediamtx.yml` says "fmp4 has known 404 issues" (init segments through the proxy;
   LIVE_STREAMING.md §6). LL-HLS needs fMP4. Play for 20 minutes and look for any 404 on `init.mp4` or a part.
2. **Part length.** Try parts of 200 ms, 500 ms and 1 s (`hlsPartDuration`). The setting is a minimum: read the
   playlist and write down the part and segment lengths MediaMTX actually emits (`EXT-X-PART-INF`,
   `EXT-X-TARGETDURATION`), and check them against Apple's HLS authoring rules for part length and round trip time.
   A shorter part is not better if it buffers more on a phone.
3. **Players over HTTPS:** hls.js (Firefox, Edge), Chrome's built-in player, iPhone Safari, Samsung Internet. Apple
   devices use low latency only over HTTPS, so the iPhone test needs a certificate (a tunnel or a local certificate),
   not plain HTTP to the laptop. Each player must play, recover after the network is cut for 10 seconds, and survive
   a keyframe gap that changes mid-stream (the Nov 5, 2026 iPhone freeze). For each, write down which engine played
   it (built-in or hls.js) and whether it actually sat near the live edge: video playing is not proof of low latency.
4. **Waiting requests.** A low-latency player asks for the next part before it exists and the server holds the
   request open. Measure how long MediaMTX holds one, against nginx (the `/stream/` block sets no
   `proxy_read_timeout`, so the 60 s default applies) and CloudFront's origin response timeout (30 s by default).
   Check whether MediaMTX sends delta playlists (`CAN-SKIP-UNTIL` in the playlist, `_HLS_skip` in requests).
5. **Our code that reads the stream:** the stream check (`src/lib/webinar/stream-probe.ts` fetches `index.m3u8`) still
   answers "live"; the player's **Live** button and "behind" readout still work; the console's delay meter reads the
   stamps; a partner stream's recording (`recordFormat: mpegts`, separate from the HLS setting) still ships its pieces
   and the finished MP4 plays.

**Gate:** no 404s, every player plays and recovers over HTTPS, the part lengths are recorded and within Apple's
rules, waiting requests finish well inside both timeouts, and all four checks in item 5 hold.

### Step 3. CloudFront (owner, AWS)

**The problem.** Low-latency players ask for the playlist with `_HLS_msn` and `_HLS_part` (and `_HLS_skip` for a
delta playlist) in the address and wait for the next part. The current cache behaviour for `/stream/*.m3u8`
(HLS_CDN_PLAN.md §5, step 2) keeps no query string in the cache key and forces a 1 s minimum TTL over nginx's
`Cache-Control: no-cache`. Left as it is, every player gets the same cached playlist whatever it asked for, and low
latency quietly does not happen, or stalls.

**What MediaMTX says.** Its scalability page (`docs/2-features/18-scalability.md` in the MediaMTX repository):
"Low-Latency HLS playlists cannot be cached and are always requested from the server, therefore it is often
necessary to disable the Low-Latency HLS variant, introducing significant latency." So the playlist may not be
cacheable at all, and the first version of this plan was wrong to assume it was.

**Two options, both tried on a test behaviour or a test distribution first, never on the live one:**

- **A. Cache keyed on the low-latency query strings.** Cache key: `_HLS_msn`, `_HLS_part`, `_HLS_skip` only (an
  allow list, never every query string), short TTL. The answer to one exact request does not change once given, so
  this may work despite MediaMTX's warning, and CloudFront collapses identical requests into one, which keeps the box
  out of it. Step 2's results decide whether it is safe.
- **B. No caching for playlists.** CloudFront's caching-disabled policy, with an origin request policy that forwards
  the same three query strings. Always correct, but every viewer's playlist requests reach the box (several a second
  each), so step 4 must show the box can take it.

Parts, segments and `init.mp4` keep a cache behaviour of their own (check that the part file names are fixed once
written, as segments are). Access control does not change: stream reads are already open to whoever has the address
(`authHTTPExclude: read` in `mediamtx.yml`), the page decides who may watch, and MediaMTX's `hlsCDNSecret` only lets
it recognise CloudFront, it does not check viewers.

Written out as console steps for the owner before step 4; nothing is run by the developer (house rule: AWS changes
are the owner's).

**Gate:** through the test path, two requests with different `_HLS_msn` values get different answers; ten
requests at once for the same position all get the right playlist; a waiting request completes and is not cut off;
parts and `init.mp4` are served (from cache where option A or the part behaviour allows).

### Step 4. Load test through CloudFront (the test path, a quiet day)

With option A or B from step 3 on the test path and a stream running on the box, use k6 (`loadtest/` already holds
k6 scripts) to act as low-latency players: fetch the playlist with the query strings the way a player does, then the
parts. Run 20, then 50, 100 and 200 at once (200 is about three times the Nov 25 peak; raise it if a larger webinar
is booked). Watch:

- playlist requests a second reaching the box (nginx's access log), and CloudFront's cache hit rate;
- the box's CPU and memory, MediaMTX's and nginx's;
- 4xx and 5xx from CloudFront and from nginx;
- how long a playlist request takes from the edge.

Then work out the cost from what was measured: requests per viewer-hour (total CloudFront requests divided by
viewer-hours), priced at AWS's current per-request rate, instead of an assumed number of requests per viewer.

k6 sends HTTP requests; it does not play video. Step 2 is still the proof that players work.

**Gate:** at 200 the box stays below about half its CPU, no errors, playlist answers stay fast. If option B
overloads the box and option A is not safe, stop: low latency would need a different design (MediaMTX's own advice
is to turn it off behind a CDN), and §7 applies.

### Step 5. Production trial (owner restarts MediaMTX; no event that day)

1. Book a practice webinar with no other stream live, and nothing scheduled in the 30 minutes around it.
2. Owner: put the step 3 behaviour on the live distribution; on the box, `hlsVariant: lowLatency` (and the part
   length step 2 chose) in `mediamtx.yml`, then restart the MediaMTX container (`deploy.sh` does not restart it). Live
   streams drop on a restart, which is why nothing else may be live.
3. Measure as in step 1, three readings. Test on an iPhone, an Android phone on 4G, Chrome and Safari on a laptop.
   Watch the box's CPU and CloudFront's request count. Start and stop a partner recording if one is set up.
4. **Rollback:** `hlsVariant: mpegts` and the same restart, then the old CloudFront behaviour. No app code or
   database change is involved. After a rollback, check standard playback and recording, and write down why.

**Gate:** our part is under 6 seconds on every device, buffering is no worse than Nov 25 (about 14 seconds per
viewer-hour), no 404s.

### Step 6. Keep it, or choose per webinar

If step 5 holds, decide (§6, decision 2) between:

- **Low latency for every webinar.** Simplest, and the recommended start. Every webinar gets the shorter delay and
  the smaller safety margin.
- **A per-webinar setting** (LIVE_STREAMING.md §14.6): MediaMTX stays on low latency, and a webinar marked
  "Standard" plays with the normal buffer. This needs player code (hls.js for everyone on such a webinar, because the
  built-in players choose low latency on their own, and iPhones may not allow it at all), so it is only worth
  building if real webinars show stability matters more than seconds for some of them.

Then update `mediamtx.yml` in the repo (the comment on `hlsVariant` and the 404 note), LIVE_STREAMING.md §6 and §14,
HLS_CDN_PLAN.md (the playlist behaviour), the player's `BEHIND_LIVE_THRESHOLD_S` / `LIVE_EDGE_OFFSET_S` (they assume
4 s pieces), and `docs/WEBINAR_TROUBLESHOOTING.html` (what attendees see when they are behind).

**Small addition worth making then:** the player already reports stalls and reconnects for the attendance figures.
Adding which engine played (built-in or hls.js) and how far behind live the viewer sat would show, per webinar,
whether low latency is reaching people. No viewer details beyond what the attendance figures already hold.

## 5. Cost and risk

- **Money:** bandwidth is unchanged (the same video). Requests rise to several a second per viewer; step 4 measures
  the real number and prices it. Expect a few dollars per large webinar, not more.
- **Load on the box:** if playlists cannot be cached (step 3, option B), every viewer's playlist requests reach the
  box. Small requests, but many; step 4 is there to measure it before any webinar depends on it.
- **More buffering on weak connections:** a smaller buffer leaves a phone on 4G less margin. Our audiences are
  mostly mobile (43 of the 63 watching at 8:10 pm on Nov 25). Step 5 measures it; it is the main reason to keep a way
  back.
- **One setting for the whole server:** while it is on, every stream is low latency, including a partner's.
- **A restart drops live streams:** every switch, either way, is done with nothing live.

## 6. Decisions for the owner

1. **Go ahead with step 1** (measure only) on the next rehearsal? It costs nothing and decides whether the rest is
   worth doing.
2. After step 5: **every webinar, or a per-webinar setting** (§4, step 6).
3. **What buffering is acceptable** in exchange for the shorter delay (the step 5 gate uses Nov 25's figure, about
   14 seconds per viewer-hour).

## 7. If it is mostly Zoom's delay, or low latency cannot sit behind CloudFront

Then no server change helps, and the honest answer for organisers is:

- Q&A typed on our page reaches the moderator in real time; only the video is behind. Moderators can say so when
  they open questions ("we will take questions in a minute, the stream runs a little behind").
- For a webinar where real time matters (a live debate, an interactive workshop), use the **Zoom embed** viewing
  mode: real time, at the cost of a Zoom webinar seat per viewer.

## Sources

- [Apple: Enabling Low-Latency HLS](https://developer.apple.com/documentation/http-live-streaming/enabling-low-latency-http-live-streaming-hls.md)
- [Apple: HLS authoring specification](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices)
- [Apple WWDC20: What's new in low-latency HLS](https://developer.apple.com/wwdc20/10228)
- [MediaMTX: scalability (CDN), repository docs](https://github.com/bluenviron/mediamtx/blob/main/docs/2-features/18-scalability.md)
- [MediaMTX: HLS](https://github.com/bluenviron/mediamtx/blob/main/docs/4-read/06-hls.md)
- [MediaMTX LL-HLS defaults, third-party test](https://computingforgeeks.com/?p=180693)
- [AWS: CloudFront cache keys](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/controlling-the-cache-key.html) and [origin request policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/controlling-origin-requests.html)
- [AWS: CloudFront origin response timeout](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValues.html)
- [Recall.ai: Zoom RTMP latency](https://www.recall.ai/blog/zoom-rtmp-live-streaming-integration-pros-and-cons)
- [Airmeet: Zoom into Airmeet via RTMP](https://help.airmeet.com/support/solutions/articles/82000443205-how-to-stream-zoom-meeting-into-airmeet-session-via-rtmp)
- [Amazon IVS features](https://aws.amazon.com/ivs/features/) and [pricing](https://aws.amazon.com/ivs/pricing/)
- [hls.js API (liveSyncDurationCount)](https://github.com/vitalibozhko/hls.js/blob/master/docs/API.md)
- [Mux: Reduce live stream latency](https://www.mux.com/docs/guides/reduce-live-stream-latency)
- [Grafana k6](https://grafana.com/docs/k6/latest/)
