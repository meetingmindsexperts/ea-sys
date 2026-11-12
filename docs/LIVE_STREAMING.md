# Live Streaming (MediaMTX)

> Self-hosted RTMP → HLS live streaming for EA-SYS event sessions.
> This documents **what MediaMTX is, why it's in the stack, and how the
> end-to-end flow works.** For the Zoom SDK embed (the *other* live-video
> path) see [`ZOOM_INTEGRATION.html`](ZOOM_INTEGRATION.html) and
> [`WEBINAR_EVENTS.md`](WEBINAR_EVENTS.md).

---

## 1. TL;DR

EA-SYS has **two independent ways to put live video on a public session page**:

| Path | Mechanism | Best for |
|------|-----------|----------|
| **ZoomWebEmbed** (Zoom SDK Component View) | Attendee joins the actual Zoom meeting in-page | Interactive sessions — Q&A, panels, breakouts |
| **MediaMTX / HLS** (this doc) | Host pushes one RTMP feed; attendees watch a one-way HLS stream | Broadcast to a large, watch-only audience |

MediaMTX is the second path. It exists so a session can be streamed to an
**unlimited** watch-only audience **without** making every viewer a Zoom
participant.

---

## 2. Why MediaMTX exists (the rationale)

The Zoom embed path is great for interactivity, but it has a structural cost:
**every attendee who opens the embed is a Zoom meeting/webinar participant.**
That means:

- Each viewer counts against the organization's Zoom plan capacity
  (meeting = up to ~1,000, webinar = up to ~10,000 — and the higher tiers
  cost real money per seat).
- The client is heavy: the Zoom SDK pulls ~3 MB of JS plus ~50 MB of
  WASM/AV assets and negotiates a full bidirectional media session.
- It's overkill for someone who only wants to *watch* a keynote.

For a **broadcast-only** scenario — one presenter, a large passive audience —
the right tool is a one-way stream:

