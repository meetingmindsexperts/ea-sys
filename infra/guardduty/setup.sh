#!/usr/bin/env bash
#
# infra/guardduty/setup.sh: GuardDuty threat detection, wired to the alert email.
#
# WHAT IT DOES
# ------------
# CloudTrail (on since Nov 5, 2026) RECORDS what happens in the account.
# GuardDuty WATCHES those records plus VPC flow logs and DNS, and raises a
# finding when something looks like an attack: the instance role's credentials
# used from outside AWS, the box talking to a crypto-mining or command-and-control
# host, a successful brute force, CloudTrail being switched off, an unfamiliar
# principal listing the DR bucket. It closes the "no detection" gap in
# docs/RANSOMWARE_RESPONSE.md section 6 (#4): without it we learn about a
# break-in from the ransom note.
#
# THE SHAPE
# ---------
#   ap-south-1 (Mumbai): the box, the uploads bucket, the alert topic.
#       GuardDuty detector
#       EventBridge rule ea-sys-guardduty-findings: severity >= 4 -> SNS ea-sys-alerts
#   ap-southeast-1 (Singapore): the DR bucket.
#       GuardDuty detector
#       EventBridge rule ea-sys-guardduty-forward -> Mumbai's default event bus,
#       where the rule above picks the finding up. One topic, one place to look.
#
# A FINDING THAT REACHES NOBODY IS NOT DETECTION. GuardDuty on its own only writes
# to its console, which nobody opens. The EventBridge rule is the part that tells
# a person, which is why this script refuses to run if the topic has no confirmed
# subscriber (same rule as infra/cloudwatch/alarms.sh).
#
# SEVERITY >= 4 means Medium and High. Low findings (a port probe against a
# closed port, which happens to every public box all day) stay in the console.
#
# PROTECTION PLANS
#   S3 protection        ON   the DR and uploads buckets are the targets that matter
#   EBS malware scan     ON   runs only when a finding points at malware on the box;
#                             costs per GB scanned. The root volume is KMS-encrypted
#                             (Sep 4, 2026): if a scan ever fails with a KMS error,
#                             the key policy needs the GuardDuty service-linked role.
#   Runtime monitoring   OFF  needs an agent on the box
#   RDS / EKS / Lambda   OFF  we run none of them (the database is Supabase)
#
# COST: 30 days free per region; the console then shows an estimate before the
# first charge (Usage tab). Expect roughly $10 to $30 a month in total.
#
# RUN IT (it is idempotent: every call is an upsert):
#   bash infra/guardduty/setup.sh               # apply
#   SAMPLE=1 bash infra/guardduty/setup.sh      # apply, then send one sample finding
#
# VERIFY:
#   for r in ap-south-1 ap-southeast-1; do aws guardduty list-detectors --region $r; done
#   aws events list-targets-by-rule --rule ea-sys-guardduty-findings --region ap-south-1
#
# FIRST RUN (Nov 6, 2026): the sample created in the same minute as the new
# detectors never reached EventBridge; a second one sent ~45 minutes later was
# emailed within a minute. If the test email does not arrive, send another:
#   aws guardduty create-sample-findings --region ap-south-1 \
#     --detector-id <id> --finding-types "Backdoor:EC2/C&CActivity.B"
# It prints nothing on success. Delivery is visible in the AWS/Events
# Invocations metric for the rule and AWS/SNS NumberOfNotificationsDelivered.
#
# Sample findings carry "[SAMPLE]" in the title. Archive them in the GuardDuty
# console (Findings, select, Actions, Archive) after the test email arrives.

set -euo pipefail

ACCOUNT="${ACCOUNT:-803726282629}"
HOME_REGION="ap-south-1"
DR_REGION="ap-southeast-1"
TOPIC_ARN="${TOPIC_ARN:-arn:aws:sns:${HOME_REGION}:${ACCOUNT}:ea-sys-alerts}"
RULE_NAME="ea-sys-guardduty-findings"
FORWARD_RULE="ea-sys-guardduty-forward"
FORWARD_ROLE="ea-sys-guardduty-forward"
HOME_BUS_ARN="arn:aws:events:${HOME_REGION}:${ACCOUNT}:event-bus/default"
RULE_ARN="arn:aws:events:${HOME_REGION}:${ACCOUNT}:rule/${RULE_NAME}"

