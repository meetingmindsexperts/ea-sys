#!/usr/bin/env bash
#
# infra/cloudwatch/alarms.sh — create the CloudWatch alarms EA-SYS has never had.
#
# THE POINT
# ---------
# The CloudWatch agent has been collecting `mem_used_percent` and
# `disk used_percent` for months. Those are exactly the two metrics behind our
# two worst outages:
#
#   INC-001 — an on-box docker build ate all RAM and froze a swapless t3.large
#   INC-002 — old tagged images filled the disk
#
# We alarmed on NEITHER. The data was there; nobody was watching it. Every alert
# EA-SYS sends today is application-level (an error was logged) — which means the
# failure mode where the *host* dies, and therefore the app can't log anything,
# is precisely the one with no notification path at all. A frozen box is silent.
#
# This script closes that. It is idempotent: `put-metric-alarm` and
# `create-topic` are both upserts, so re-running is safe and is in fact how you
# change a threshold.
#
# RUN IT (from your machine, or the box):
#   ALERT_EMAIL=krishna@meetingmindsdubai.com bash infra/cloudwatch/alarms.sh
#
# Then CONFIRM THE SNS SUBSCRIPTION — AWS emails you a confirmation link and the
# subscription does nothing until you click it. An unconfirmed subscription is a
# silent alarm, which is worse than no alarm because you think you're covered.
#
# Verify afterwards:
#   aws cloudwatch describe-alarms --region ap-south-1 \
#     --alarm-name-prefix ea-sys- --query 'MetricAlarms[].[AlarmName,StateValue]' --output table

set -euo pipefail

REGION="${REGION:-ap-south-1}"
INSTANCE_ID="${INSTANCE_ID:-i-0b51ab1213d084640}"   # Mumbai prod box
TOPIC_NAME="${TOPIC_NAME:-ea-sys-ops-alerts}"
ALERT_EMAIL="${ALERT_EMAIL:-krishna@meetingmindsdubai.com}"

log() { printf '\n▸ %s\n' "$*"; }

command -v aws >/dev/null 2>&1 || { echo "✗ aws CLI not found"; exit 1; }

# ── SNS topic + email subscription ───────────────────────────────────────────
log "Ensuring SNS topic ${TOPIC_NAME}…"
TOPIC_ARN=$(aws sns create-topic \
  --name "$TOPIC_NAME" \
  --region "$REGION" \
  --query 'TopicArn' --output text)
echo "  $TOPIC_ARN"

if aws sns list-subscriptions-by-topic \
     --topic-arn "$TOPIC_ARN" --region "$REGION" \
     --query 'Subscriptions[].Endpoint' --output text 2>/dev/null \
   | tr '\t' '\n' | grep -qxF "$ALERT_EMAIL"; then
  echo "  ✓ ${ALERT_EMAIL} already subscribed"
else
  aws sns subscribe \
    --topic-arn "$TOPIC_ARN" \
    --protocol email \
    --notification-endpoint "$ALERT_EMAIL" \
    --region "$REGION" >/dev/null
  echo "  → subscription requested for ${ALERT_EMAIL}"
  echo "  ⚠ CHECK YOUR INBOX AND CLICK THE CONFIRMATION LINK."
  echo "    Until you do, these alarms fire into the void."
fi

DIM="Name=InstanceId,Value=${INSTANCE_ID}"

put_alarm() {
  local name="$1"; shift
  aws cloudwatch put-metric-alarm \
    --region "$REGION" \
    --alarm-name "$name" \
    --alarm-actions "$TOPIC_ARN" \
    --ok-actions "$TOPIC_ARN" \
    --treat-missing-data breaching \
    "$@"
  echo "  ✓ $name"
}

# ── Memory (INC-001) ─────────────────────────────────────────────────────────
# 85% for 10 minutes. The box is swapless-by-default (that WAS the incident), so
# there is no gradual degradation to notice — it goes from fine to frozen. Two
# 5-minute datapoints keeps a transient build spike from paging, but still gives
# a real warning before the OOM wall.
log "Memory + disk alarms (the two metrics our two incidents were made of)…"
put_alarm "ea-sys-mumbai-memory-high" \
  --namespace CWAgent --metric-name mem_used_percent --dimensions "$DIM" \
  --statistic Average --period 300 --evaluation-periods 2 \
  --threshold 85 --comparison-operator GreaterThanThreshold \
  --alarm-description "Memory >85% for 10min on the Mumbai box. INC-001 was a swapless OOM freeze — the host dies silently and the app cannot log its own death. Check: docker stats, and whether anything is building on-box."

# ── Disk (INC-002) ───────────────────────────────────────────────────────────
# 80% is deliberately early. Docker layer extraction during a deploy needs
# headroom, so "nearly full" fails a deploy long before it fails the app.
put_alarm "ea-sys-mumbai-disk-high" \
  --namespace CWAgent --metric-name disk_used_percent --dimensions "$DIM" \
  --statistic Average --period 300 --evaluation-periods 1 \
  --threshold 80 --comparison-operator GreaterThanThreshold \
  --alarm-description "Disk >80% on the Mumbai box. INC-002 was old tagged Docker images filling it. Fix: bash scripts/docker-prune.sh"

# ── Instance status check ────────────────────────────────────────────────────
# The one alarm that still fires when the box is so wedged it cannot report
# anything else — this is EC2's own view of the instance, not the agent's.
log "Host-level alarms…"
put_alarm "ea-sys-mumbai-status-check-failed" \
  --namespace AWS/EC2 --metric-name StatusCheckFailed --dimensions "$DIM" \
  --statistic Maximum --period 60 --evaluation-periods 2 \
  --threshold 0 --comparison-operator GreaterThanThreshold \
  --alarm-description "EC2 status check failing — the instance itself is unhealthy/unreachable. This is the alarm that still works when the box is too wedged to log."

# ── CPU credit balance (the t3 trap) ─────────────────────────────────────────
# t3 is burstable. When credits hit zero the box does not fall over, it gets
# SLOW — everything times out and it looks like a database or network problem.
# Worth a page precisely because it presents as something else.
put_alarm "ea-sys-mumbai-cpu-credits-low" \
  --namespace AWS/EC2 --metric-name CPUCreditBalance --dimensions "$DIM" \
  --statistic Average --period 300 --evaluation-periods 2 \
  --threshold 40 --comparison-operator LessThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-description "t3 CPU credits nearly exhausted. The box will not crash, it will get slow, and it will look like a DB/network problem. See docs/AWS_OPERATIONS.md."

log "Done."
cat <<EOF

  Alarms now report into: ${TOPIC_ARN}

  These are HOST-level alarms and they are independent of the application's own
  SES alert pipeline on purpose — when the box freezes, the app cannot page you.
  That was the gap.

  Confirm the SNS email subscription if you have not already. Then verify:

    aws cloudwatch describe-alarms --region ${REGION} \\
      --alarm-name-prefix ea-sys- \\
      --query 'MetricAlarms[].[AlarmName,StateValue]' --output table

  A freshly-created alarm sits in INSUFFICIENT_DATA until it has enough
  datapoints. That is expected; it should move to OK within ~15 minutes.

EOF
