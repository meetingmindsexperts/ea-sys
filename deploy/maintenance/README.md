# Maintenance page (nginx, app-independent)

Served by **nginx from disk** when the application upstream is unreachable — a
crash, a failed deploy, or a stopped instance (see
[MAINTENANCE_LOG.md](../../docs/MAINTENANCE_LOG.md) MAINT-001, where every
visitor got a bare `502 Bad Gateway / nginx/1.24.0 (Ubuntu)` for ~90 seconds).

## The three decisions worth knowing

**1. It returns `503`, not `200`.** A `200` would tell Google the page is
genuinely that content and tell Uptime Robot the site is healthy while it is
down. `error_page ... =503` rewrites 502 and 504 to 503, which is the honest
code, and `Retry-After: 600` is the machine-readable "try again in ten minutes".
Monitoring still alerts, which is the point.

**2. Everything is inlined, by necessity.** The page renders while the app is
down, and `/uploads` is served **by the app** (`src/app/uploads/[...path]/route.ts`),
so a logo, font or stylesheet fetched from this origin would fail exactly when
the page is needed. No external hosts either.

**3. API paths get JSON, not HTML.** The live config has no `location /api/` —
only `/api/mcp` and the `/` catch-all — so MCP clients, n8n and the mobile app
would otherwise receive an HTML blob where they expect JSON, and fail with a
parse error rather than a readable one. A `map` on `$uri` picks the error page
per request, which avoids a third copy of the proxy block.

## ⚠ The box is the source of truth for nginx

`/etc/nginx/sites-available/ea-sys` has diverged from `deploy/nginx.conf`
(Certbot rewrote it). Edit the box, then refresh
[`../nginx.live-snapshot.conf`](../nginx.live-snapshot.conf) — otherwise
[FROM_SCRATCH_REBUILD.md](../../docs/FROM_SCRATCH_REBUILD.md) rebuilds a server
without this.

## Install

```bash
sudo mkdir -p /var/www/maintenance
sudo cp maintenance.html maintenance.json /var/www/maintenance/
sudo chmod 644 /var/www/maintenance/*
```

Then apply the config below and `sudo nginx -t && sudo systemctl reload nginx`.
**`nginx -t` is the safety net** — a bad config fails the test rather than the
reload, so the running server is never left broken.

## Config

At **http** level (top of the file, beside the `limit_req_zone` directives):

```nginx
# Stop advertising the nginx version on error pages and in the Server header.
server_tokens off;

# Which error page a request gets. Keyed on the path so an API client is
# answered in the format it asked for.
map $uri $ea_maintenance_page {
    default  /maintenance.html;
    ~^/api/  /maintenance.json;
}
```

Inside the **443 `server`** block:

```nginx
    # Upstream unreachable → a page that needs no application to render.
    error_page 502 503 504 =503 $ea_maintenance_page;

    location = /maintenance.html {
        root /var/www/maintenance;
        internal;
        add_header Retry-After 600 always;
        add_header Cache-Control "no-store" always;
    }

    location = /maintenance.json {
        root /var/www/maintenance;
        internal;
        default_type application/json;
        add_header Retry-After 600 always;
        add_header Cache-Control "no-store" always;
    }
```

`internal` means neither path can be requested directly, so a crawler cannot
index the maintenance page as real content.

`always` on `add_header` is required: without it nginx applies the header only
to 2xx/3xx responses, and this one is only ever sent with a 503.

## Verifying it WITHOUT an outage

The obvious test is to stop the app, which is the thing this exists to avoid.
Instead, temporarily point a throwaway location at a dead port — port 9 is
`discard`, so the connection is refused and nginx produces the 502 that triggers
`error_page`:

```nginx
    location = /__maint_test { proxy_pass http://127.0.0.1:9; }
```

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -s -o /dev/null -D- https://events.meetingmindsgroup.com/__maint_test   # expect 503 + Retry-After
curl -s https://events.meetingmindsgroup.com/__maint_test | head -5           # expect the HTML page
```

**Then remove that location and reload again.** A permanent endpoint that always
returns 503 is a trap for the next person reading the config.

There is no equivalent one-line probe for the JSON branch (`/api/…` is claimed
by the proxy locations), so it is verified by inspection of the `map` plus the
HTML branch working. Worth knowing rather than assumed.
