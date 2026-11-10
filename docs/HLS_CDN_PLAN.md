# CloudFront in front of the live stream: plan

Status: ON IN PRODUCTION since Nov 9, 2026 (distribution `E4S57RCP6XUPP`, `d3vq9gpx1lng4k.cloudfront.net`, `HLS_CDN_BASE` set on the box and confirmed in `ea-sys-blue`). First real webinar through it on Nov 10, 2026 (§10). Step 0 has a first estimate from that webinar, about 0.7 to 1 Mbps, still to be measured directly. Planned Nov 6, 2026. Supersedes the AWS half of
[LIVE_STREAMING.md §13](LIVE_STREAMING.md), which this plan corrects in three places (§4).
Backlog entry: [ROADMAP](ROADMAP.md), "Webinar streaming: what the Nov 5 security review left
for later", item 4.

## 1. The problem

Every viewer of a custom-stream webinar pulls the HLS stream straight from the box:
the browser to nginx `/stream/`, then to MediaMTX on `127.0.0.1:8888`. Each viewer costs the box
the full stream bitrate. A t3.large has a **baseline of about 0.51 Gbps** (the "up to 5 Gbps"
figure is a burst that runs out), so:

| Stream bitrate | Viewers at baseline |
|---|---|
| 1.5 Mbps | about 340 |
| 2.5 Mbps | about 200 |

Above that, the box runs on burst credits and then drops packets for everyone, the dashboard and
registration included, because they share the same network card. The real bitrate Zoom sends is
not measured yet (step 0).

## 2. Decision: CloudFront, not Cloudflare

| | Cloudflare free | CloudFront |
|---|---|---|
| Video allowed | **No.** Cloudflare's CDN terms restrict video hosted outside Cloudflare; it is allowed only through their paid Stream, Images or R2 | Yes |
| DNS | The whole `meetingmindsgroup.com` zone moves to Cloudflare, including the SES DKIM and DMARC records | Nothing changes: the default `*.cloudfront.net` name needs no DNS and no certificate |
| Cost | Free, until they throttle it mid-webinar | Free up to 1 TB a month, then about $0.11/GB (§3) |
| Fits what exists | New vendor, new account | Same AWS account, same IAM, same billing, CloudWatch |

Cloudflare Stream (their paid video product) would replace MediaMTX, not sit in front of it, and
bills per minute watched (500 viewers for an hour is 30,000 minutes). Not worth it.

## 3. Cost, re-verified Nov 6, 2026

