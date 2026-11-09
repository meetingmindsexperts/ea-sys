#!/usr/bin/env bash
#
# "The app is not loading": what went wrong, in one command from a laptop.
#
#   npm run prod:diagnose            # last 15 minutes
#   MINUTES=60 npm run prod:diagnose
#
# Works when EA-SYS itself is down, which is exactly when the /logs viewer
# cannot help: it reads only from outside the app (the public URL, the EC2 API,
# CloudWatch). READ-ONLY. It changes nothing on AWS or the box and never opens
# a session on it.
#
# Needs: the AWS CLI with read access in ap-south-1, curl, python3.
#
# What each section means, and what to do next: infra/cloudwatch/README.md
# §"App not loading".

set -uo pipefail

REGION="${AWS_REGION:-ap-south-1}"
APP_URL="${APP_URL:-https://events.meetingmindsgroup.com}"
INSTANCE_ID="${EA_SYS_INSTANCE_ID:-i-0b51ab1213d084640}"
MINUTES="${MINUTES:-15}"

hr() { printf '\n== %s\n' "$*"; }

# Docker json-file lines → "time [service] line". Plain lines pass through.
unwrap() {
  python3 -c '
import json, sys
for raw in sys.stdin:
    raw = raw.rstrip("\n")
    head, _, rest = raw.partition(" ")  # --format short: "<time> <message>"
    try:
        d = json.loads(rest)
        svc = (d.get("attrs") or {}).get("ea_sys_service", d.get("stream", "?"))
        print(head, "[" + svc + "]", d.get("log", "").rstrip()[:600])
    except Exception:
        print(raw[:600])
'
}

hr "1. Public URL ($APP_URL)"
for path in /api/health /worker/health; do
  out=$(curl -s -o /tmp/ea-sys-diag.$$ -w '%{http_code} %{time_total}s' --max-time 10 "$APP_URL$path" 2>&1)
  echo "$path → $out"
  head -c 300 /tmp/ea-sys-diag.$$ 2>/dev/null; echo
done
rm -f /tmp/ea-sys-diag.$$
echo "(000 = nothing answered: box or nginx down. 502/504 = nginx up, app not answering.)"

hr "2. The EC2 box ($INSTANCE_ID)"
aws ec2 describe-instance-status --region "$REGION" --instance-ids "$INSTANCE_ID" \
  --include-all-instances \
  --query 'InstanceStatuses[0].{state:InstanceState.Name,system:SystemStatus.Status,instance:InstanceStatus.Status}' \
  --output table 2>&1

hr "3. CloudWatch alarms firing now"
aws cloudwatch describe-alarms --region "$REGION" --state-value ALARM \
  --query 'MetricAlarms[].[AlarmName,StateUpdatedTimestamp,StateReason]' --output text 2>&1 \
  | sed 's/^/  /' | grep . || echo "  none"

hr "4. Container output, last ${MINUTES}m (warnings, errors, crash traces; ea-sys/docker)"
aws logs tail ea-sys/docker --region "$REGION" --since "${MINUTES}m" --format short 2>&1 \
  | tail -n 60 | unwrap | grep . || echo "  nothing"

hr "5. nginx errors, last ${MINUTES}m (ea-sys/nginx-error)"
aws logs tail ea-sys/nginx-error --region "$REGION" --since "${MINUTES}m" --format short 2>&1 \
  | tail -n 25 | cut -c1-400 | grep . || echo "  nothing"

hr "6. App errors, last ${MINUTES}m (ea-sys/error)"
aws logs tail ea-sys/error --region "$REGION" --since "${MINUTES}m" --format short 2>&1 \
  | tail -n 25 | cut -c1-400 | grep . || echo "  nothing"

hr "Next, if you need to look on the box (run these yourself):"
cat <<EOF
  aws ssm start-session --target $INSTANCE_ID --region $REGION
  docker ps --format 'table {{.Names}}\t{{.Status}}'
  docker logs ea-sys-blue --since ${MINUTES}m --tail 100     # or ea-sys-green / ea-sys-worker
EOF