log() { printf '\n▸ %s\n' "$*"; }

command -v aws >/dev/null 2>&1 || { echo "✗ aws CLI not found"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "✗ python3 not found (used to edit the topic policy)"; exit 1; }

CONFIRMED=$(aws sns list-subscriptions-by-topic --region "$HOME_REGION" --topic-arn "$TOPIC_ARN" \
  --query "length(Subscriptions[?SubscriptionArn!='PendingConfirmation'])" --output text 2>/dev/null || echo 0)
if [ "${CONFIRMED:-0}" -lt 1 ]; then
  echo "✗ ${TOPIC_ARN} has NO confirmed subscribers. Findings would reach nobody."
  exit 1
fi
echo "✓ Topic has ${CONFIRMED} confirmed subscriber(s): ${TOPIC_ARN}"

FEATURES='[
  {"Name":"S3_DATA_EVENTS","Status":"ENABLED"},
  {"Name":"EBS_MALWARE_PROTECTION","Status":"ENABLED"},
  {"Name":"RUNTIME_MONITORING","Status":"DISABLED"},
  {"Name":"EKS_AUDIT_LOGS","Status":"DISABLED"},
  {"Name":"RDS_LOGIN_EVENTS","Status":"DISABLED"},
  {"Name":"LAMBDA_NETWORK_LOGS","Status":"DISABLED"}
]'

# Prints the detector id. Creates the detector, or brings an existing one to the
# same settings, so a re-run never leaves two regions configured differently.
ensure_detector() {
  local region="$1" id
  id=$(aws guardduty list-detectors --region "$region" --query 'DetectorIds[0]' --output text)
  if [ "$id" = "None" ] || [ -z "$id" ]; then
    id=$(aws guardduty create-detector --region "$region" --enable \
      --finding-publishing-frequency FIFTEEN_MINUTES \
      --features "$FEATURES" --query DetectorId --output text)
  else
    aws guardduty update-detector --region "$region" --detector-id "$id" --enable \
      --finding-publishing-frequency FIFTEEN_MINUTES --features "$FEATURES"
  fi
  echo "$id"
}

log "GuardDuty detector, ${HOME_REGION}"
HOME_DETECTOR=$(ensure_detector "$HOME_REGION")
echo "  detector ${HOME_DETECTOR}"

log "GuardDuty detector, ${DR_REGION}"
DR_DETECTOR=$(ensure_detector "$DR_REGION")
echo "  detector ${DR_DETECTOR}"

# The topic's default policy only lets principals of this ACCOUNT publish, and
# EventBridge publishes as the events.amazonaws.com SERVICE, so without this
# statement every delivery fails silently (FailedInvocations, no email).
# Scoped to this one rule. Other statements are kept as they are.
log "Allow ${RULE_NAME} to publish to the alert topic"
POLICY=$(aws sns get-topic-attributes --region "$HOME_REGION" --topic-arn "$TOPIC_ARN" \
  --query 'Attributes.Policy' --output text)
NEW_POLICY=$(POLICY="$POLICY" TOPIC_ARN="$TOPIC_ARN" RULE_ARN="$RULE_ARN" python3 - <<'PY'
import json, os
policy = json.loads(os.environ["POLICY"])
sid = "AllowGuardDutyFindingsRule"
policy["Statement"] = [s for s in policy.get("Statement", []) if s.get("Sid") != sid]
policy["Statement"].append({
    "Sid": sid,
    "Effect": "Allow",
    "Principal": {"Service": "events.amazonaws.com"},
    "Action": "sns:Publish",
    "Resource": os.environ["TOPIC_ARN"],
    "Condition": {"ArnEquals": {"aws:SourceArn": os.environ["RULE_ARN"]}},
})
print(json.dumps(policy))
PY
)
aws sns set-topic-attributes --region "$HOME_REGION" --topic-arn "$TOPIC_ARN" \
  --attribute-name Policy --attribute-value "$NEW_POLICY"

