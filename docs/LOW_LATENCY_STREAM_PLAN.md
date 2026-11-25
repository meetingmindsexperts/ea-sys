# Shorter delay on the custom stream: plan

**Status: PLANNED, NOT STARTED (Nov 25, 2026).** Production runs standard HLS (`hlsVariant: mpegts`, 4 second
pieces). Nothing in this plan has been changed on the box. It builds on the decision record in
`docs/LIVE_STREAMING.md` §14 (Oct 2, 2026), which weighed the options; read that first. This file is the order of
work, what each step must prove, and what the owner decides.

## 1. Why now

During MENA HemeConnect Wave 1 (Nov 25, 2026, 63 watching, 43 of them on phones) an attendee complained of a
30 second delay. The stream itself was healthy: no drops, about 3 seconds of buffering per viewer across the
evening. The delay is the design: one-way HLS behind Zoom's RTMP output.

## 2. Where the 30 seconds comes from

| Part | Estimate | Ours? |
|---|---|---|
| Zoom's room to its RTMP output | 10 to 30 s (third-party reports; Zoom publishes no figure) | No: nothing on our side changes it |
| Our HLS: 4 s pieces, and the player holding about 3 of them | about 12 to 16 s | Yes |

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

Not considered further (§14.3 of LIVE_STREAMING.md has the reasons): WebRTC (under 1 s, but low hundreds of viewers
per box, no CDN, firewall relays), Amazon IVS (3 to 5 s of its own, so the same 15 to 20 s behind Zoom, at a per
viewer-hour price), more server resources (the delay is packaging, not load; the box was not stretched).

## 4. The steps

Each step has a gate: do not start the next until it passes.

### Step 1. Measure (no change anywhere)

On the next practice webinar or rehearsal, with nothing else live:

- In the Webinar Console's Waiting Room card, **Preview the stream**, then **Open the clock page**, share that window
  in Zoom, and press **Measure Zoom delay** (built Oct 2, 2026; LIVE_STREAMING.md §14.8). It reports Zoom's part and
  ours separately.
- This also settles the open question in §14.8: whether MediaMTX 1.17.1 writes the arrival stamps
  (`EXT-X-PROGRAM-DATE-TIME`). If "Our delay" reads "estimate", only the total is measurable.
- Note the stream's bitrate from the browser's network panel (LIVE_STREAMING.md §14.5).

**Gate:** our part is at least 8 seconds of the total. If Zoom's part is most of it, stop here and tell the
organisers the delay is Zoom's (§7).

### Step 2. Lab test (a laptop, never the box)

Run the same MediaMTX image (`bluenviron/mediamtx:1.17.1`, pinned in `docker-compose.prod.yml`) locally with
`hlsVariant: lowLatency`, fed by OBS or ffmpeg with a keyframe every 2 to 3 seconds (as Zoom sends), behind an nginx
location copied from `deploy/nginx.conf`'s `/stream/`. Prove each:

1. **The fMP4 warning.** `mediamtx.yml` says "fmp4 has known 404 issues" (init segments through the proxy;
   LIVE_STREAMING.md §6). LL-HLS needs fMP4. Play for 20 minutes and look for any 404 on `init.mp4` or a part.
2. **Players:** hls.js (Firefox, Edge), Chrome's built-in player, iPhone Safari, Samsung Internet. Each must play,
   recover after the network is cut for 10 seconds, and survive a keyframe gap that changes mid-stream (the Nov 5,
   2026 iPhone freeze).
3. **Our code that reads the stream:** the stream check (`src/lib/webinar/stream-probe.ts` fetches `index.m3u8`) still
   answers "live"; the player's **Live** button and "behind" readout still work; the console's delay meter reads the
   stamps; a partner stream's recording (`recordFormat: mpegts`, separate from the HLS setting) still ships its pieces.
4. **Load:** requests a second per viewer, and MediaMTX's CPU, with 20 players open.

**Gate:** no 404s, every player plays and recovers, all four checks in item 3 hold.

### Step 3. CloudFront (owner, AWS)

