#!/usr/bin/env bash
#
# One-time setup script: install the AWS CloudWatch agent on the
# Mumbai EC2 box, configure it from the version-controlled config in
# infra/cloudwatch/amazon-cloudwatch-agent.json, and start the systemd
# service so it ships /home/ubuntu/ea-sys/logs/{app,error}.log to
# CloudWatch Logs in ap-south-1.
#
# IDEMPOTENT — safe to re-run. Detects an existing install + config
# and re-applies cleanly. Use to update the agent config after a
# version-bump in this repo:
#
#   cd /home/ubuntu/ea-sys
#   bash infra/cloudwatch/setup.sh
#
# Prerequisites:
#   1. EC2 instance role (ea-sys-mumbai-ec2-role) MUST have a policy
#      granting:
#         logs:CreateLogGroup
#         logs:CreateLogStream
#         logs:PutLogEvents
#         logs:DescribeLogStreams
#         logs:DescribeLogGroups
#         logs:PutRetentionPolicy
#      Easiest: attach the AWS-managed CloudWatchAgentServerPolicy
#      (broader than strictly needed, but well-tested and AWS-managed
#      so it stays current with service evolution). See README.md.
#
#   2. The Mumbai box must have outbound HTTPS reachability to
#      logs.ap-south-1.amazonaws.com (default VPC security group
#      allows this; if a tight egress filter is in place, allowlist
#      port 443 to that endpoint).
#
# Failure mode: every failing path logs to stdout AND exits non-zero
# so cron / deploy automation surfaces problems rather than silently
# continuing.

set -euo pipefail

# ─── Config ─────────────────────────────────────────────────────────
REPO_ROOT="${REPO_ROOT:-/home/ubuntu/ea-sys}"
AGENT_CONFIG_SRC="${REPO_ROOT}/infra/cloudwatch/amazon-cloudwatch-agent.json"
AGENT_CONFIG_DST="/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json"
AGENT_DEB_URL="https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb"
TMP_DEB="/tmp/amazon-cloudwatch-agent.deb"
REGION="${AWS_REGION:-ap-south-1}"

log()  { echo "[cloudwatch-setup] $*"; }
fail() { echo "[cloudwatch-setup] ERROR: $*" >&2; exit 1; }

# ─── Sanity checks ──────────────────────────────────────────────────
[ -f "${AGENT_CONFIG_SRC}" ] || fail "Config file not found: ${AGENT_CONFIG_SRC}"
[ -d "${REPO_ROOT}/logs" ]   || fail "Log directory not found: ${REPO_ROOT}/logs (run scripts/deploy.sh first?)"

# Check IAM role connectivity. The agent will fail silently if the
# instance has no credentials; surface this early.
if ! aws sts get-caller-identity --region "${REGION}" >/dev/null 2>&1; then
  fail "AWS CLI can't authenticate. Verify the EC2 instance role is attached + the CloudWatchAgentServerPolicy is granted."
fi

# ─── Install or update the agent package ────────────────────────────
if dpkg -l amazon-cloudwatch-agent 2>/dev/null | grep -q "^ii"; then
  log "Agent already installed; skipping download."
else
  log "Downloading agent .deb from S3..."
  wget -q -O "${TMP_DEB}" "${AGENT_DEB_URL}" || fail "Agent download failed."

  log "Installing agent package..."
  sudo dpkg -i -E "${TMP_DEB}" || fail "dpkg install failed."
  rm -f "${TMP_DEB}"
fi

# ─── Deploy the config ──────────────────────────────────────────────
log "Installing agent config..."
sudo install -m 0644 -o root -g root "${AGENT_CONFIG_SRC}" "${AGENT_CONFIG_DST}"

# ─── Permissions on log files ───────────────────────────────────────
# The cwagent user (created by the package install) needs read access
# to the Docker-mounted log files. Docker writes them as the container
# user (typically uid 1000 / "ubuntu" group). Make sure cwagent can
# read them WITHOUT giving it write access (read-only ACL would be
# tighter; chmod-the-directory is the pragmatic approach).
log "Ensuring cwagent can read /home/ubuntu/ea-sys/logs/*.log..."
sudo chmod 0755 "${REPO_ROOT}/logs"
sudo find "${REPO_ROOT}/logs" -type f -name "*.log" -exec chmod 0644 {} \;

# ─── Apply config + start ───────────────────────────────────────────
log "Applying config + starting agent..."
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -s \
  -c "file:${AGENT_CONFIG_DST}" || fail "amazon-cloudwatch-agent-ctl fetch-config failed."

# ─── Verify ─────────────────────────────────────────────────────────
log "Verifying agent status..."
if ! sudo systemctl is-active --quiet amazon-cloudwatch-agent; then
  fail "Agent is not running. Check 'sudo journalctl -u amazon-cloudwatch-agent --no-pager -n 50'."
fi

log "Verifying log groups are visible in CloudWatch..."
sleep 5  # Give the agent a moment to create the streams
for GROUP in "ea-sys/app" "ea-sys/error"; do
  if aws logs describe-log-groups \
       --log-group-name-prefix "${GROUP}" \
       --region "${REGION}" \
       --query 'logGroups[?logGroupName==`'"${GROUP}"'`].logGroupName' \
       --output text 2>/dev/null | grep -q "${GROUP}"; then
    log "  ✓ ${GROUP} present"
  else
    log "  ! ${GROUP} not yet visible — may appear after the first log line is shipped (run any action that produces a log entry, then re-check in 30s)."
  fi
done

log "Done. Logs will start flowing to CloudWatch within a few minutes."
log ""
log "View live: aws logs tail ea-sys/app --follow --region ${REGION}"
log "          aws logs tail ea-sys/error --follow --region ${REGION}"
log ""
log "Next step: see infra/cloudwatch/README.md §3 for the metric"
log "filter + alarm + SNS setup (optional — gives a fourth notification"
log "path via email when the error log rate spikes)."
