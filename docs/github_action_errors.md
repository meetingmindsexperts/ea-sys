# GitHub Actions Deploy Errors Log

Chronological record of deploy failures with root cause and resolution.

---

## 2026-02-25 — P1012: DIRECT_URL not found

**Step:** Database migrations (docker run ea-sys-migrator)

**Error:**
```
Error: P1012 Environment variable not found: DIRECT_URL.
```

**Root cause:** Migration container was only passed `DATABASE_URL` via `-e`. The Prisma schema requires both `DATABASE_URL` (pooler) and `DIRECT_URL` (direct connection) for migrations.

**Fix (`scripts/deploy.sh`):** Extract `DIRECT_URL` separately from `.env` and pass both as `-e` args:
```bash
MIGRATION_DIRECT_URL=$(grep -E "^DIRECT_URL=" "$DEPLOY_DIR/.env" | head -1 | sed '...')
docker run --rm \
    -e "DATABASE_URL=$MIGRATION_DIRECT_URL" \
    -e "DIRECT_URL=$MIGRATION_DIRECT_URL" \
    ea-sys-migrator npx prisma migrate deploy
```

---

## 2026-02-25 — nginx: directive "server" has no opening "{"

**Step:** nginx upstream switch / reload

**Error:**
```
nginx: [emerg] directive "server" has no opening "{" in
/etc/nginx/conf.d/ea-sys-upstream.conf:1
```

**Root cause:** `deploy.sh` was writing a bare `server 127.0.0.1:PORT;` line to the conf.d file. nginx conf.d files are included at the `http {}` level where a bare `server` directive is invalid; it must be inside an `upstream {}` block.

**Fix (`scripts/deploy.sh`):** Write a complete upstream block:
```bash
printf 'upstream ea_sys_app {\n    server 127.0.0.1:%s;\n    keepalive 32;\n}\n' \
  "$INACTIVE_PORT" | sudo tee "$NGINX_UPSTREAM" > /dev/null
```

---

## 2026-02-25 — nginx: duplicate upstream "ea_sys_app"

**Step:** nginx config test (`nginx -t`)

**Error:**
```
nginx: [emerg] duplicate upstream "ea_sys_app" in
/etc/nginx/sites-available/ea-sys.conf:X
```

**Root cause:** After the conf.d fix, the sites-available `ea-sys.conf` still contained an inline `upstream ea_sys_app { include ...; }` block. Combined with the new conf.d file, nginx saw the upstream defined twice.

**Fix (`deploy/nginx.conf` + server):** Removed the inline `upstream` block from `nginx.conf`. Upstream now lives exclusively in `/etc/nginx/conf.d/ea-sys-upstream.conf`.

---

## 2026-02-25 — Bind for :::3000 failed: port is already allocated

**Step:** Starting ea-sys-blue (`docker compose up -d ea-sys-blue`)

**Error:**
```
Error response from daemon: failed to set up container networking: driver failed
programming external connectivity on endpoint ea-sys-blue (...):
Bind for :::3000 failed: port is already allocated
```

**Context warning:**
```
Found orphan containers ([ea-sys]) for this project. If you removed or renamed
this service in your compose file, you can run this command with the
--remove-orphans flag to clean it up.
```

**Root cause:** The old single-slot container `ea-sys` (from before the blue-green migration) was still running on port 3000 as a compose-project orphan. When deploy tried to start `ea-sys-blue` on port 3000 it collided.

**Fix (`scripts/deploy.sh`):** Two-layer guard before `compose up`:
1. Explicit port-conflict check — stops any container holding the target port:
   ```bash
   PORT_HOLDER=$(docker ps -q --filter "publish=$INACTIVE_PORT")
   if [ -n "$PORT_HOLDER" ]; then
     docker stop $PORT_HOLDER && docker rm -f $PORT_HOLDER
   fi
   ```
2. `--remove-orphans` flag on `compose up` — cleans compose-labelled orphans atomically:
   ```bash
   $COMPOSE up -d --remove-orphans "ea-sys-$INACTIVE"
   ```
