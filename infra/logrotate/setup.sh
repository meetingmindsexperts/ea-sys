#!/usr/bin/env bash
# Install/refresh EA-SYS application log rotation on the box.
# Idempotent — safe to re-run after editing the config.
#
#   bash infra/logrotate/setup.sh
#
# Pairs with the file destinations in src/lib/logger.ts. See ./README.md for
# why this is needed and why `copytruncate` is load-bearing.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
LOGS_DIR="/home/ubuntu/ea-sys/logs"

echo "[logrotate-setup] current log sizes:"
$SUDO ls -lh "$LOGS_DIR"/*.log 2>/dev/null || echo "  (no .log files yet)"

echo "[logrotate-setup] installing /etc/logrotate.d/ea-sys …"
$SUDO install -m 0644 "$DIR/ea-sys" /etc/logrotate.d/ea-sys

# Validate before trusting it. A bad stanza makes logrotate skip the WHOLE run,
# including everyone else's configs, and it fails quietly in the timer.
echo "[logrotate-setup] validating (debug run — reads config, rotates nothing) …"
$SUDO logrotate -d /etc/logrotate.d/ea-sys

# The hourly timer is what makes `size 100M` meaningful. Without it logrotate
# runs once a day and a burst can add gigabytes between runs.
if ! $SUDO systemctl list-timers --all | grep -q logrotate; then
  echo "[logrotate-setup] ⚠ logrotate.timer not found — the config is installed but nothing runs it."
  echo "   Enable it with: sudo systemctl enable --now logrotate.timer"
else
  echo "[logrotate-setup] logrotate.timer is present:"
  $SUDO systemctl list-timers --all | grep logrotate || true
  echo "[logrotate-setup] NOTE: the stock Debian/Ubuntu timer fires DAILY."
  echo "   For size-based rotation to catch a burst, switch it to hourly:"
  echo "     sudo systemctl edit logrotate.timer     # add: [Timer] / OnCalendar= / OnCalendar=hourly"
  echo "     sudo systemctl restart logrotate.timer"
fi

echo
echo "[logrotate-setup] done. Force one rotation now with:"
echo "    sudo logrotate -f /etc/logrotate.d/ea-sys && ls -lh $LOGS_DIR"
