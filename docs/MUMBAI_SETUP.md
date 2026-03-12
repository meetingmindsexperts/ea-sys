# Mumbai (ap-south-1) EC2 Setup Guide

Emergency region migration from ME-Central-1 (UAE) to AP-South-1 (Mumbai) due to AWS Middle East region disruption.

## Architecture

```
                    ┌──────────────────────────────────┐
                    │  DNS: events.meetingmindsgroup.com │
                    └───────────────┬──────────────────┘
                                    │
                    ┌───────────────┴──────────────────┐
                    │         Route 53 / DNS            │
                    │     (manual or health-check)      │
                    └───┬───────────────────────┬──────┘
                        │                       │
              ┌─────────▼─────────┐   ┌─────────▼─────────┐
              │  Mumbai EC2       │   │  UAE EC2           │
              │  ap-south-1       │   │  me-central-1      │
              │  t3.large         │   │  t3.large          │
              │  ← ACTIVE         │   │  ← STANDBY         │
              └─────────┬─────────┘   └─────────┬─────────┘
                        │                       │
                        └───────┬───────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │  Supabase PostgreSQL      │
                    │  (shared, independent)    │
                    └──────────────────────────┘
```

## Step 1: Launch EC2 in Mumbai

```bash
# Launch t3.large in ap-south-1 with Ubuntu 22.04 LTS
# - Allocate an Elastic IP (so IP survives stop/start)
# - Security group: allow 80, 443, 22 (from your IP)
# - Storage: 30GB gp3

# Note: Use the same key pair name or create a new one
```

## Step 2: Server Setup (SSH into Mumbai instance)

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu

# Install Docker Compose (v2 plugin)
sudo apt install -y docker-compose-plugin

# Install nginx
sudo apt install -y nginx

# Install Node.js 22 (for prisma CLI if needed)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Install git
sudo apt install -y git
```

## Step 3: Clone and Configure

```bash
# Clone repo
cd /home/ubuntu
git clone git@github.com:YOUR_ORG/ea-sys.git
cd ea-sys

# Copy .env from UAE instance (or create new)
# CRITICAL: Same DATABASE_URL pointing to Supabase
# CRITICAL: Update NEXTAUTH_URL and NEXT_PUBLIC_APP_URL
cat > .env << 'ENVEOF'
DATABASE_URL="postgresql://...@db.xxx.supabase.co:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://...@db.xxx.supabase.co:5432/postgres"
NEXTAUTH_SECRET="<same-as-uae>"
NEXTAUTH_URL="https://events.meetingmindsgroup.com"
NEXT_PUBLIC_APP_URL="https://events.meetingmindsgroup.com"
BREVO_API_KEY="<same-as-uae>"
EMAIL_FROM="<same-as-uae>"
EMAIL_FROM_NAME="<same-as-uae>"
LOG_LEVEL="info"
ENVEOF

# Create required directories
mkdir -p logs public/uploads
sudo chown -R 1001:1001 logs public/uploads
```

## Step 4: Nginx Configuration

```bash
# Copy nginx config (same structure as UAE)
sudo cp deploy/nginx/ea-sys.conf /etc/nginx/sites-available/ea-sys
sudo ln -sf /etc/nginx/sites-available/ea-sys /etc/nginx/sites-enabled/ea-sys

# Create upstream config
echo 'upstream ea_sys_app {
    server 127.0.0.1:3000;
    keepalive 32;
}' | sudo tee /etc/nginx/conf.d/ea-sys-upstream.conf

# Initialize active slot
echo "blue" > /home/ubuntu/.active-slot

# Install SSL cert (use certbot)
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d events.meetingmindsgroup.com
# Note: DNS must point to Mumbai IP before certbot can verify

sudo nginx -t && sudo systemctl restart nginx
```

## Step 5: First Deploy

```bash
cd /home/ubuntu/ea-sys
bash scripts/deploy.sh
```

## Step 6: Sync Uploaded Photos

Photos in `/public/uploads/` are on the filesystem, not in Supabase.

```bash
# Option A: rsync from UAE (if accessible)
rsync -avz ubuntu@<UAE_IP>:/home/ubuntu/ea-sys/public/uploads/ /home/ubuntu/ea-sys/public/uploads/

# Option B: If UAE is unreachable, photos will 404 until region recovers.
# The app still works — just profile photos won't load.
# Consider moving to S3/Cloudflare R2 for cross-region photo access.
```

## Step 7: Switch DNS

```bash
# Set env vars
export HOSTED_ZONE_ID="Z0123456789ABC"
export MUMBAI_EC2_IP="13.x.x.x"
export UAE_EC2_IP="3.x.x.x"

# Switch to Mumbai
bash scripts/switch-region.sh mumbai

# Verify
dig +short events.meetingmindsgroup.com
```

## Step 8: GitHub Secrets

Add these secrets in your GitHub repo (Settings → Secrets):

| Secret | Value |
|--------|-------|
| `MUMBAI_EC2_HOST` | Mumbai Elastic IP |
| `MUMBAI_EC2_USER` | `ubuntu` |
| `MUMBAI_EC2_SSH_KEY` | SSH private key for Mumbai instance |

Existing `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY` remain for UAE.

## Switching Back to UAE

When ME-Central-1 recovers:

1. **Deploy latest to UAE:** GitHub Actions → Run workflow → Select "uae"
2. **Sync photos:** `rsync` from Mumbai to UAE
3. **Switch DNS:** `bash scripts/switch-region.sh uae`
4. **Verify:** Check health endpoint and site
5. **Optional:** Keep Mumbai as warm standby by deploying "both"

## Cost Estimate

Mumbai t3.large: ~$60/month (similar to UAE pricing).
Keep it running as standby or stop instance when UAE recovers (Elastic IP costs ~$3.6/month when instance is stopped).

## Latency Considerations

| Route | Latency |
|-------|---------|
| Mumbai → Supabase (if US/EU hosted) | +50-80ms vs UAE |
| Mumbai → UAE users | ~40-60ms |
| Mumbai → India/Asia users | <20ms |

For an event management app, this latency is imperceptible to users.
