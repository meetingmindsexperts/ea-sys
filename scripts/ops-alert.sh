#!/usr/bin/env bash
#
# scripts/ops-alert.sh — send an operational alert email via SES.
#
# The one place that knows how to page a human from the box. Extracted from
# scripts/dr-pg-dump.sh, which had this inline; other ops paths (a failed
# deploy, a failed CI run) need the same thing and were silently sending
# nothing at all.
#
# Auth comes from the EC2 instance role — no keys, no .env needed. That is
# also why this lives on the box rather than in GitHub Actions: the runner
# would need new IAM permissions, the box already has ses:SendEmail.
#
# Usage:
#   bash scripts/ops-alert.sh "<subject>" "<body>"
#   ALERT_EMAIL_TO=someone@example.com bash scripts/ops-alert.sh "..." "..."
#
# Never fails the caller: an SES outage must not mask the original error that
# prompted the alert. Always exits 0, and says so on stderr if the send failed.

set -uo pipefail

ALERT_EMAIL_FROM="${ALERT_EMAIL_FROM:-alerts@meetingmindsexperts.com}"
ALERT_EMAIL_TO="${ALERT_EMAIL_TO:-krishna@meetingmindsdubai.com}"
SES_REGION="${SES_REGION:-ap-south-1}"

SUBJECT="${1:-EA-SYS ops alert}"
BODY="${2:-(no body)}"

# SES shorthand syntax chokes on commas/braces inside the value, so use the
# JSON form and let the shell do the quoting properly.
MESSAGE_JSON=$(SUBJECT="$SUBJECT" BODY="$BODY" python3 -c '
import json, os
print(json.dumps({
  "Subject": {"Data": os.environ["SUBJECT"], "Charset": "UTF-8"},
  "Body": {"Text": {"Data": os.environ["BODY"], "Charset": "UTF-8"}},
}))
')

if aws ses send-email \
    --region "$SES_REGION" \
    --from "$ALERT_EMAIL_FROM" \
    --destination "ToAddresses=$ALERT_EMAIL_TO" \
    --message "$MESSAGE_JSON" \
    >/dev/null 2>&1; then
  echo "ops-alert: sent → $ALERT_EMAIL_TO — $SUBJECT"
else
  # Loud on stderr, but exit 0 — see header.
  echo "ops-alert: SES SEND FAILED (alert lost) — $SUBJECT" >&2
fi

exit 0
