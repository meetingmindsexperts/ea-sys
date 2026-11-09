#!/usr/bin/env bash
# CloudFront in front of the live stream: docs/HLS_CDN_PLAN.md §5, steps 1 to 3.
#
# Run by the owner (infra mutations are never run by an agent), from anywhere, with admin AWS
# credentials:
#
#   ALERT_EMAIL=you@example.com bash infra/cloudfront/setup.sh
#
# Creates, each only if missing (safe to re-run):
#   - the CloudFront Function `ea-sys-hls-only` (404 for anything outside /stream/)
#   - the cache policies `ea-sys-hls-playlist` (1 s) and `ea-sys-hls-segment` (60 s)
#   - the distribution commented "ea-sys live stream (HLS)", origin events.meetingmindsgroup.com
#   - the budget `cloudfront-live-stream`: $50 a month on CloudFront, emails at 80% actual and
#     100% forecast
#
# Changes nothing for viewers: they keep using the box until HLS_CDN_BASE is set (step 5).
set -euo pipefail

: "${ALERT_EMAIL:?set ALERT_EMAIL to the address the budget alarm should email}"
HERE="$(cd "$(dirname "$0")" && pwd)"
COMMENT="ea-sys live stream (HLS)"
FUNCTION_NAME="ea-sys-hls-only"
BUDGET_NAME="cloudfront-live-stream"
CF="aws cloudfront --region us-east-1"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "Account $ACCOUNT"

# ── 1. The 404 function for the default behaviour ──────────────────────────────
if $CF describe-function --name "$FUNCTION_NAME" --stage LIVE >/dev/null 2>&1; then
  echo "Function $FUNCTION_NAME exists"
else
  etag="$($CF create-function --name "$FUNCTION_NAME" \
    --function-config Comment="404 outside /stream/",Runtime=cloudfront-js-2.0 \
    --function-code "fileb://$HERE/hls-only.js" --query ETag --output text)"
  $CF publish-function --name "$FUNCTION_NAME" --if-match "$etag" >/dev/null
  echo "Function $FUNCTION_NAME created and published"
fi
FUNCTION_ARN="$($CF describe-function --name "$FUNCTION_NAME" --stage LIVE \
  --query FunctionSummary.FunctionMetadata.FunctionARN --output text)"

# ── 2. Cache policies ──────────────────────────────────────────────────────────
policy_id() {
  $CF list-cache-policies --type custom \
    --query "CachePolicyList.Items[?CachePolicy.CachePolicyConfig.Name=='$1'].CachePolicy.Id | [0]" \
    --output text
}
ensure_policy() {
  local name="$1" file="$2" id
  id="$(policy_id "$name")"
  if [ -z "$id" ] || [ "$id" = "None" ]; then
    id="$($CF create-cache-policy --cache-policy-config "file://$HERE/$file" \
      --query CachePolicy.Id --output text)"
    echo "Cache policy $name created" >&2
  else
    echo "Cache policy $name exists" >&2
  fi
  echo "$id"
}
PLAYLIST_POLICY="$(ensure_policy ea-sys-hls-playlist cache-playlist.json)"
SEGMENT_POLICY="$(ensure_policy ea-sys-hls-segment cache-segment.json)"

# ── 3. The distribution ────────────────────────────────────────────────────────
DIST_ID="$($CF list-distributions \
  --query "DistributionList.Items[?Comment=='$COMMENT'].Id | [0]" --output text)"
if [ -n "$DIST_ID" ] && [ "$DIST_ID" != "None" ]; then
  echo "Distribution $DIST_ID exists"
else
  rendered="$(mktemp)"
  trap 'rm -f "$rendered"' EXIT
  sed -e "s|__CALLER_REF__|ea-sys-hls-$(date +%s)|" \
      -e "s|__FUNCTION_ARN__|$FUNCTION_ARN|" \
      -e "s|__PLAYLIST_POLICY__|$PLAYLIST_POLICY|" \
      -e "s|__SEGMENT_POLICY__|$SEGMENT_POLICY|" \
      "$HERE/distribution.template.json" > "$rendered"
  DIST_ID="$($CF create-distribution --distribution-config "file://$rendered" \
    --query Distribution.Id --output text)"
  echo "Distribution $DIST_ID created (deploys to the edges in about 5 to 15 minutes)"
fi
DOMAIN="$($CF get-distribution --id "$DIST_ID" --query Distribution.DomainName --output text)"

# ── 4. The spending alarm ──────────────────────────────────────────────────────
if aws budgets describe-budget --account-id "$ACCOUNT" --budget-name "$BUDGET_NAME" >/dev/null 2>&1; then
  echo "Budget $BUDGET_NAME exists"
else
  aws budgets create-budget --account-id "$ACCOUNT" \
    --budget "{\"BudgetName\":\"$BUDGET_NAME\",\"BudgetLimit\":{\"Amount\":\"50\",\"Unit\":\"USD\"},\"TimeUnit\":\"MONTHLY\",\"BudgetType\":\"COST\",\"CostFilters\":{\"Service\":[\"Amazon CloudFront\"]}}" \
    --notifications-with-subscribers "[
      {\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":80,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$ALERT_EMAIL\"}]},
      {\"Notification\":{\"NotificationType\":\"FORECASTED\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$ALERT_EMAIL\"}]}
    ]"
  echo "Budget $BUDGET_NAME created (\$50 a month on CloudFront)"
fi

echo
echo "Distribution: $DIST_ID"
echo "Domain:       https://$DOMAIN"
echo "Viewers are unaffected until HLS_CDN_BASE=https://$DOMAIN is set in the box's .env (plan step 5)."
