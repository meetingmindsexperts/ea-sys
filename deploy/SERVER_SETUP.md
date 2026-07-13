# One-Time Server Setup for Blue-Green Deployment

> **Scope note (July 13, 2026):** this doc covers ONLY the blue-green nginx/slot wiring on an already-provisioned box. For rebuilding a production server **from scratch** (instance, IAM role, swap, packages, secrets, crontab, fail2ban, CloudWatch, CI reattachment), start from **`docs/FROM_SCRATCH_REBUILD.md`** — this doc is its Phase 4.

Run these commands **once** on the EC2 server before the first blue-green deploy.

## 1. Allow ubuntu to control nginx (sudoers)

```bash
sudo tee /etc/sudoers.d/ea-sys-deploy << 'EOF'
ubuntu ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/nginx/conf.d/ea-sys-upstream.conf
ubuntu ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t
ubuntu ALL=(ALL) NOPASSWD: /usr/sbin/nginx -s reload
EOF
sudo chmod 440 /etc/sudoers.d/ea-sys-deploy
```

## 2. Create initial nginx upstream config (blue = port 3000)

The conf.d file must contain a **complete upstream block** so nginx can include it
at the http level without errors. A bare `server ...;` line is only valid inside
an `upstream {}` context.

```bash
printf 'upstream ea_sys_app {\n    server 127.0.0.1:3000;\n    keepalive 32;\n}\n' \
  | sudo tee /etc/nginx/conf.d/ea-sys-upstream.conf
```

## 3. Update nginx site config

```bash
sudo cp /home/ubuntu/ea-sys/deploy/nginx.conf /etc/nginx/sites-available/ea-sys
sudo sed -i 's/YOUR_DOMAIN/events.meetingmindsgroup.com/g' /etc/nginx/sites-available/ea-sys
sudo nginx -t && sudo systemctl reload nginx
```

## 4. Migrate existing container to blue slot

> **Historical step** — this migrated the pre-blue-green `ea-sys` container in 2026. On a from-scratch rebuild there is no old container; skip to step 5 (the first `scripts/deploy.sh` run starts the slot).

```bash
cd /home/ubuntu/ea-sys

# Stop and remove old ea-sys container
docker compose -f docker-compose.prod.yml down --remove-orphans 2>/dev/null || true
docker rm -f ea-sys 2>/dev/null || true

# Start blue slot
docker compose -f docker-compose.prod.yml up -d ea-sys-blue

# Verify it's healthy
curl -s http://localhost:3000/api/health
```

## 5. Set initial active slot

```bash
echo "blue" > /home/ubuntu/.active-slot
```

## 6. Verify everything

```bash
# nginx should still be routing traffic normally
curl -I https://events.meetingmindsgroup.com

# Active slot file
cat /home/ubuntu/.active-slot

# Containers
docker compose -f /home/ubuntu/ea-sys/docker-compose.prod.yml ps
```

After this, all future deploys via GitHub Actions will automatically run the
blue-green script with zero downtime.

## How it works

```
Deploy N:   blue running (port 3000) → nginx → users
            build green (port 3001) while blue serves traffic
            health check green
            nginx reload → green (port 3001) → users   [~50ms switch]
            stop blue

Deploy N+1: green running (port 3001) → nginx → users
            build blue (port 3000) while green serves traffic
            health check blue
            nginx reload → blue (port 3000) → users   [~50ms switch]
            stop green
```

## Expected deploy times after setup

> **Updated July 13, 2026** — the original table described the on-box `npm install` / `next build` era. Since the ECR cutover (and INC-001, which is exactly why builds moved off-box), CI builds + pushes the images and the box only pulls:

| Phase                          | Time      |
|--------------------------------|-----------|
| ECR pull (web + worker images) | ~30–60s   |
| migrations + health check      | ~30–45s   |
| nginx switch                   | ~1s       |
| **Total**                      | **~1–2m** |

On-box building only happens as the ECR-unreachable fallback (~8 min — and requires the swap from `docs/FROM_SCRATCH_REBUILD.md` Phase 2 to be safe). `docker system prune` runs as a weekly Friday cron, not per-deploy.
