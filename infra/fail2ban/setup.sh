#!/usr/bin/env bash
# Install/refresh the EA-SYS nginx rate-limit fail2ban jail on the box.
# Idempotent — safe to re-run after editing the filter or jail. Run as a user
# with sudo (the SSM shell lands as root, so plain `bash setup.sh` is fine there).
#
#   bash infra/fail2ban/setup.sh
#
# Pairs with the nginx limit_req/limit_conn config in deploy/nginx.conf.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "[fail2ban-setup] installing filter + jail …"
$SUDO install -m 0644 "$DIR/filter.d/nginx-limit-req.conf"   /etc/fail2ban/filter.d/nginx-limit-req.conf
$SUDO install -m 0644 "$DIR/jail.d/nginx-rate-limit.conf"    /etc/fail2ban/jail.d/nginx-rate-limit.conf

echo "[fail2ban-setup] dry-run the filter against the live log (counts matches, bans nothing) …"
$SUDO fail2ban-regex /var/log/nginx/error.log /etc/fail2ban/filter.d/nginx-limit-req.conf || true

echo "[fail2ban-setup] reloading fail2ban …"
$SUDO systemctl reload fail2ban || $SUDO systemctl restart fail2ban

echo "[fail2ban-setup] jail status:"
$SUDO fail2ban-client status nginx-rate-limit
echo "[fail2ban-setup] done."