Prices to check against the
[CloudFront pricing page](https://aws.amazon.com/cloudfront/pricing/) before switching on; most
of the figures below were confirmed only by third-party pricing guides.

- **Always-free tier (pay as you go):** 1 TB of data out, 10 million requests and 2 million
  CloudFront Function calls every month, with no end date.
- **After the free TB:** about $0.109/GB for viewers in India and about $0.11/GB for the Middle
  East (first 10 TB band).
- **Box to CloudFront:** AWS does not charge for data sent from EC2 to CloudFront.
- **Today, without CloudFront:** the box pays EC2 internet egress, about $0.11/GB from ap-south-1
  after AWS's 100 GB a month free. **So viewers already cost about this much per GB;** CloudFront
  mostly replaces that bill rather than adding one, and its free allowance is ten times larger.
- **Flat-rate Pro plan:** $15 a month with no overage charges, listed as 50 TB and 10 million
  requests. Not the starting choice: it costs $15 in months with no webinar, and it is not yet
  clear whether it accepts an EC2 origin for video or what happens past the allowance (decision D2).

**What one viewer costs.** One viewer for one hour is 0.68 GB at 1.5 Mbps and 1.13 GB at
2.5 Mbps. Requests are about 1,800 per viewer-hour (a playlist and a 4 s segment every 4 s),
so 10 million requests is about 5,500 viewer-hours: data, not requests, runs out first.

| One webinar | Data | CloudFront bill (first of the month) | Box egress today |
|---|---|---|---|
| 300 viewers, 1 h | 200 to 340 GB | $0 | $11 to $26 |
| 500 viewers, 1 h | 340 to 560 GB | $0 | $26 to $51 |
| 1,000 viewers, 1.5 h | 1.0 to 1.7 TB | $0 to $75 | the box cannot serve it |
| 2,000 viewers, 2 h | 2.7 to 4.5 TB | $185 to $385 | the box cannot serve it |

The free TB is shared across the month, so a second large webinar in the same month pays from its
first GB.

## 4. What §13 of LIVE_STREAMING.md gets wrong

1. **As written, nothing would be cached.** nginx adds `Cache-Control: no-cache` to everything
   under `/stream/`, and with a minimum TTL of 0 CloudFront honours it: every viewer request would
   go through to the box, so the CDN would carry the bill and remove none of the load. The fix is
   two cache behaviours with a **minimum TTL above 0**, which CloudFront applies even when the
   origin says `no-cache` (§5 step 2). No nginx change is needed.
2. **The DR origin group is dropped from v1.** Zoom pushes RTMP to one address, so the Singapore
   box would have no stream to serve. Failover to it is a separate project (dual ingest).
3. **No custom domain in v1.** The `*.cloudfront.net` name needs no certificate and no DNS change.
   A custom domain is needed later only for signed cookies (§7).

## 5. Steps

AWS steps are run by the owner (house rule: instruct, never execute). Steps 1 to 3 are one
script, `ALERT_EMAIL=... bash infra/cloudfront/setup.sh`, with the configuration versioned beside it
in [infra/cloudfront/](../infra/cloudfront/).

**Step 0. Measure the bitrate.** On the next practice custom stream, read the segment sizes in the
browser's network panel (segment bytes x 8 / 4 s). This sets the real viewer limit for the box
and the real cost per viewer-hour. Ten minutes.

**Step 1. Create the distribution** (owner, console or CLI):
- Origin: `events.meetingmindsgroup.com`, HTTPS only, empty origin path. CloudFront sends the
  origin's own name as Host, which matches the nginx `server_name`.
- Compression off (video is already compressed), HTTP/2 and HTTP/3 on, price class "All" (the
  audience is the Gulf and India; the cheaper classes skip the Middle East edges).
- Standard logging off at first (it costs S3 storage); CloudWatch's free default metrics show
  requests, bytes and the cache hit rate.

**Step 2. Cache behaviours** (the fix in §4.1):

| Path pattern | Min TTL | Default | Max | Why |
|---|---|---|---|---|
| `/stream/*.m3u8` | 1 s | 1 s | 2 s | The playlist changes every 4 s; one origin fetch per edge per second |
| `/stream/*` | 60 s | 60 s | 300 s | A segment never changes once written |
| Default (`*`) | n/a | n/a | n/a | A CloudFront Function answers 404, so the distribution is never a mirror of the whole site |

All three: GET and HEAD only; no cookies, headers or query strings in the cache key.
`Access-Control-Allow-Origin: *` comes from nginx and passes through, so no response headers
policy is needed.
Custom error response: **404 cached for 1 s** (the default is 10 s, which would hide a stream that
has just started for up to 10 s).

CloudFront also merges simultaneous requests for the same object at an edge into one origin
fetch, so a 2,000-viewer surge becomes a few requests a second at the box.

**Step 3. A spending alarm** (owner): an AWS Budget on CloudFront at $50 a month, emailing the
owner. CloudFront has no spending cap, and the viewer URL can be shared (§7), so a leaked link
watched by thousands would bill without one.

**Step 4. Test with a throwaway stream before any real webinar:**
- Publish an H.264 test stream with ffmpeg to a test key (as on Nov 5).
- `curl -sI https://<id>.cloudfront.net/stream/live/<key>/index.m3u8` twice: the second shows
  `x-cache: Hit from cloudfront`.
- Play it through the `.cloudfront.net` URL in Chrome and iPhone Safari.
- On the box, the nginx access log shows a few `/stream/` requests a second from CloudFront
  addresses, however many players are open.
- Stop the stream: within a few seconds the playlist 404s through CloudFront and the page goes to
  "ended" (stream-status probes MediaMTX directly, never through CloudFront, so nothing changes).

**Step 5. Switch it on.** Add `HLS_CDN_BASE=https://<id>.cloudfront.net` to the box's `.env`, then
`bash scripts/deploy.sh`. zoom-join, stream-status and the console preview already read it; the
player falls back to the box once if CloudFront fails. Unset it to switch back.

**Step 6. Docs.** LIVE_STREAMING.md §13 rewritten to match, WEBINAR_STREAMING.html's scale
section, ROADMAP item 4 closed, CHANGELOG.

No code changes are expected. If step 4 turns anything up, it gets fixed and tested before step 5.

## 6. What it leaves alone

- **Publishing** (RTMP from Zoom to the box on 1935) and its HMAC check are untouched.
- **The Zoom embed mode** never touches the stream.
- **nginx `limit_conn ea_conn 100`** applies per address to `/stream/` too, but CloudFront opens
  only a few connections per edge, and `/stream/` has no request limit, so fail2ban (which bans
  on request-limit hits) cannot ban an edge.
- **The origin stays public.** The player's fallback needs it, and the URL is already public
  while a stream is live. Locking the origin to CloudFront only (the `com.amazonaws.global.cloudfront.origin-facing`
  prefix list on port 443) would lock the whole site, since the app shares the port, and would
  break the fallback. Not worth it.

## 7. Later, not in this plan

- **Signed cookies (review W-04).** CloudFront signed cookies replace the nginx `secure_link` idea
  in ROADMAP item 3. The cookie has to be set on a domain the app shares, so this needs a custom
  name such as `stream.events.meetingmindsgroup.com` (an ACM certificate in us-east-1 plus one DNS
  record) and a CloudFront key pair whose private key the app holds. Worth it once a webinar's
  content is restricted (e.g. HCP-only).
- **DR failover** (needs Zoom to push to both boxes).
- **Per-tenant egress** (ROADMAP item 5): CloudFront logs carry the stream key in the path, which
  maps to an organisation.

## 8. Decisions for the owner

- **D1. When to do it.** Recommended: steps 0 to 4 now (an hour of console work, $0 while idle),
  step 5 before the first custom-stream webinar expected to pass about 200 live viewers. Leaving
  it set all the time is also fine: it is free under 1 TB a month.
- **D2. Pay as you go or flat-rate Pro.** Recommended: pay as you go. Revisit Pro ($15 a month)
  if two monthly bills in a row pass about $15, after confirming Pro allows an EC2 video origin.
- **D3. The budget alarm amount.** $50 a month suggested.

## 9. Test results, Nov 9, 2026

Test stream: ffmpeg, 720p H.264 at 2.5 Mbps, pushed to the `prod-test` draft's key (not a webinar,
so no room, watchdog or email could react). Publish key printed on the box:
`docker exec ea-sys-worker node -e '<HMAC of "stream-publish:"+key, first 40 hex>' <key>`.

