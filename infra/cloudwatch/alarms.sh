#!/usr/bin/env bash
#
# infra/cloudwatch/alarms.sh — infrastructure-as-code for the EC2 host alarms.
#
# READ THIS BEFORE YOU CHANGE ANYTHING
# ------------------------------------
# These alarms ALREADY EXIST in AWS. They were created by hand at some point and
# were never captured in the repo, which is how an audit of the *codebase*
# concluded "there are no alarms" — a claim that was false, and which cost us a
# round of duplicate alarms pointed at a second, unconfirmed SNS topic. Two
# alarms on one metric means two emails for one incident, which is the exact
# alert-noise problem we were trying to avoid.
#
# So: this script does not CREATE a parallel set. It re-declares the alarms that
# are actually live, by their real names, on the topic that actually has
# confirmed subscribers. put-metric-alarm is an upsert, so running it is how you
# change a threshold, and running it twice is a no-op.
#
# Before adding an alarm here, check what is already there:
#   aws cloudwatch describe-alarms --region ap-south-1 --alarm-name-prefix ea-sys- \
#     --query 'MetricAlarms[].[AlarmName,StateValue,Threshold]' --output table
#
# WHY THESE ALARMS MATTER
# -----------------------
# Every other alert EA-SYS sends is sent BY THE APP. So the failure mode where the
# HOST dies — and the app therefore cannot log, cannot email, cannot page anyone —
# is the one with no notification path at all. A frozen box is silent. These are
# the only alarms that still fire in that case, because AWS is watching from the
# outside.
#
# Both of our real outages live here:
#   INC-001 — a build ate all RAM on a swapless box and froze the whole host
#   INC-002 — old tagged Docker images filled the disk
#
# RUN IT:
#   bash infra/cloudwatch/alarms.sh            # apply
#   DRY_RUN=1 bash infra/cloudwatch/alarms.sh  # show what would change
#
# VERIFY:
#   aws cloudwatch describe-alarms --region ap-south-1 --alarm-name-prefix ea-sys- \
#     --query 'MetricAlarms[].[AlarmName,StateValue,Threshold]' --output table

set -euo pipefail

REGION="${REGION:-ap-south-1}"
INSTANCE_ID="${INSTANCE_ID:-i-0b51ab1213d084640}"   # Mumbai prod box

# The topic that already has CONFIRMED email subscribers (krishna + vivek).
# Do not invent a new one: an unconfirmed SNS subscription is worse than no alarm,
# because you believe you are covered and you are not.
TOPIC_ARN="${TOPIC_ARN:-arn:aws:sns:ap-south-1:803726282629:ea-sys-alerts}"

DRY_RUN="${DRY_RUN:-}"
DIM="Name=InstanceId,Value=${INSTANCE_ID}"

log() { printf '\n▸ %s\n' "$*"; }

command -v aws >/dev/null 2>&1 || { echo "✗ aws CLI not found"; exit 1; }

# Fail fast if the topic has no confirmed subscriber — an alarm that fires into
# the void is the most dangerous kind, because it looks like coverage.
CONFIRMED=$(aws sns list-subscriptions-by-topic --region "$REGION" --topic-arn "$TOPIC_ARN" \
  --query "length(Subscriptions[?SubscriptionArn!='PendingConfirmation'])" --output text 2>/dev/null || echo 0)
if [ "${CONFIRMED:-0}" -lt 1 ]; then
  echo "✗ ${TOPIC_ARN} has NO confirmed subscribers."
  echo "  Alarms would fire into the void. Subscribe and click the confirmation email first."
  exit 1
fi
echo "✓ Topic has ${CONFIRMED} confirmed subscriber(s): ${TOPIC_ARN}"

