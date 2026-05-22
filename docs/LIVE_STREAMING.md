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
   Config (mpegts variant, 7 × 2s segments) lives in
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
| `8888` | HLS | **output** | nginx proxies `/stream/` here; never exposed publicly |
| `8889` | WebRTC | output | Reserved for a future low-latency path; **unused today** |

Defined in both compose files. In prod they are container-internal except as
needed; `1935` must be reachable by whatever pushes the stream (Zoom's
servers, or the host's encoder).

---

## 6. Configuration (`mediamtx.yml`)

```yaml
hlsAddress: :8888
rtmpAddress: :1935
webrtcAddress: :8889

# HLS settings — mpegts variant (fmp4 has known 404 issues)
hlsVariant: mpegts
hlsSegmentCount: 7
hlsSegmentDuration: 2s
hlsSegmentMaxSize: 50M
hlsAlwaysRemux: true

paths:
  all:
    source: publisher
```

Notes:
- **`hlsVariant: mpegts`** — the fmp4 variant had known 404 issues serving
  init segments through the proxy; mpegts is the stable choice.
- **`hlsSegmentCount: 7` × `hlsSegmentDuration: 2s`** ≈ a 14s sliding window.
  Trades latency for resilience to brief network hiccups.
- **`hlsAlwaysRemux: true`** — keep producing HLS segments even with no active
  reader, so the first viewer doesn't wait for a cold start.
- **`paths.all.source: publisher`** — any path accepts a publisher. The
  effective namespace is `/live/{streamKey}` because that's the path the host
  publishes to and the player reads from. **There is no per-stream auth at the
  MediaMTX layer** — the `streamKey` (a server-generated value on the
  `ZoomMeeting` row) is the only thing gating playback, and it's effectively a
  bearer secret. Treat stream keys as secrets.

---

## 7. Environment variables

| Var | Where | Purpose | Default |
|-----|-------|---------|---------|
| `MEDIAMTX_HLS_URL` | app container | Internal URL the `stream-status` route probes to check if a stream is live | `http://localhost:8888` (prod: `http://ea-sys-mediamtx:8888`, set in `docker-compose.prod.yml`) |
| `NEXT_PUBLIC_APP_URL` | app | Base for the public HLS playback URL (`{appUrl}/stream/...`) | `http://localhost:3000` |

---

## 8. nginx proxy — required, but not in the committed config

The playback URL is `{appUrl}/stream/live/{streamKey}/index.m3u8`, which means
nginx must proxy `/stream/` to the MediaMTX container's `:8888`. **This proxy
block is currently NOT present in [`deploy/nginx.conf`](../deploy/nginx.conf)** —
it must be configured on the EC2 box manually. A correct block looks like:

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

> **TODO / hardening:** fold this block into `deploy/nginx.conf` so the proxy
> is reproducible with the rest of the deploy, instead of being a manual
> on-box step that a fresh deploy would silently miss.

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
| [`src/app/api/public/events/[slug]/sessions/[sessionId]/stream-status/route.ts`](../src/app/api/public/events/%5Bslug%5D/sessions/%5BsessionId%5D/stream-status/route.ts) | Probes MediaMTX, flips `streamStatus`, returns playback URL (360/hr per IP) |
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

## 12. Future work

- Fold the nginx `/stream/` proxy into `deploy/nginx.conf` (see §8).
- Per-stream auth at the MediaMTX layer (publish/read tokens) instead of
  relying on the stream key alone.
- Implement the WebRTC (`:8889`) low-latency path for interactive-ish
  broadcasts.
- Recording the HLS output to S3 as a fallback when Zoom cloud recording isn't
  used (today recordings come from Zoom — see `WEBINAR_EVENTS.md`).
