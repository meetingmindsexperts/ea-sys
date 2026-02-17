#!/usr/bin/env bash
# deploy/setup.sh
# One-time EC2 server setup script.
# Run as ubuntu user on a fresh Ubuntu 22.04 LTS instance.
# Usage: bash deploy/setup.sh YOUR_DOMAIN (e.g. app.meetingmindsdubai.com)

set -euo pipefail

DOMAIN="${1:-YOUR_DOMAIN}"
APP_DIR="/home/ubuntu/ea-sys"

echo "==> [1/6] Updating system packages"
sudo apt-get update -y && sudo apt-get upgrade -y

echo "==> [2/6] Installing nginx, certbot, git"
sudo apt-get install -y nginx certbot python3-certbot-nginx git

echo "==> [3/6] Installing Docker"
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
# Apply group without needing logout — only works for the remainder of this script
newgrp docker <<DOCKERGROUP

echo "==> [4/6] Setting up nginx"
sudo cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/ea-sys
sudo sed -i "s/YOUR_DOMAIN/$DOMAIN/g" /etc/nginx/sites-available/ea-sys
sudo ln -sf /etc/nginx/sites-available/ea-sys /etc/nginx/sites-enabled/ea-sys
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl restart nginx

echo "==> [5/6] Obtaining SSL certificate via Let's Encrypt"
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@${DOMAIN#*.}"
sudo systemctl reload nginx

echo "==> [6/6] Enable Docker on boot"
sudo systemctl enable docker

DOCKERGROUP

echo ""
echo "============================================================"
echo " Server setup complete!"
echo ""
echo " Next steps:"
echo "   1. Clone your repo:  git clone <repo-url> $APP_DIR"
echo "   2. Create .env file: cp $APP_DIR/.env.example $APP_DIR/.env"
echo "                        nano $APP_DIR/.env  (fill in all values)"
echo "   3. First deploy:"
echo "      cd $APP_DIR"
echo "      docker compose -f docker-compose.prod.yml up -d --build"
echo ""
echo " To add another app in future:"
echo "   1. Add service to docker-compose.prod.yml (use commented template)"
echo "   2. Add nginx server block (use commented template in nginx.conf)"
echo "   3. Run: sudo certbot --nginx -d new-app.domain.com"
echo "   4. sudo nginx -t && sudo systemctl reload nginx"
echo "   5. docker compose -f docker-compose.prod.yml up -d --build new-app"
echo "============================================================"
