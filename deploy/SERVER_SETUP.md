# One-Time Server Setup for Blue-Green Deployment

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

| Phase                  | Before  | After   |
|------------------------|---------|---------|
| docker system prune    | ~60s    | removed |
| npm install (cached)   | ~90s    | ~10s    |
| next build (cached)    | ~180s   | ~90s    |
| container swap         | ~30s    | ~1s     |
| **Total**              | **~5m** | **~2m** |