log "EventBridge rule ${RULE_NAME} (${HOME_REGION}): Medium and High findings -> email"
aws events put-rule --region "$HOME_REGION" --name "$RULE_NAME" \
  --description "GuardDuty findings, severity 4 and above, to ea-sys-alerts (infra/guardduty/setup.sh)" \
  --event-pattern '{"source":["aws.guardduty"],"detail-type":["GuardDuty Finding"],"detail":{"severity":[{"numeric":[">=",4]}]}}' \
  --state ENABLED >/dev/null

# The raw finding is several KB of JSON; the email carries the lines a person
# needs to decide whether to get up, plus the console link.
TARGETS=$(TOPIC_ARN="$TOPIC_ARN" python3 - <<'PY'
import json, os
template = (
    "GuardDuty finding, severity <sev> (4-6.9 Medium, 7+ High), region <region>\n\n"
    "<title>\n\n<desc>\n\n"
    "Type: <type>\nResource: <resource>\nFinding id: <id>\n\n"
    "Open: https://console.aws.amazon.com/guardduty/home?region=<region>#/findings?search=id%3D<id>\n"
    "Runbook: docs/RANSOMWARE_RESPONSE.md"
)
print(json.dumps([{
    "Id": "ea-sys-alerts",
    "Arn": os.environ["TOPIC_ARN"],
    "InputTransformer": {
        "InputPathsMap": {
            "sev": "$.detail.severity", "region": "$.region", "title": "$.detail.title",
            "desc": "$.detail.description", "type": "$.detail.type",
            "resource": "$.detail.resource.resourceType", "id": "$.detail.id",
        },
        "InputTemplate": json.dumps(template),
    },
}]))
PY
)
aws events put-targets --region "$HOME_REGION" --rule "$RULE_NAME" --targets "$TARGETS" >/dev/null
echo "  ✓ target: ${TOPIC_ARN}"

log "IAM role ${FORWARD_ROLE} (lets the Singapore rule put events on Mumbai's bus)"
if ! aws iam get-role --role-name "$FORWARD_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$FORWARD_ROLE" \
    --description "EventBridge: forward GuardDuty findings from ap-southeast-1 to ap-south-1" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"events.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
fi
aws iam put-role-policy --role-name "$FORWARD_ROLE" --policy-name put-events-home-bus \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"events:PutEvents\",\"Resource\":\"${HOME_BUS_ARN}\"}]}"
FORWARD_ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${FORWARD_ROLE}"

log "EventBridge rule ${FORWARD_RULE} (${DR_REGION}) -> ${HOME_BUS_ARN}"
aws events put-rule --region "$DR_REGION" --name "$FORWARD_RULE" \
  --description "Forward GuardDuty findings to ap-south-1, where ${RULE_NAME} emails them (infra/guardduty/setup.sh)" \
  --event-pattern '{"source":["aws.guardduty"],"detail-type":["GuardDuty Finding"]}' \
  --state ENABLED >/dev/null
# A brand-new role can take a few seconds to become assumable; retry briefly.
for attempt in 1 2 3 4 5; do
  if aws events put-targets --region "$DR_REGION" --rule "$FORWARD_RULE" \
    --targets "[{\"Id\":\"home-bus\",\"Arn\":\"${HOME_BUS_ARN}\",\"RoleArn\":\"${FORWARD_ROLE_ARN}\"}]" >/dev/null; then
    echo "  ✓ target: ${HOME_BUS_ARN}"
    break
  fi
  [ "$attempt" = 5 ] && { echo "✗ could not attach the forward target"; exit 1; }
  sleep 5
done

if [ -n "${SAMPLE:-}" ]; then
  log "Sample finding (High, 8.0) in ${HOME_REGION}; the email should arrive within ~5 minutes"
  aws guardduty create-sample-findings --region "$HOME_REGION" --detector-id "$HOME_DETECTOR" \
    --finding-types "UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS"
fi

log "Done"
echo "  Detectors: ${HOME_REGION} ${HOME_DETECTOR}, ${DR_REGION} ${DR_DETECTOR}"
echo "  Next: update docs/RANSOMWARE_RESPONSE.md section 2 (GuardDuty row) and section 6 (#4)."