- **Not the site:** `/`, `/login`, `/api/health` through CloudFront answer 404 from the function.
- **Edge:** served from Dubai (`x-amz-cf-pop: DXB53`).
- **Playlist:** `main_stream.m3u8` went Miss, Hit, then Miss again once its 1 s ran out. The
  multivariant `index.m3u8` caches the same way.
- **Segments:** Miss, then Hit (`age: 1`). Chrome's native player (the iPhone path) played the
  stream at 1280x720 with every request to CloudFront and no errors; its 206 range requests are
  served from cache.
- **Stream end:** the playlist went 404 through CloudFront within about 1 s and stayed there.
- **Restart:** segment names changed prefix (`c5a624a1c25b_main_seg*` to `f3f18ae0dca9_main_seg*`),
  so a restarted stream can never be handed an old cached segment.
- **Headers:** MediaMTX sends its own `Cache-Control` (`max-age=30` on the multivariant playlist,
  `max-age=3600` on segments, `no-cache` on the media playlist) beside nginx's `no-cache`; the
  cache policies override both, as intended. MediaMTX answers HEAD with 404, so checks use GET.
- **Player fallback** (read in `live-player.tsx`): both the native and hls.js paths fall back to
  the box once on a fatal error. Not covered: a CloudFront edge that stalls without erroring; the
  stall watchdog then reconnects to CloudFront again. Rare; unsetting `HLS_CDN_BASE` is the fix.

## 10. First webinar through CloudFront, Nov 10, 2026

"Test Webinar" (`cmw91pdnr0001qs01htw8ih3v`), Zoom pushing a custom live stream. The room was open
from 11:30 to 11:35 Dubai (audit: `ROOM_OPENED` 07:30:01Z, `STREAM_LIVE` 07:30:30Z, `ROOM_CLOSED`
07:35:18Z). The owner reported it worked; prod data and CloudFront agree.

- **Through CloudFront, no server errors.** 1,029 requests and 161 MB in the window, 5xx rate 0,
  4xx rate 2.5% (the playlist 404s before the stream starts and after it ends, as designed).
  Per minute while live: about 200 requests and 30 to 36 MB.
- **People.** 12 registrations (all confirmed, complimentary), 5 joined the room, 7 questions,
  2 live polls. Every scheduled email sent with no failures: 15 minute and 1 hour reminders,
  live now, thank-you to all 12.
- **Bitrate, step 0, first estimate.** 30 to 36 MB a minute is 4.0 to 4.8 Mbps for all viewers.
  At two requests per viewer per 4 s segment, 200 requests a minute is 6 to 7 players, which
  matches 5 attendees plus staff previewing. So the stream ran at **about 0.7 to 1 Mbps**, below
  the 1.5 Mbps this plan assumed: the box alone would hold more than §1 says, and one viewer-hour
  is about 0.3 to 0.45 GB, so the §3 costs are on the high side. Still an estimate (player count
  inferred, slides with little motion); measure segment sizes directly at a longer stream before
  relying on it.
- **Not measured.** The cache hit rate needs CloudFront's additional metrics, which are off
  (they cost). The box's nginx access log for `/stream/` would show origin load; not read.
- **Seen, not caused by the CDN.** The first Start stream press, 15 minutes before, was refused
  with `STREAM_NOT_CONFIGURED`; the next press a minute later worked. `ZoomMeeting.streamStatus`
  still reads `ACTIVE` after the stream ended, because it flips to `ENDED` only when someone polls
  stream-status. The recording was not switched on, so the thank-you email carried no replay.