Low-latency players ask for the playlist with `_HLS_msn` and `_HLS_part` in the address and wait for the next part.
The current cache policy for `/stream/*.m3u8` keeps no query string in the cache key (HLS_CDN_PLAN.md: "no cookies,
headers or query strings in the cache key"), so every player would get the same cached playlist whatever it asked
for, and low latency would quietly not happen, or stall. The playlist behaviour needs a cache policy that keys on
those two query strings, with a short TTL. The pieces and parts keep their 60 s policy.

Written out as console steps for the owner before step 4; nothing is run by the developer (house rule: AWS changes
are the owner's).

**Gate:** through CloudFront, two requests with different `_HLS_msn` values get different answers.

### Step 4. Production trial (owner restarts MediaMTX; no event that day)

1. Book a practice webinar with no other stream live, and nothing scheduled in the 30 minutes around it.
2. Owner: on the box, `hlsVariant: lowLatency` in `mediamtx.yml`, then restart the MediaMTX container
   (`deploy.sh` does not restart it). Live streams drop on a restart, which is why nothing else may be live.
3. Measure as in step 1. Test on an iPhone, an Android phone on 4G, Chrome and Safari on a laptop. Watch the box's
   CPU and CloudFront's request count.
4. **Rollback:** `hlsVariant: mpegts` and the same restart. No app code or database change is involved, so nothing
   else needs undoing.

**Gate:** our part is under 6 seconds on every device, buffering is no worse than Nov 25 (about 3 seconds per viewer
per hour), no 404s.

### Step 5. Keep it, or choose per webinar

If step 4 holds, decide (§6, decision 2) between:

- **Low latency for every webinar.** Simplest. Every webinar gets the shorter delay and the smaller safety margin.
- **A per-webinar setting** (LIVE_STREAMING.md §14.6): MediaMTX stays on low latency, and a webinar marked
  "Standard" plays with the normal buffer. This needs player code (hls.js for everyone on such a webinar, because the
  built-in players choose low latency on their own), so it is only worth building if some webinars are large enough
  that stability matters more than seconds.

Then update `mediamtx.yml` in the repo (the comment on `hlsVariant` and the 404 note), LIVE_STREAMING.md §6 and §14,
the player's `BEHIND_LIVE_THRESHOLD_S` / `LIVE_EDGE_OFFSET_S` (they assume 4 s pieces), and
`docs/WEBINAR_TROUBLESHOOTING.html` (what attendees see when they are behind).

## 5. Cost and risk

- **Money:** bandwidth is unchanged (the same video). CloudFront requests rise to several a second per viewer; at
  200 viewers for an hour that is roughly a million requests, a few dollars at CloudFront's per-request price
  (check AWS's current price before step 4).
- **More buffering on weak connections:** a smaller buffer leaves a phone on 4G less margin. Our audiences are
  mostly mobile (43 of 63 on Nov 25). Step 4 measures it; it is the main reason to keep a way back.
- **One setting for the whole server:** while it is on, every stream is low latency, including a partner's.
- **A restart drops live streams:** every switch, either way, is done with nothing live.

## 6. Decisions for the owner

1. **Go ahead with step 1** (measure only) on the next rehearsal? It costs nothing and decides whether the rest is
   worth doing.
2. After step 4: **every webinar, or a per-webinar setting** (§4, step 5).
3. **What buffering is acceptable** in exchange for the shorter delay (the step 4 gate uses Nov 25's figure).

## 7. If it is mostly Zoom's delay

Then no server change helps, and the honest answer for organisers is:

- Q&A typed on our page reaches the moderator in real time; only the video is behind. Moderators can say so when
  they open questions ("we will take questions in a minute, the stream runs a little behind").
- For a webinar where real time matters (a live debate, an interactive workshop), use the **Zoom embed** viewing
  mode: real time, at the cost of a Zoom webinar seat per viewer.

## Sources

- [Apple: Enabling Low-Latency HLS](https://developer.apple.com/documentation/http-live-streaming/enabling-low-latency-http-live-streaming-hls.md)
- [Apple WWDC20: What's new in low-latency HLS](https://developer.apple.com/wwdc20/10228)
- [MediaMTX LL-HLS defaults, third-party test](https://computingforgeeks.com/?p=180693)
- [Recall.ai: Zoom RTMP latency](https://www.recall.ai/blog/zoom-rtmp-live-streaming-integration-pros-and-cons)
- [Airmeet: Zoom into Airmeet via RTMP](https://help.airmeet.com/support/solutions/articles/82000443205-how-to-stream-zoom-meeting-into-airmeet-session-via-rtmp)
- [Amazon IVS features](https://aws.amazon.com/ivs/features/) and [pricing](https://aws.amazon.com/ivs/pricing/)
- [hls.js API (liveSyncDurationCount)](https://github.com/vitalibozhko/hls.js/blob/master/docs/API.md)
- [Mux: Reduce live stream latency](https://www.mux.com/docs/guides/reduce-live-stream-latency)
