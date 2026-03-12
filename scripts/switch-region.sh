#!/usr/bin/env bash
# switch-region.sh — Switch DNS for events.meetingmindsgroup.com between regions
#
# Usage:
#   bash scripts/switch-region.sh mumbai    # Point DNS to Mumbai EC2
#   bash scripts/switch-region.sh uae       # Point DNS to UAE EC2
#   bash scripts/switch-region.sh status    # Show current DNS target
#
# Prerequisites:
#   - AWS CLI configured with Route 53 permissions (or update for GoDaddy/Cloudflare)
#   - Set env vars: HOSTED_ZONE_ID, MUMBAI_EC2_IP, UAE_EC2_IP
#
# To add UAE back to deploy.yml:
#   1. Add workflow_dispatch region input (mumbai/uae/both)
#   2. Add deploy-uae job with secrets: EC2_HOST, EC2_USER, EC2_SSH_KEY
#   3. Add if conditions on both deploy jobs
#   See git history for the original multi-region workflow.

set -euo pipefail

DOMAIN="events.meetingmindsgroup.com"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"
MUMBAI_IP="${MUMBAI_EC2_IP:-}"
UAE_IP="${UAE_EC2_IP:-}"
TTL=60

if [ -z "$HOSTED_ZONE_ID" ] || [ -z "$MUMBAI_IP" ] || [ -z "$UAE_IP" ]; then
  echo "ERROR: Set environment variables before running:"
  echo "  export HOSTED_ZONE_ID=Z0123456789ABC"
  echo "  export MUMBAI_EC2_IP=3.108.247.193"
  echo "  export UAE_EC2_IP=<uae-elastic-ip>"
  exit 1
fi

ACTION="${1:-status}"

switch_dns() {
  local target_ip="$1"
  local region_label="$2"

  echo "==> Switching $DOMAIN → $target_ip ($region_label)"

  CHANGE_BATCH=$(cat <<EOF
{
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "$DOMAIN",
      "Type": "A",
      "TTL": $TTL,
      "ResourceRecords": [{ "Value": "$target_ip" }]
    }
  }]
}
EOF
)

  aws route53 change-resource-record-sets \
    --hosted-zone-id "$HOSTED_ZONE_ID" \
    --change-batch "$CHANGE_BATCH"

  echo "✓ DNS update submitted. Propagation depends on TTL (currently ${TTL}s)."
  echo "  Verify: dig +short $DOMAIN"
}

show_status() {
  echo "==> Current DNS for $DOMAIN:"
  CURRENT_IP=$(dig +short "$DOMAIN" 2>/dev/null || echo "lookup failed")
  echo "  Resolved IP: $CURRENT_IP"

  if [ "$CURRENT_IP" = "$MUMBAI_IP" ]; then
    echo "  Region: Mumbai (ap-south-1) ← ACTIVE"
  elif [ "$CURRENT_IP" = "$UAE_IP" ]; then
    echo "  Region: UAE (me-central-1) ← ACTIVE"
  else
    echo "  Region: UNKNOWN (IP doesn't match either region)"
  fi

  echo ""
  echo "  Mumbai IP: $MUMBAI_IP"
  echo "  UAE IP:    $UAE_IP"
}

case "$ACTION" in
  mumbai)
    switch_dns "$MUMBAI_IP" "Mumbai (ap-south-1)"
    ;;
  uae)
    switch_dns "$UAE_IP" "UAE (me-central-1)"
    ;;
  status)
    show_status
    ;;
  *)
    echo "Usage: $0 {mumbai|uae|status}"
    exit 1
    ;;
esac
