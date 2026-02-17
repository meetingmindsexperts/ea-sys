#!/usr/bin/env bash
# deploy/setup.sh
# One-time EC2 server setup script.
# Run as ubuntu user on a fresh Ubuntu 22.04 LTS instance.
# Usage: bash deploy/setup.sh YOUR_DOMAIN EMAIL
# Example: bash deploy/setup.sh events.meetingmindsgroup.com admin@meetingmindsgroup.com

set -euo pipefail

DOMAIN="${1:-YOUR_DOMAIN}"
EMAIL="${2:-admin@meetingmindsgroup.com}"
APP_DIR="/home/ubuntu/ea-sys"

echo "==> [1/7] Updating system packages"
sudo apt-get update -y && sudo apt-get upgrade -y

echo "==> [2/7] Installing nginx, certbot, git"
sudo apt-get install -y nginx certbot python3-certbot-nginx git

echo "==> [3/7] Installing Docker"
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
sudo systemctl enable docker

echo "==> [4/7] Starting nginx with temporary HTTP-only config"
# Certbot needs nginx running on port 80 to issue the SSL cert.
# We start with a plain HTTP config first, then switch to full SSL after.
sudo tee /etc/nginx/sites-available/ea-sys > /dev/null << NGINXEOF
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:3000;
    }
}
NGINXEOF

sudo ln -sf /etc/nginx/sites-available/ea-sys /etc/nginx/sites-enabled/ea-sys
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl restart nginx

echo "==> [5/7] Obtaining SSL certificate via Let's Encrypt"
echo "    NOTE: Port 80 must be open in your EC2 Security Group for this step."
echo "    After the cert is issued you can remove port 80 from the Security Group."
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL"

echo "==> [6/7] Applying production nginx config (SSL + proxy)"
sudo cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/ea-sys
sudo sed -i "s/YOUR_DOMAIN/$DOMAIN/g" /etc/nginx/sites-available/ea-sys
sudo nginx -t
sudo systemctl reload nginx

echo "==> [7/7] Done"

echo ""
echo "============================================================"
echo " Server setup complete!"
echo ""
echo " You can now remove port 80 from your EC2 Security Group."
echo " Only port 443 (HTTPS) and 22 (SSH) are needed going forward."
echo ""
echo " First deploy:"
echo "   cd $APP_DIR"
echo "   docker compose -f docker-compose.prod.yml up -d --build"
echo ""
echo " To add another app later:"
echo "   1. Add service block to docker-compose.prod.yml"
echo "   2. Add server block to /etc/nginx/sites-available/ea-sys"
echo "   3. sudo certbot --nginx -d new-app.domain.com"
echo "   4. sudo nginx -t && sudo systemctl reload nginx"
echo "   5. docker compose -f docker-compose.prod.yml up -d --build new-app-name"
echo "============================================================"
