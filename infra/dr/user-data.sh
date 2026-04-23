#!/bin/bash
# DR bootstrap — runs once on first boot of the Singapore replacement box.
#
# Prerequisites (one-time, before running `terraform apply`):
#   1. Nightly `.env` backup to s3://${dr_bucket_name}/env/YYYY-MM-DD.env
#      exists (set up by the Mumbai box's crontab).
#   2. `.env` includes GITHUB_DR_TOKEN=ghp_...  — a fine-grained PAT with
#      "Contents: read" on the ea-sys repo, used once to clone here.
#      (If the repo is ever made public, this can be removed.)
#
# This script must be idempotent-ish — re-running it on the same box should
# not break anything, because Terraform's user_data_replace_on_change = true
# means a change here causes the whole instance to be replaced, not re-run.

set -euxo pipefail

exec > >(tee /var/log/ea-sys-bootstrap.log) 2>&1
echo "[bootstrap] start: $(date -u)"

# --- 1. OS packages ---
export DEBIAN_FRONTEND=noninteractive
apt-get update
# Note: Ubuntu 24.04 (Noble) removed the `awscli` apt package. We install AWS
# CLI v2 manually from the official installer below.
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git nginx jq unzip unattended-upgrades

# Auto-apply security updates
dpkg-reconfigure -plow unattended-upgrades || true

# --- 1b. AWS CLI v2 (official installer — apt's awscli isn't on Noble) ---
curl -sSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp/
/tmp/aws/install
rm -rf /tmp/aws /tmp/awscliv2.zip
aws --version

# --- 2. Docker + compose plugin ---
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > \
  /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker ubuntu
systemctl enable --now docker

# --- 3. Fetch latest .env from the DR bucket ---
mkdir -p /home/ubuntu/ea-sys
LATEST_ENV_KEY=$(aws s3api list-objects-v2 \
  --bucket "${dr_bucket_name}" \
  --prefix "env/" \
  --region "${region}" \
  --query 'sort_by(Contents,&LastModified)[-1].Key' \
  --output text)

if [[ -z "$LATEST_ENV_KEY" || "$LATEST_ENV_KEY" == "None" ]]; then
  echo "[bootstrap] FATAL: no .env snapshot found in s3://${dr_bucket_name}/env/"
  exit 1
fi

aws s3 cp "s3://${dr_bucket_name}/$LATEST_ENV_KEY" /home/ubuntu/ea-sys/.env --region "${region}"
chown ubuntu:ubuntu /home/ubuntu/ea-sys/.env
chmod 600 /home/ubuntu/ea-sys/.env

# --- 4. Clone the repo using GITHUB_DR_TOKEN sourced from .env ---
set +x  # don't echo the token
GITHUB_DR_TOKEN=$(grep -E '^GITHUB_DR_TOKEN=' /home/ubuntu/ea-sys/.env | cut -d= -f2- | tr -d '"' | tr -d "'")
if [[ -z "$GITHUB_DR_TOKEN" ]]; then
  echo "[bootstrap] FATAL: GITHUB_DR_TOKEN not set in .env"
  exit 1
fi
set -x

# Clone into a temp dir, then move everything except the pre-fetched .env.
sudo -u ubuntu git clone --branch "${git_ref}" --depth 1 \
  "https://x-access-token:$GITHUB_DR_TOKEN@github.com/${github_repo}.git" \
  /home/ubuntu/ea-sys-repo

# Preserve the .env we already downloaded
mv /home/ubuntu/ea-sys/.env /tmp/ea-sys.env
rm -rf /home/ubuntu/ea-sys
mv /home/ubuntu/ea-sys-repo /home/ubuntu/ea-sys
mv /tmp/ea-sys.env /home/ubuntu/ea-sys/.env
chown -R ubuntu:ubuntu /home/ubuntu/ea-sys
chmod 600 /home/ubuntu/ea-sys/.env

# --- 5. nginx (blue-green upstream config) ---
cp /home/ubuntu/ea-sys/deploy/nginx.conf /etc/nginx/sites-available/ea-sys
ln -sf /etc/nginx/sites-available/ea-sys /etc/nginx/sites-enabled/ea-sys
rm -f /etc/nginx/sites-enabled/default

# Initial upstream pointing at port 3000 (blue). The deploy script will overwrite this.
mkdir -p /etc/nginx/conf.d
cat > /etc/nginx/conf.d/ea-sys-upstream.conf <<'UPSTREAM'
upstream ea_sys_app {
  server 127.0.0.1:3000;
}
UPSTREAM

# On first boot we don't yet have a TLS cert — so temporarily swap the HTTPS
# server block's `listen 443 ssl` for `listen 443` and comment the cert lines.
# Cloudflare's Full(strict) still works IF we put self-signed here. For the
# break-glass window we accept that for a few minutes until certbot runs.
# Simplest approach: generate a self-signed cert the nginx config can point at.
mkdir -p /etc/letsencrypt/live/events.meetingmindsgroup.com
openssl req -x509 -nodes -days 30 -newkey rsa:2048 \
  -keyout /etc/letsencrypt/live/events.meetingmindsgroup.com/privkey.pem \
  -out /etc/letsencrypt/live/events.meetingmindsgroup.com/fullchain.pem \
  -subj "/CN=events.meetingmindsgroup.com"
# certbot's snippets that nginx.conf includes — stub them if missing
[[ -f /etc/letsencrypt/options-ssl-nginx.conf ]] || \
  curl -sSL -o /etc/letsencrypt/options-ssl-nginx.conf \
    https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf
[[ -f /etc/letsencrypt/ssl-dhparams.pem ]] || \
  openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048

nginx -t
systemctl enable --now nginx

# --- 6. First blue-green deploy ---
cd /home/ubuntu/ea-sys
sudo -u ubuntu -H bash scripts/deploy.sh || {
  echo "[bootstrap] FATAL: deploy.sh failed. Check /var/log/ea-sys-bootstrap.log."
  exit 1
}

echo "[bootstrap] complete: $(date -u)"
echo "[bootstrap] next steps (manual, from runbook):"
echo "  1. Point Cloudflare DNS at this box's EIP."
echo "  2. Once DNS propagates, swap self-signed cert for Let's Encrypt:"
echo "     certbot --nginx -d events.meetingmindsgroup.com --non-interactive --agree-tos -m <email>"
