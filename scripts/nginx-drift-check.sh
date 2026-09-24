#!/usr/bin/env bash
# Compare the LIVE nginx site config on the production box with deploy/nginx.conf.
#
# READ-ONLY: one SSM `send-command` that runs `cat`, then `get-command-invocation`.
# Nothing on the box is changed. See deploy/NGINX.md for why this exists: the
# repo once held two nginx files, one of them stale, and the setup script and
# the DR bootstrap installed the stale one.
#
#   npm run nginx:drift                      # production (Mumbai)
#   INSTANCE_ID=i-... REGION=... npm run nginx:drift
#
# Exit codes: 0 identical, 1 drift (the diff is printed), 2 could not check.
set -euo pipefail

INSTANCE_ID="${INSTANCE_ID:-i-0b51ab1213d084640}"
REGION="${REGION:-ap-south-1}"
LIVE_PATH="/etc/nginx/sites-available/ea-sys"
REPO_FILE="$(cd "$(dirname "$0")/.." && pwd)/deploy/nginx.conf"

command -v aws >/dev/null || { echo "✗ aws CLI not found" >&2; exit 2; }
[[ -f "$REPO_FILE" ]] || { echo "✗ $REPO_FILE missing" >&2; exit 2; }

cid=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript --comment "read-only: nginx drift check" \
  --parameters "commands=[\"sudo cat $LIVE_PATH\"]" \
  --query "Command.CommandId" --output text) || { echo "✗ send-command failed" >&2; exit 2; }

status="Pending"
for _ in $(seq 1 20); do
  sleep 2
  status=$(aws ssm get-command-invocation --region "$REGION" --command-id "$cid" \
    --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || echo "Pending")
  [[ "$status" == "Success" || "$status" == "Failed" || "$status" == "TimedOut" || "$status" == "Cancelled" ]] && break
done
[[ "$status" == "Success" ]] || { echo "✗ SSM command ended as: $status" >&2; exit 2; }

live=$(mktemp); repo=$(mktemp); trap 'rm -f "$live" "$repo"' EXIT
aws ssm get-command-invocation --region "$REGION" --command-id "$cid" \
  --instance-id "$INSTANCE_ID" --query StandardOutputContent --output text > "$live"

# get-command-invocation truncates output at 24,000 characters; a truncated
# read would look like drift, so refuse instead of reporting a false one.
if (( $(wc -c < "$live") >= 24000 )); then
  echo "✗ live file reached the 24,000-character SSM output limit; compare by hand" >&2
  exit 2
fi

# The repo copy is the live file plus a header: drop everything up to and
# including the header's closing rule line and the blank line after it.
awk 'seen >= 2 { print; next } /^# ─{20,}/ { seen++; if (seen == 2) { getline; if ($0 != "") print } }' "$REPO_FILE" > "$repo"

# Trailing blank lines are noise (SSM output and editors disagree on them).
strip() { sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$1"; }
if diff -u --label "repo: deploy/nginx.conf" --label "box: $LIVE_PATH" <(strip "$repo") <(strip "$live"); then
  echo "✓ identical: the box and deploy/nginx.conf agree ($INSTANCE_ID, $REGION)"
  exit 0
fi
echo ""
echo "✗ DRIFT. If the box is right (it usually is: Certbot and hand edits land there),"
echo "  copy the change into deploy/nginx.conf and commit it. See deploy/NGINX.md."
exit 1