put_alarm() {
  local name="$1"; shift
  if [ -n "$DRY_RUN" ]; then
    echo "  [dry-run] $name"
    return
  fi
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
# 85% over 10 minutes. The box carries 4 GB of swap now, but swap on a thrashing
# host buys minutes, not safety — INC-001 froze ALL of userland, including the SSM
# agent, so we could not even get in to look. Two 5-minute datapoints keeps a
# transient spike from paging while still leaving real runway before the wall.
log "Memory + disk — the two metrics our two outages were made of"
put_alarm "ea-sys-ec2-mem-high" \
  --namespace CWAgent --metric-name mem_used_percent --dimensions "$DIM" \
  --statistic Average --period 300 --evaluation-periods 2 \
  --threshold 85 --comparison-operator GreaterThanThreshold \
  --alarm-description "Memory >85% for 10min. INC-001 was a swapless OOM freeze — the host dies silently and the app cannot log its own death. Check: docker stats; is anything building on-box?"

# ── Disk (INC-002) ───────────────────────────────────────────────────────────
# 80%, deliberately early: a deploy extracts Docker layers, so "nearly full" fails
# a DEPLOY long before it fails the app — and you want the warning while you can
# still fix it calmly.
put_alarm "ea-sys-ec2-disk-high" \
  --namespace CWAgent --metric-name disk_used_percent --dimensions "$DIM" \
  --statistic Average --period 300 --evaluation-periods 1 \
  --threshold 80 --comparison-operator GreaterThanThreshold \
  --alarm-description "Disk >80%. INC-002 was old tagged Docker images filling it. Fix: bash scripts/docker-prune.sh"

# ── Host-level ───────────────────────────────────────────────────────────────
# NOTE: ea-sys-ec2-auto-recover is NOT re-declared here. It carries an
# arn:aws:automate:...:ec2:recover action as well as the SNS one — it does not just
# page you, it tells EC2 to recover the instance. It was set up by hand, it works,
# and a careless upsert from this script would silently DROP the recover action.
# Leave it alone. If it ever needs changing, change it deliberately and add the
# automate ARN back to --alarm-actions.
log "Host-level"
put_alarm "ea-sys-ec2-status-check-failed" \
  --namespace AWS/EC2 --metric-name StatusCheckFailed --dimensions "$DIM" \
  --statistic Maximum --period 60 --evaluation-periods 2 \
  --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-description "EC2 status check failing — the instance itself is unhealthy. This is the alarm that still works when the box is too wedged to log anything."

put_alarm "ea-sys-ec2-cpu-high" \
  --namespace AWS/EC2 --metric-name CPUUtilization --dimensions "$DIM" \
  --statistic Average --period 300 --evaluation-periods 2 \
  --threshold 90 --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-description "CPU >90% for 10min. On a burstable t3 this also burns CPU credits — see the credit alarm."

# t3 is burstable. When credits hit zero the box does not fall over, it gets SLOW:
# everything times out and it presents as a database or network problem. Worth
# paging precisely BECAUSE it looks like something else.
put_alarm "ea-sys-ec2-cpu-credits-low" \
  --namespace AWS/EC2 --metric-name CPUCreditBalance --dimensions "$DIM" \
  --statistic Average --period 300 --evaluation-periods 2 \
  --threshold 100 --comparison-operator LessThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-description "t3 CPU credits running out. The box will not crash — it will get slow, and it will look like a DB/network problem. See docs/AWS_OPERATIONS.md."

log "Done."
cat <<EOF

  Alarms report into: ${TOPIC_ARN}

  These are HOST-level and deliberately independent of the app's own SES alert
  pipeline: when the box freezes, the app cannot page you. That is the whole point.

  Verify:
    aws cloudwatch describe-alarms --region ${REGION} --alarm-name-prefix ea-sys- \\
      --query 'MetricAlarms[].[AlarmName,StateValue,Threshold]' --output table

  Not managed here (on purpose): ea-sys-ec2-auto-recover, which also carries an
  ec2:recover action. Do not upsert it from a script that would drop that action.

EOF
