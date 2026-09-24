# nginx: one config, and how to change it

The production site config is **`deploy/nginx.conf`**. It is a byte-for-byte copy
of the live file on the box, `/etc/nginx/sites-available/ea-sys`, plus a header.
There is no other nginx file in this repo. Last verified identical: 24 Sep 2026.

## Who reads it

| Consumer | When |
|---|---|
| `deploy/setup.sh` | step 6, after Certbot has issued the certificate |
| `infra/dr/user-data.sh` | the Singapore DR bootstrap, after it stubs the certificate paths |
| `docs/FROM_SCRATCH_REBUILD.md` | Phase 4 of a from-scratch rebuild |

The running server never reads the repo. Nothing copies this file to the box on a
deploy: `scripts/deploy.sh` only rewrites `/etc/nginx/conf.d/ea-sys-upstream.conf`
(the blue/green port). So the repo file matters on the day a server is **built**,
and on that day it must be right.

## Changing nginx

The box is where changes happen, because Certbot rewrites the live file.

1. On the box, open `/etc/nginx/sites-available/ea-sys` and make the change.
2. `sudo nginx -t` then `sudo systemctl reload nginx`. A failed test changes nothing.
3. Locally, `npm run nginx:drift`. It is read-only (one SSM `cat`) and prints the
   difference between the box and `deploy/nginx.conf`.
4. Copy the change into `deploy/nginx.conf` and commit it.
5. `npm run nginx:drift` again: it should say identical.

Run the drift check after any Certbot run too. Exit codes: 0 identical, 1 drift,
2 could not check.

## What is deliberately not in this file

- **The upstream** (`ea_sys_app`, blue :3000 or green :3001): `conf.d/ea-sys-upstream.conf`, written by `scripts/deploy.sh`.
- **`/etc/nginx/nginx.conf`**: the stock Ubuntu main config. It says `gzip on` with the default type list, which compresses **HTML only**.
- **Certbot's snippets** (`options-ssl-nginx.conf`, `ssl-dhparams.pem`) and the certificate itself.
- **The maintenance page files** at `/var/www/maintenance`: installed separately, see `deploy/maintenance/README.md`.

## Compression

Today the **Next.js process** compresses JavaScript, CSS, JSON and page data
(`next.config.ts` leaves Next's default `compress` on), and nginx adds only HTML.
Moving the work to nginx frees the app's event loop; it is optional and was not
done as of 24 Sep 2026. The order is fixed, or production serves uncompressed
pages (the login page would go from about 460 KB to 1.7 MB):

1. **nginx first.** In `/etc/nginx/sites-available/ea-sys`, inside the HTTPS
   `server { ... }` block, directly below `limit_conn ea_conn 100;`, add:

   ```nginx
   gzip               on;
   gzip_vary          on;
   gzip_proxied       any;
   gzip_comp_level    5;
   gzip_min_length    1024;
   gzip_types         text/plain text/css text/csv text/xml text/javascript text/x-component
                      application/javascript application/json application/manifest+json
                      application/xml image/svg+xml;
   ```

   Then `sudo nginx -t && sudo systemctl reload nginx`, and the drift check.
2. **Then the app:** `compress: false` in `next.config.ts`, deployed.

Why these settings:

- **Server context, not the top of the file.** The site file is included inside the
  `http { }` block that already says `gzip on`, and repeating it at that level fails
  `nginx -t` as a duplicate.
- **`text/x-component` is on the list**: it is the React Server Components payload
  every in-app navigation fetches. The old template's list missed it.
- **`text/event-stream` is deliberately off it**: the help chat streams it, and
  compression would buffer the stream. `/api/mcp` turns gzip off explicitly for the
  same reason.

## History

- **24 Sep 2026.** The repo held two nginx files: `deploy/nginx.conf`, an old
  template that had drifted from the box, and `deploy/nginx.live-snapshot.conf`,
  the real config. `deploy/setup.sh` and the DR bootstrap installed the template,
  so a rebuilt or failed-over server would have lacked the rate limits, the
  maintenance page and the MCP streaming settings, and carried a gzip block the
  live server never had. The live file was read from the box, found identical to
  the snapshot, and became `deploy/nginx.conf`; the snapshot was deleted and
  `npm run nginx:drift` added so the two cannot silently part again.