- The host publishes a **single** RTMP feed.
- A media server fans it out as HLS (plain HTTP segments any browser can play).
- **Viewer count is unlimited** and the marginal cost per viewer is ~0
  (it's just static segment files served over HTTP/CDN-friendly).
- No Zoom seat is consumed per viewer.

MediaMTX is that media server. It's self-hosted on the same EC2 box as the
app, so video ingest/remux stays in-region and off Zoom's infrastructure.

> ⚠️ **Doc contradiction to be aware of:** `ZOOM_INTEGRATION.html` states
> *"streaming runs entirely on Zoom's infrastructure."* That is true **only**
> for the ZoomWebEmbed path. When live streaming is enabled, ingest + remux
> happen on **our** EC2 box via MediaMTX. Treat that sentence as scoped to
> the embed path only.

---

## 3. What MediaMTX is

[MediaMTX](https://github.com/bluenviron/mediamtx) (`bluenviron/mediamtx`) is
an open-source, single-binary, zero-dependency media server. It speaks RTMP,
HLS, WebRTC, RTSP, SRT and can ingest in one protocol and republish in others.

In EA-SYS it runs as a Docker container named **`ea-sys-mediamtx`**, defined in
[`docker-compose.yml`](../docker-compose.yml) (dev) and
[`docker-compose.prod.yml`](../docker-compose.prod.yml) (prod), using the
config at [`mediamtx.yml`](../mediamtx.yml).

We use exactly two of its protocols today: **RTMP in → HLS out.** WebRTC is
wired in the port map but unused (reserved for a future low-latency path).

---

## 4. End-to-end flow

```
┌──────────────┐   RTMP    ┌─────────────────┐   HLS    ┌───────────┐   HTTPS   ┌──────────────┐
│  Host / Zoom │──────────▶│   MediaMTX      │─────────▶│   nginx   │──────────▶│  LivePlayer  │
│  / OBS       │  :1935    │ (ea-sys-mediamtx)│  :8888  │  /stream/ │           │  (browser)   │
└──────────────┘           └─────────────────┘          └───────────┘           └──────────────┘
   pushes one                 ingests + remuxes              proxies                 plays HLS,
   stream key                 mpegts HLS segments            to :8888                polls status
```

1. **Enable streaming on a session.** The session's `ZoomMeeting` row has
   `liveStreamEnabled = true` and a `streamKey`. Admin toggles this on the
   session's Zoom form (`src/components/zoom/zoom-meeting-form.tsx`).

2. **Host publishes RTMP.** The host streams to:
   ```
   rtmp://{host}:1935/live/        (stream key supplied separately)
   ```
   Sources:
   - **Zoom** — *Meeting → ⋯ → Live on Custom Live Streaming Service*, paste
     the RTMP URL + stream key. Zoom auto-streams when the host starts the
     meeting.
   - **OBS / vMix / any RTMP encoder** — same RTMP URL + key.

3. **MediaMTX ingests + remuxes.** It accepts the publisher on `:1935` and
   exposes an HLS playlist on `:8888` at `/live/{streamKey}/index.m3u8`.
   Config (mpegts variant, 7 × 4s segments; 2s until Nov 5, 2026, see mediamtx.yml) lives in
   [`mediamtx.yml`](../mediamtx.yml).

4. **nginx proxies playback.** Public clients never hit `:8888` directly —
   nginx proxies `/stream/` → `http://ea-sys-mediamtx:8888`, so attendees
   fetch:
   ```
   {appUrl}/stream/live/{streamKey}/index.m3u8
   ```

5. **LivePlayer plays it.** The public session page
   ([`src/app/e/[slug]/session/[sessionId]/page.tsx`](../src/app/e/%5Bslug%5D/session/%5BsessionId%5D/page.tsx))
   dynamic-imports [`LivePlayer`](../src/components/zoom/live-player.tsx),
   which uses `hls.js` to play the HLS URL and polls stream status.

6. **Status tracking.** The public
   [`stream-status` route](../src/app/api/public/events/%5Bslug%5D/sessions/%5BsessionId%5D/stream-status/route.ts)
   probes the MediaMTX HLS endpoint to determine if the stream is actually
   live, and flips `ZoomMeeting.streamStatus` (`IDLE → ACTIVE → ENDED`).

---

## 5. Ports

| Port | Protocol | Direction | Notes |
|------|----------|-----------|-------|
| `1935` | RTMP | **ingest** | Host / Zoom / OBS pushes here |
| `8888` | HLS | **output** | nginx proxies `/stream/` here; bound to `127.0.0.1` on the box |
| `8889` | WebRTC | — | **Off** (`webrtc: no`) and not published, since Nov 5, 2026 |

`1935` must be reachable by whatever pushes the stream (Zoom's servers, or the
host's encoder). Since the Nov 5, 2026 security review RTSP, WebRTC and SRT are
switched off in `mediamtx.yml` (each also accepts publishes) and `8888` is
published on localhost only, pinned by `__tests__/lib/mediamtx-security-config.test.ts`.
Turning WebRTC back on for low latency means turning publish auth's question
on for it too: re-read §11a first.

---

## 6. Configuration (`mediamtx.yml`)

```yaml
rtmp: yes
rtmpAddress: :1935
hls: yes
hlsAddress: :8888
rtsp: no
webrtc: no
srt: no

authMethod: http   # publish authorisation, §11a

# HLS settings — mpegts variant (fmp4 has known 404 issues)
hlsVariant: mpegts
hlsSegmentCount: 7
hlsSegmentDuration: 4s
hlsSegmentMaxSize: 50M
hlsAlwaysRemux: true

paths:
  all:
    source: publisher
```

Notes:
- **`hlsVariant: mpegts`** — the fmp4 variant had known 404 issues serving
  init segments through the proxy; mpegts is the stable choice.
- **`hlsSegmentCount: 7` × `hlsSegmentDuration: 4s`** ≈ a 28s sliding window. 4s, not 2s: pieces are cut at keyframes, Zoom sends one about every 3s, and a piece length that changes mid-stream freezes iOS players (Nov 5, 2026).
  Trades latency for resilience to brief network hiccups.
- **`hlsAlwaysRemux: true`** — keep producing HLS segments even with no active
  reader, so the first viewer doesn't wait for a cold start.
- **`paths.all.source: publisher`** — any path accepts a publisher. The
  effective namespace is `/live/{streamKey}` because that's the path the host
  publishes to and the player reads from. **There is no per-stream auth at the
  MediaMTX layer** — the `streamKey` (a server-generated value on the
  `ZoomMeeting` row) is the only thing gating playback, and it's effectively a
  bearer secret. Treat stream keys as secrets. (Publishing is no longer gated
  by the key alone: see §11a, publish authorisation.)
- Low latency: see §14 before changing `hlsVariant` or the segment settings.

---

## 7. Environment variables

| Var | Where | Purpose | Default |
|-----|-------|---------|---------|
| `MEDIAMTX_HLS_URL` | app container | Internal URL the `stream-status` route probes to check if a stream is live | `http://localhost:8888` (prod: `http://ea-sys-mediamtx:8888`, set in `docker-compose.prod.yml`) |
| `NEXT_PUBLIC_APP_URL` | app | Base for the public HLS playback URL (`{appUrl}/stream/...`) | `http://localhost:3000` |

---

## 8. nginx proxy — required, but not in the committed config

The playback URL is `{appUrl}/stream/live/{streamKey}/index.m3u8`, which means
nginx must proxy `/stream/` to the MediaMTX container's `:8888`. The live block
is in [`deploy/nginx.conf`](../deploy/nginx.conf), which since Sep 24, 2026 is an
exact copy of the box file (see [`deploy/NGINX.md`](../deploy/NGINX.md)). A
reference version with the reasoning:

```nginx
# Proxy HLS playback to the MediaMTX container.
location /stream/ {
    proxy_pass         http://127.0.0.1:8888/;   # or the container name on the shared docker network
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_buffering    off;                       # don't buffer live segments
    add_header         Cache-Control no-cache;    # playlists must not be cached
}
```

> **Done Sep 24, 2026:** the block is in `deploy/nginx.conf`, so a rebuilt or
> DR server gets it from `deploy/setup.sh` / `infra/dr/user-data.sh`.

---

## 9. Schema touchpoints

On the `ZoomMeeting` model (1:1 with `EventSession`):

| Field | Type | Meaning |
|-------|------|---------|
| `liveStreamEnabled` | `Boolean` | Whether this session uses the MediaMTX HLS path |
| `streamKey` | `String?` | The RTMP/HLS path segment + de-facto playback secret |
| `streamStatus` | `String?` | `IDLE` / `ACTIVE` / `ENDED`, maintained by the stream-status route |

---

## 10. Key files

| File | Role |
|------|------|
| [`mediamtx.yml`](../mediamtx.yml) | MediaMTX server config (RTMP/HLS ports + HLS tuning) |
| [`docker-compose.yml`](../docker-compose.yml) / [`docker-compose.prod.yml`](../docker-compose.prod.yml) | `ea-sys-mediamtx` service definition + `MEDIAMTX_HLS_URL` wiring |
| [`src/components/zoom/live-player.tsx`](../src/components/zoom/live-player.tsx) | Public HLS player (`hls.js`), polls stream status, fullscreen/mute controls |
| [`src/app/api/public/events/[slug]/sessions/[sessionId]/stream-status/route.ts`](../src/app/api/public/events/%5Bslug%5D/sessions/%5BsessionId%5D/stream-status/route.ts) | Probes MediaMTX, flips `streamStatus`, returns playback URL (360/hr per IP) only to staff, or to a registration that may watch while the room is open (`viewer-entitlement.ts`, Nov 5, 2026) |
| [`src/components/zoom/zoom-meeting-form.tsx`](../src/components/zoom/zoom-meeting-form.tsx) | Admin toggle + `StreamingInfoCard` (RTMP URL / stream key / HLS URL / attendee page) |
| [`src/app/e/[slug]/session/[sessionId]/page.tsx`](../src/app/e/%5Bslug%5D/session/%5BsessionId%5D/page.tsx) | Public session page; dynamic-imports `LivePlayer` (Live Video tab) |

---

## 11. Operational notes

- **It runs on the EC2 box, not Zoom.** Ingest, remux, and HLS serving consume
  CPU/bandwidth on the app server. A large broadcast is cheap per viewer but
  not free for the host box — watch CPU during big events.
- **Latency is ~10–20s** (typical HLS sliding-window latency). This is a
  broadcast tool, not a low-latency conferencing tool. If you need
  near-realtime, that's what the unused WebRTC port (`:8889`) would be for —
  not yet implemented.
- **Stream keys are secrets.** There's no MediaMTX-layer auth; anyone with the
  key can publish to or play the path. Don't expose keys publicly; they're
  surfaced only in the admin `StreamingInfoCard`.
- **`restart: unless-stopped`** keeps the container alive across reboots; a
  blue-green app deploy does not restart MediaMTX (it's a separate service).

---

## 11a. Producer controls and publish authorisation (Oct 1, 2026)

**Starting the stream.** Zoom never starts a custom live stream by itself,
and until Oct 1 nothing in the app asked it to. The Webinar Console now has a
**Custom stream** block (shown when the saved viewing mode is Custom stream)
with three buttons, all going through `controlWebinarLiveStream` in
[src/lib/webinar/livestream.ts](../src/lib/webinar/livestream.ts) via
`POST /api/events/[eventId]/webinar/livestream`:

- **Start stream** calls Zoom's `PATCH /webinars/{id}/livestream/status`
  with `action: start`. Zoom refuses until the host has started the webinar,
  and the console says so in plain words.
- **Stop stream** sends `action: stop`.
- **Re-send stream settings to Zoom** sends the RTMP address and key again
  (`PATCH /webinars/{id}/livestream`) and switches streaming on for a session
  created without it, so a session no longer has to be deleted and recreated.
  An existing key is kept, so a running push is never broken.

Opening the room in Custom stream mode also tries Start, and closing it tries
Stop; a failure there never blocks the room (the toast says what happened).
The session card shows the RTMP address from the server (`rtmpIngestUrl()`,
the same value sent to Zoom), no longer one built from the browser.

**Publish authorisation (switched on in `mediamtx.yml` Nov 5, 2026; takes effect at the next MediaMTX recreate).** MediaMTX
accepted a publish on any path from anyone who could reach port 1935.
`POST /api/webhooks/mediamtx-auth` now answers MediaMTX's HTTP auth: a
publish is allowed only on `live/<key>` for a Zoom meeting with streaming on,
or (since Nov 12, 2026) for a partner's key that is switched on, inside its
period and presented with its current password (§11b); anything else is
refused; a lookup error refuses. It lives under
`/api/webhooks/` because MediaMTX sends no Origin header, which the
middleware's CSRF check refuses elsewhere. It does nothing until MediaMTX is
configured to call it. The deploy script never restarts MediaMTX (it only
starts it when absent), so this is an owner step:

1. Check the running version (auth over HTTP needs v1.8 or later):

   ```
   docker exec ea-sys-mediamtx /mediamtx --version
   ```

2. Pin that version (or a tested newer one) in `docker-compose.prod.yml`.
   **Done Nov 5, 2026:** pinned to `bluenviron/mediamtx:1.17.1`, the version the
   box was running (v1.17.1 supports auth over HTTP).
3. Add to `mediamtx.yml` (**done Nov 5, 2026**, after the security review
   found any registered viewer could push over a live webinar: the HLS URL
   they receive contains the key). Reads are excluded so 5,000 viewers never
   reach the app; only publishes are checked:

   ```yaml
   authMethod: http
   authHTTPAddress: https://events.meetingmindsgroup.com/api/webhooks/mediamtx-auth
   authHTTPExclude:
     - action: read
     - action: playback
   ```

4. Restart MediaMTX and push a test stream with a wrong key (must be refused)
   and the session's real key (must play):

   ```
   docker compose -f docker-compose.prod.yml up -d --force-recreate mediamtx
   docker logs --tail 50 ea-sys-mediamtx
   ```

   Test with H.264, the codec Zoom sends (ffmpeg's default FLV codec is refused
   for the codec, which proves nothing about auth):

   ```
   ffmpeg -re -f lavfi -i testsrc=size=640x360:rate=25 -t 10 -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -f flv rtmp://<host>:1935/live/0000000000000000000000000000dead
   ```

   The MediaMTX log must say `authentication failed` and the app log
   `mediamtx-auth:publish-unknown-key`. **Read the reason, not just the
   refusal:** on Nov 5, 2026 the first test was refused with
   `x509: certificate signed by unknown authority`, because the image carries no
   certificate authorities, so the check never reached the app and Zoom's real
   publish would have been refused too. `docker-compose.prod.yml` now mounts the
   box's `/etc/ssl/certs/ca-certificates.crt` read-only.

**Every new publish now needs the app (review, Nov 5, 2026).** MediaMTX asks
the app before each publish and refuses when it gets no yes, so while the app
or the database is down (a failed deploy, the maintenance page) a publish is
refused. A stream already running is not affected (the check runs only when a
publish starts), but Zoom reconnecting after a network blip IS a new publish.
So **do not deploy, restart the app or touch the database while a
custom-stream webinar is live**; if the stream drops during an outage, press
Start stream again once the app is back (the stream watchdog also retries).

**Publish credentials (Oct 2, 2026).** The bare stream key is also the HLS
read path that every registered viewer receives, so the webhook does not
trust it alone. Zoom is sent `key?user=publisher&pass=<password>`, where the
password is an HMAC of the key (`streamPublishPassword` in
`src/lib/webinar/livestream.ts`, signed with `STREAM_PUBLISH_SECRET`, or
`NEXTAUTH_SECRET` when that is unset). Viewers never see it; the webhook
refuses a publish without it. Before auth is switched on, MediaMTX ignores the
query and the path is unchanged, so streams work as before.

5. **After switching auth on, press "Re-send stream settings to Zoom" once on
   every custom-stream webinar** set up before Oct 2, 2026. Those were given
   the bare key and would be refused. Re-send keeps the key and adds the
   credentials.

On the platform instance the tenant-less key lookup is hidden by RLS, so a
publish there is refused until the lookup moves to the operator lane.

## 11b. A partner's stream, and cutting the feed (Nov 12, 2026)

Plan and status: [EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md](EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md).
Nothing here is in the console yet.

**A partner's key.** A webinar produced on a partner's own platform has no Zoom
webinar of ours, so its key lives in the `ExternalStream` table and
`src/lib/webinar/session-stream.ts` tells every reader which stream a session
has. The partner is handed the same two values Zoom's "custom live streaming"
takes: the server address and `key?user=publisher&pass=<password>`. A publish
on it is accepted only with the password of the key's current version, with the
key switched on, and inside its period (from issue until 24 hours after the
session's scheduled end, or the key's own end date). Each refusal is logged as
`mediamtx-auth:publish-external-refused` with its reason: `BAD_PASSWORD`,
`SWITCHED_OFF`, `NOT_YET_VALID` or `EXPIRED`.

**Why a control API.** MediaMTX asks the publish check only when a stream
starts. An encoder already connected keeps its connection when its key is
replaced, switched off or expires. With our own Zoom we tell Zoom to stop; a
partner's platform is not ours to tell. So `mediamtx.yml` now switches on
MediaMTX's control API, and the app uses it for two things only: listing who is
publishing, and disconnecting a publisher (`src/lib/webinar/mediamtx-control.ts`).

- Replacing a key, switching it off and "cut the feed" save the change first
  and then disconnect whoever is publishing on the key.
- Once a minute the worker's stream watchdog job also disconnects any partner's
  stream still running on a key that is switched off or past its period
  (`external-stream-sweep.ts`). It never touches a stream whose key it cannot
  find, and never our own Zoom's.

**How the API is protected.** Port 9997 is not published on the box
(`docker-compose.prod.yml`); only the app and worker containers reach it, by
name. It has no password of its own: because `api` is not in `authHTTPExclude`,
MediaMTX puts every API call to the same webhook as a publish, and the webhook
allows it only when the call carries `MEDIAMTX_API_SECRET`. **Never add
`action: api` to `authHTTPExclude`**: the API can also rewrite MediaMTX's
configuration, and it would then answer anyone who can reach the port.

**Owner steps, once, with no webinar live.** No partner's key can be issued
until these are done (the app refuses, and says which is missing).

1. Add two long random values to the box's `.env` (each from `openssl rand -hex 32`):

   ```
   STREAM_PUBLISH_SECRET=<64 hex characters>
   MEDIAMTX_API_SECRET=<64 hex characters>
   ```

   `STREAM_PUBLISH_SECRET` signs every publish password. Until now they were
   signed with `NEXTAUTH_SECRET`, so **setting it changes the password of every
   Zoom custom stream**: afterwards press "Re-send stream settings to Zoom" on
   each upcoming custom-stream webinar. A missed one has no video at go-live,
   and the only sign is a `mediamtx-auth:publish-bad-credentials` warning, so
   list them first (read-only, `npm run prod:psql`) and tick each off:

   ```sql
   SELECT e.name, s."startTime"
   FROM "ZoomMeeting" z
   JOIN "EventSession" s ON s.id = z."sessionId"
   JOIN "Event" e ON e.id = z."eventId"
   WHERE z."liveStreamEnabled" AND s."endTime" > now()
   ORDER BY s."startTime";
   ```

   A partner's key is never signed with the sign-in secret, so rotating that
   no longer cancels it.

2. Deploy as usual (`bash scripts/deploy.sh`), so the app and the worker read
   the new values. Until step 3 the worker logs `mediamtx-control:unreachable`
   once a minute, which is expected: the control address is set and MediaMTX
   has not been recreated yet.

3. Recreate MediaMTX so it reads the new `mediamtx.yml` (the deploy never
   restarts it):

   ```
   docker compose -f docker-compose.prod.yml up -d --force-recreate mediamtx
   docker logs --tail 30 ea-sys-mediamtx
   ```

   The log should show the API listener on `:9997`.

4. Check that the API is not reachable from outside. From a laptop, this must
   fail to connect:

   ```
   nc -vz events.meetingmindsgroup.com 9997
   ```

5. Check that a call without the secret is refused. On the box, this must print
   `401`, and the app log must show `mediamtx-auth:api-refused`:

   ```
   docker exec ea-sys-worker node -e "fetch('http://ea-sys-mediamtx:9997/v3/rtmpconns/list').then(r=>console.log(r.status))"
   ```

6. Check that our own call is let in. This must print `200` and a line of JSON
   with `"items"`:

   ```
   docker exec ea-sys-worker node -e "fetch('http://ea-sys-mediamtx:9997/v3/rtmpconns/list',{headers:{Authorization:'Basic '+Buffer.from('ea-sys:'+process.env.MEDIAMTX_API_SECRET).toString('base64')}}).then(async r=>console.log(r.status,await r.text()))"
   ```

**If step 6 prints 401, stop and say so.** The client was written from
MediaMTX 1.17.1's published API description and has not been run against a
server: step 6 is the first real test of the one assumption everything rests
on, that MediaMTX passes the call's Basic credentials to the webhook. Nothing
is broken if it fails (every piece refuses when unsure), but no partner's
stream could be cut, so no key should be issued. Disconnecting itself is
tested at the rehearsal, with a real stream.

## 12. Future work

- ~~Fold the nginx `/stream/` proxy into `deploy/nginx.conf`~~ — **done**
  (committed; see §8). The live box's nginx remains the source of truth.
- Per-stream auth at the MediaMTX layer (publish/read tokens) instead of
  relying on the stream key alone.
- Implement the WebRTC (`:8889`) low-latency path for interactive-ish
  broadcasts. Low-latency HLS is the nearer step: see §14.
- Recording the HLS output to S3 as a fallback when Zoom cloud recording isn't
  used (today recordings come from Zoom — see `WEBINAR_EVENTS.md`).

---

## 13. Viewer capacity: CloudFront in front of the box (ON since Nov 9, 2026)

The box alone holds about 200 to 340 viewers (a t3.large's 0.51 Gbps baseline at 1.5 to 2.5
Mbps). Since Nov 9, 2026 every viewer is served by **CloudFront**: distribution `E4S57RCP6XUPP`,
`https://d3vq9gpx1lng4k.cloudfront.net`, origin `events.meetingmindsgroup.com`. The box serves
about one playlist request per edge per second and each segment once per edge, however many watch.
Plan, costs and the Nov 9 test results: [HLS_CDN_PLAN.md](HLS_CDN_PLAN.md). Configuration and
the setup script: [infra/cloudfront/](../infra/cloudfront/).

- **Switch:** `HLS_CDN_BASE` in the box's `.env` (then `bash scripts/deploy.sh`, never during a
  live stream). Unset, viewers go straight to the box. zoom-join, stream-status and the console
  preview read it.
- **Cache:** `/stream/*.m3u8` 1 s, `/stream/*` 60 s, 404s 1 s. The minimum TTLs are above 0
  because nginx sends `no-cache`, which CloudFront would otherwise honour and cache nothing.
  Everything outside `/stream/` answers 404 (a CloudFront Function), so the distribution never
  mirrors the site.
- **Never on the liveness path:** stream-status and the stream watchdog probe MediaMTX directly
  (`MEDIAMTX_HLS_URL`).
- **Fallback:** the player switches to the box once on a fatal error (native and hls.js paths).
- **Cost:** free up to 1 TB a month, then about $0.11/GB; budget `cloudfront-live-stream`
  ($50 a month) emails the owner.
- **Not done:** a failover origin (the DR box gets no RTMP, since Zoom pushes to one address) and
  signed cookies (ROADMAP, Webinar streaming item 3).
- **First webinar through it (Nov 10, 2026):** 5 attendees, 161 MB over 5 minutes, no 5xx. The
  stream ran at about 0.7 to 1 Mbps, an estimate, below the 1.5 Mbps the capacity figures above
  assume ([HLS_CDN_PLAN.md §10](HLS_CDN_PLAN.md)).

---

## 14. Latency: standard HLS or low-latency HLS (decision record, Oct 2, 2026)

**Status: PROPOSED, NOT APPLIED.** Production runs standard HLS (`hlsVariant:
mpegts`). Nothing below has been changed on the box. This section records the
trade-off and the plan, so the decision is made on measurements rather than
memory.

### 14.1 Why this came up

The first custom-stream test (Vivek, Oct 2, 2026) showed the attendee picture
running about 10 to 20 seconds behind the room. For a broadcast that is
normal; for a webinar with live Q&A it is noticeable, because a speaker
answers a question that viewers hear asked long after they typed it.

### 14.2 Where the delay comes from

Two parts add up, and only the second is ours:

1. **Zoom's own delay** between the room and the RTMP stream it pushes to us.
   No setting on our side changes it. Not measured yet.
2. **Our HLS buffer.** MediaMTX cuts the stream into segments (2 s minimum,
   and a segment can only end on a keyframe, so Zoom's keyframe interval can
   make them longer). The player holds about three segments before it plays.

Low-latency HLS shrinks part 2 only. An honest expectation is a few seconds
saved (for example 15 s down to 6 to 9 s), not "near real time". **Measure
before deciding:** put a clock on screen in the Zoom webinar during a practice
run and compare it with the attendee page.

### 14.3 The options

| | Delay (estimate) | Viewer scale | Notes |
|---|---|---|---|
| **Standard HLS (today)** | 10 to 20 s | Thousands with a CDN | Proven on our setup |
| **Low-latency HLS** | about 3 to 6 s of our own on top of Zoom's | Thousands, but the CDN helps less | One config line + MediaMTX restart; the player needs no code change (hls.js `lowLatencyMode: true` is already set and has no effect on mpegts) |
| **WebRTC** | under 1 s | Low hundreds per box, no CDN | UDP port + TURN relay for office firewalls; MediaMTX supports it (`:8889`, reserved). Not proposed. |
| **Zoom embed** | real time, two-way | the Zoom webinar seat limit | Already built: the other viewing mode |

### 14.4 Repercussions of low-latency HLS

1. **Request volume.** A standard player fetches the playlist about every 2 s.
   A low-latency player fetches several times a second, and each request is
   held open until the next part exists (blocking playlist reload). Several
   times the requests per viewer, all on one t3.large when there is no CDN,
   which can run into the CPU-credit throttle (AWS_OPERATIONS.md).
2. **The CDN caches less.** Low-latency requests carry `_HLS_msn` /
   `_HLS_part` query strings that must be forwarded and keyed in CloudFront,
   which §13's cache policy currently excludes, and very short objects cache
   poorly.
3. **More stalling on weak connections.** A smaller buffer leaves a phone on
   4G or a hotel connection less margin. Our audiences are international and
   often mobile.
4. **The fMP4 warning.** Low-latency HLS requires fMP4 segments. §6 records
   that "the fmp4 variant had known 404 issues serving init segments through
   the proxy". That must be re-tested, not assumed fixed.
5. **The MediaMTX image is pinned** (`bluenviron/mediamtx:1.17.1`, since Nov 5,
   2026; it was `latest`), so a pull cannot change behaviour under us.
6. **One mode for every stream.** `hlsVariant` is a server-wide setting. The
   server cannot serve low latency to one webinar and standard to another.
7. **Switching drops live streams.** Changing the variant needs a MediaMTX
   restart, which `scripts/deploy.sh` does not do; it is run by hand with no
   webinar live.

What is safe: rollback is the same one line and a restart, and no app code or
database change is involved.

### 14.5 Bandwidth decides more than latency does

Every viewer downloads the full video, so the box's outbound bandwidth is a
hard ceiling whichever HLS mode is used. Assuming about 2.5 Mbit/s per viewer
(to be measured on a practice run):

| Viewers | Outbound from the box with no CDN |
|---|---|
| 150 | about 0.4 Gbit/s |
| 1,000 | about 2.5 Gbit/s |

AWS's published baseline for a t3.large is roughly 0.5 Gbit/s (bursting
higher for short periods), and the same box serves the whole app. So **a
1,000-viewer stream needs CloudFront in front (§13), whatever the latency
mode**, and 150 viewers is already near the box's baseline. Each 1,000-viewer
hour is also roughly 1 TB of data transfer, which AWS bills.

### 14.6 Recommendation for our mix (50 to 150 attendees, a few over 1,000)

- **Small webinars (50 to 150).** First ask whether they need the custom
  stream at all: the **Zoom embed** gives real-time video and Zoom's own Q&A,
  and 150 attendees fits inside a normal Zoom webinar licence. Where the
  custom stream is wanted, low latency is affordable at this size: a few
  hundred requests a second is light work.
- **Large webinars (over 1,000).** Standard playback through **CloudFront**,
  with the larger buffer. Here stability and bandwidth matter more than a few
  seconds, and §13's CDN plan already assumes standard playback.
- **How to have both on one server.** Run MediaMTX in the low-latency variant
  permanently, and choose the *player* behaviour per webinar. A low-latency
  playlist still lists full segments, and hls.js with `lowLatencyMode: false`
  plays it like standard HLS (normal buffer, one playlist fetch per segment,
  no query strings, so §13's CDN cache policy still works). This would be a
  per-webinar **Latency: Low / Standard** setting in the Waiting Room card.
  Two caveats to confirm in testing: browsers that play HLS natively choose
  low latency by themselves whenever the playlist offers it. That is iPhone
  Safari, and **also Chrome since 2025** (found Oct 2, 2026: Chrome 147 and
  154 answer "maybe" to `canPlayType("application/vnd.apple.mpegurl")`, so
  our player hands Chrome viewers to Chrome's own player and hls.js never
  runs for them). A Standard setting would therefore mean preferring hls.js
  on Chrome too, and on iPhones from iOS 17.1. Second, whether MediaMTX's
  low-latency output behaves well through nginx (point 4 above).
- **Not recommended:** flipping the server between modes around each big
  event. It means a manual restart before and after, it breaks any stream
  running at the time, and it is easy to forget.

### 14.7 Plan

1. **Measure** the real delay and the stream bitrate on the next practice run,
   with the console's delay meter (§14.8); browser network panel for the
   bitrate.
2. **Pin MediaMTX** to the version currently running
   (`docker exec ea-sys-mediamtx /mediamtx --version`, run by the owner).
3. **Confirm CloudFront** is set up (`HLS_CDN_BASE` in the prod `.env`)
   before any 1,000-viewer custom-stream webinar, independent of this
   decision.
4. **Trial low latency** on a practice webinar with nothing else live:
   `hlsVariant: lowLatency` in `mediamtx.yml` on the box, restart MediaMTX,
   then test Chrome, iPhone Safari and a phone on 4G, and watch CPU and the
   request rate. Revert on 404s or stalls.
5. **If the trial holds,** build the per-webinar Latency setting (§14.6) and
   keep MediaMTX on the low-latency variant. If it does not, stay on standard
   HLS and steer small webinars that need real time to the Zoom embed.

### 14.8 The delay meter in the Webinar Console (built Oct 2, 2026)

Under **Preview the stream** in the Waiting Room card:

- **Our delay** (always on while the preview plays): the server time now
  minus the arrival time of the frame on screen. MediaMTX stamps each chunk
  with the time it arrived (`EXT-X-PROGRAM-DATE-TIME`); hls.js reports it as
  `playingDate`. If a stream carries no stamps, the readout falls back to
  "about N s behind the newest chunk", labelled as an estimate.
- **Zoom's delay (clock test)**: **Open the clock page** opens
  `/stream-clock` (public, no data, no login), which shows a QR code of the
  server time refreshed ten times a second plus the time in the event's
  timezone. The host shares that window in Zoom; **Measure Zoom delay** reads
  the QR code out of the preview for up to a minute, takes 10 readings and
  shows the medians: total = Zoom + ours.
- Both browsers correct their clocks to the server's (`GET /api/public/time`,
  shortest of five round trips), so a laptop clock that is off does not skew
  the result.
- The preview prefers hls.js wherever the browser supports it, because
  Chrome's and Safari's built-in players do not expose the arrival times.
  Attendees' players are unchanged.

**Not yet verified on production:** that our MediaMTX version writes the
arrival stamps. The first live practice run shows it: if "Our delay" reads
"about N s … estimate", it does not, and only the total is measurable.

Verified locally (Oct 2, 2026) with a stand-in for Zoom and MediaMTX: the
clock page captured into a live HLS stream, chunks stamped on arrival.
Result: total 8.1 s = 0.3 s (stand-in for Zoom) + 7.8 s (ours), and the
always-on readout agreed at 7.8 s. Code: `src/lib/stream-latency.ts`,
`src/components/webinar/stream-delay.tsx`, `src/app/stream-clock/`,
`src/hooks/use-server-clock.ts`, `LivePlayer`'s `onTimingSample`.
