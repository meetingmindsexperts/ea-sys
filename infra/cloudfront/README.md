# CloudFront for the live stream

The CDN in front of MediaMTX's HLS output. Why and what it costs: [docs/HLS_CDN_PLAN.md](../../docs/HLS_CDN_PLAN.md).

| File | What |
|---|---|
| `setup.sh` | Creates everything below, each only if missing. Run by the owner |
| `distribution.template.json` | The distribution: origin `events.meetingmindsgroup.com`, HTTPS only, three behaviours |
| `cache-playlist.json` | `/stream/*.m3u8`, 1 s |
| `cache-segment.json` | `/stream/*`, 60 s |
| `hls-only.js` | CloudFront Function on the default behaviour: 404, so the distribution never mirrors the site |

The minimum TTLs are above 0 on purpose: nginx sends `Cache-Control: no-cache` on `/stream/`, and
with a minimum TTL of 0 CloudFront would honour it and cache nothing.

## Set up

```bash
ALERT_EMAIL=you@example.com bash infra/cloudfront/setup.sh
```

It prints the `*.cloudfront.net` domain. Viewers keep using the box until step 5.

## Check (plan step 4)

```bash
D=https://<id>.cloudfront.net
curl -sI $D/                                   # 404 from the function
curl -sI $D/stream/live/nothing/index.m3u8     # 404 from MediaMTX, through CloudFront
# with a test stream live on <key>:
curl -sI $D/stream/live/<key>/index.m3u8       # run twice: second says "x-cache: Hit from cloudfront"
```

## Switch on and off (plan step 5)

On: `HLS_CDN_BASE=https://<id>.cloudfront.net` in the box's `.env`, then `bash scripts/deploy.sh`.
Off: remove the line and deploy again. The distribution can stay; idle, it costs nothing.
