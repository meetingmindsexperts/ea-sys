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
  echo "[logrotate-setup] logrotate.timer:"
  $SUDO systemctl list-timers --all | grep logrotate || true

  # Report the ACTUAL schedule rather than assuming the stock daily one. An
  # unconditional "your timer is daily" note is worse than none: it is wrong
  # the moment someone fixes it, and a warning that cries wolf gets ignored.
  # `OnCalendar=hourly` normalises to `*-*-* *:00:00` in systemd's output.
  CALENDAR="$($SUDO systemctl show logrotate.timer -p TimersCalendar --value 2>/dev/null || true)"
  if printf '%s' "$CALENDAR" | grep -q '\*:00:00'; then
    echo "[logrotate-setup] ✓ timer is hourly — a burst is caught within the hour."
  else
    echo "[logrotate-setup] ⚠ timer is NOT hourly (${CALENDAR:-unknown})."
    echo "   'size 100M' only bites when logrotate actually runs; the stock timer is daily,"
    echo "   which can let gigabytes accumulate overnight. Switch it:"
    echo "     sudo mkdir -p /etc/systemd/system/logrotate.timer.d"
    # printf, not echo: this line is itself a printf command we want printed
    # literally, backslash-n and all, for the operator to copy.
    printf '     %s\n' "printf '[Timer]\\nOnCalendar=\\nOnCalendar=hourly\\n' | sudo tee /etc/systemd/system/logrotate.timer.d/override.conf"
    echo "     sudo systemctl daemon-reload && sudo systemctl restart logrotate.timer"
  fi
fi

echo
echo "[logrotate-setup] done. Force one rotation now with:"
echo "    sudo logrotate -f /etc/logrotate.d/ea-sys && ls -lh $LOGS_DIR"
