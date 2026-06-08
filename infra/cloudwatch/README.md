# CloudWatch Logs — operator runbook

**Purpose:** ship structured Pino logs from the Mumbai EC2 box to AWS CloudWatch Logs (ap-south-1) as the third notification path alongside Sentry capture and the SES admin-alert email pipeline.

**Why a third path:** Sentry + admin-alert email are already in place and reliable. CloudWatch adds:

- **Cross-region log durability** — Mumbai box could fail; CloudWatch logs survive.
- **Log Insights querying** — SQL-ish queries across structured Pino JSON (find every Stripe webhook failure in the last 24 hours, group `apiLogger.error` by module, etc.).
- **Metric filters + alarms** — count error lines per minute, alarm if it spikes, fire SNS → email. Different signal-to-noise tuning than the admin-alert email's per-error fire.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Mumbai EC2 (ap-south-1)                                     │
│  ┌─────────────────────────────────┐                        │
│  │ Docker containers:              │                        │
│  │   - ea-sys-blue / -green (web)  │                        │
│  │   - ea-sys-worker               │                        │
│  │                                 │                        │
│  │ All write to /app/logs/*.log    │                        │
│  └────────────┬────────────────────┘                        │
│               │ (Docker volume mount)                       │
│               ▼                                             │
│  /home/ubuntu/ea-sys/logs/                                  │
│    ├── app.log      (info + warn + error)                   │
│    └── error.log    (error only)                            │
│               │                                             │
│               │ watched by:                                 │
│               ▼                                             │
│  amazon-cloudwatch-agent (systemd service)                  │
│               │                                             │
│               │ (HTTPS, IAM auth via instance role)         │
│               ▼                                             │
└───────────────┼─────────────────────────────────────────────┘
                ▼
       ┌────────────────────────────────────┐
       │ CloudWatch Logs (ap-south-1)       │
       │  ┌──────────────────────────────┐  │
       │  │ ea-sys/app   (30-day retain) │  │
       │  │ ea-sys/error (90-day retain) │  │
       │  └──────────────────────────────┘  │
       └────────────────────────────────────┘
                ▼
       (optional, §3) metric filter → CloudWatch alarm → SNS topic → email
```

The agent reads the **same Pino log files** that the `/logs` dashboard reads from the SystemLog Postgres table. So:

| Reader | Latency | Best for |
|---|---|---|
| `/logs` dashboard | Realtime (SystemLog Postgres) | Operator self-service investigation, full-text search |
| CloudWatch Logs | ~30s flush window | Cross-region durability, Insights queries, metric-filter alarms |
| `tail -f /home/ubuntu/ea-sys/logs/app.log` | Instant | SSH-into-box emergency debugging |

Three parallel paths, no single point of failure.

---

## 2. One-time setup

### Step 2.1 — IAM policy on the instance role

The Mumbai EC2 box has an instance role (typically `ea-sys-mumbai-ec2-role`). It needs CloudWatch Logs write permissions. Easiest path: attach the AWS-managed `CloudWatchAgentServerPolicy`.

```bash
# Run locally (with AWS CLI configured) OR in CloudShell:

aws iam attach-role-policy \
  --role-name ea-sys-mumbai-ec2-role \
  --policy-arn arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy
```

This grants:
- `logs:CreateLogGroup` / `logs:CreateLogStream` / `logs:PutLogEvents` / `logs:DescribeLogStreams` / `logs:DescribeLogGroups`
- `logs:PutRetentionPolicy`
- A bunch of CloudWatch metrics + EC2 describe permissions (broader than this use case strictly needs, but AWS-managed = always current; the tightening is low ROI)

Verify:
```bash
aws iam list-attached-role-policies --role-name ea-sys-mumbai-ec2-role
```
Should include `CloudWatchAgentServerPolicy`.

### Step 2.2 — Install + configure the agent on the Mumbai box

SSH into the Mumbai box, then:

```bash
cd /home/ubuntu/ea-sys
bash infra/cloudwatch/setup.sh
```

The script:
1. Verifies the IAM role works (`aws sts get-caller-identity`)
2. Installs the AWS CloudWatch agent .deb if not already present
3. Deploys `infra/cloudwatch/amazon-cloudwatch-agent.json` to `/opt/aws/amazon-cloudwatch-agent/etc/`
4. Ensures the `cwagent` system user can read the log files
5. Starts the systemd service via `amazon-cloudwatch-agent-ctl`
6. Verifies the log groups appear in CloudWatch

Idempotent — safe to re-run any time. Use it as the update path when this repo's `amazon-cloudwatch-agent.json` changes.

### Step 2.3 — Verify logs are flowing

After setup completes, generate some activity (load the dashboard, fire any error), then:

```bash
# Tail the live stream from your local terminal:
aws logs tail ea-sys/app --follow --region ap-south-1

# Or just describe the streams to confirm they exist:
aws logs describe-log-streams \
  --log-group-name ea-sys/app \
  --region ap-south-1
```

Within 1-2 minutes you should see Pino-formatted JSON lines streaming in.

---

## 3. Optional — alarm on error-log spikes (deferred, but documented)

The runbook above gets logs INTO CloudWatch. To get **alarms OUT** of CloudWatch (so you're notified of error spikes without needing to check the dashboard), three more steps:

### Step 3.1 — Create an SNS topic + subscribe your email

```bash
# Create the topic
aws sns create-topic \
  --name ea-sys-cloudwatch-alarms \
  --region ap-south-1

# Subscribe your email (replace the address)
aws sns subscribe \
  --topic-arn arn:aws:sns:ap-south-1:<ACCOUNT_ID>:ea-sys-cloudwatch-alarms \
  --protocol email \
  --notification-endpoint krishna@meetingmindsdubai.com \
  --region ap-south-1
```

You'll get a confirmation email — click the "Confirm subscription" link.

### Step 3.2 — Create a metric filter on `ea-sys/error`

```bash
aws logs put-metric-filter \
  --log-group-name ea-sys/error \
  --filter-name error-log-count \
  --filter-pattern '{ $.level >= 50 }' \
  --metric-transformations \
      metricName=EaSysErrorCount,\
      metricNamespace=EA-SYS,\
      metricValue=1,\
      defaultValue=0 \
  --region ap-south-1
```

The filter pattern `{ $.level >= 50 }` matches Pino's `error` level (50 = error, 60 = fatal). Pino's `info` = 30 and `warn` = 40, so this excludes them.

### Step 3.3 — Create an alarm on the metric

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name ea-sys-error-log-spike \
  --alarm-description "Fires when EA-SYS produces > 5 error logs in 5 minutes" \
  --metric-name EaSysErrorCount \
  --namespace EA-SYS \
  --statistic Sum \
  --period 300 \
  --evaluation-periods 1 \
  --threshold 5 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions arn:aws:sns:ap-south-1:<ACCOUNT_ID>:ea-sys-cloudwatch-alarms \
  --region ap-south-1
```

The 5-errors-in-5-minutes threshold is a starting point. Tune by watching false positives over a week.

**Comparison to the existing SES admin-alert pipeline:**
- SES admin-alert: fires per individual error (with 1-hour dedupe per error message). High signal, low noise per error.
- CloudWatch alarm: fires when error COUNT spikes. High signal for spike events; ignores singletons.

Both are useful. Together: SES catches new error patterns; CloudWatch catches volume anomalies.

---

## 4. Operational notes

### Cost

CloudWatch Logs pricing (Mumbai region, June 2026):
- Ingest: $0.76 per GB
- Storage: $0.03 per GB-month (after retention period above, lines are deleted)
- Insights query scan: $0.0076 per GB scanned

Current EA-SYS log volume: rough estimate ~50-200 MB/month. **Cost is well under $1/month at current scale.**

Budget alert recommended:
```bash
aws budgets create-budget \
  --account-id <ACCOUNT_ID> \
  --budget '{"BudgetName":"ea-sys-cloudwatch","BudgetLimit":{"Amount":"10","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --region us-east-1  # Budgets always in us-east-1
```

### Updating the agent config

The config in this repo (`infra/cloudwatch/amazon-cloudwatch-agent.json`) is the source of truth. To roll out a change:

1. Edit the file in this repo
2. Commit + push (deploy doesn't auto-roll out — agent config is host-side, not container-side)
3. SSH to the Mumbai box
4. `cd /home/ubuntu/ea-sys && bash infra/cloudwatch/setup.sh`

The setup script re-applies the config + restarts the systemd service.

### Troubleshooting

**Agent isn't shipping any logs:**
```bash
# Check service status
sudo systemctl status amazon-cloudwatch-agent

# Tail the agent's own log
sudo tail -f /opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log
```

Common causes:
- IAM role missing the policy → `aws sts get-caller-identity` from the box should work; `aws logs describe-log-groups` should NOT error with AccessDenied
- File permissions → `cwagent` user must be able to read `/home/ubuntu/ea-sys/logs/*.log`
- Egress firewall → port 443 to `logs.ap-south-1.amazonaws.com` must be reachable

**Agent runs but no logs appear in CloudWatch (the most common failure):**

Most likely cause: `cwagent` lacks read access to the log files. Common scenarios:
- `/home/ubuntu` is mode `0700` or `0750`, blocking traversal for non-ubuntu users (this is the Ubuntu default on some installs)
- Files have correct mode `0644` but the parent dir blocks access

The setup script now applies ACLs to surgically grant cwagent the access it needs (without loosening permissions on `/home/ubuntu` for other users). If you skipped the setup script or it ran before this fix landed, apply manually:

```bash
sudo setfacl -m u:cwagent:rx /home/ubuntu
sudo setfacl -m u:cwagent:rx /home/ubuntu/ea-sys
sudo setfacl -m u:cwagent:rx /home/ubuntu/ea-sys/logs
sudo find /home/ubuntu/ea-sys/logs -type f -name "*.log" -exec sudo setfacl -m u:cwagent:r {} \;
sudo setfacl -d -m u:cwagent:r /home/ubuntu/ea-sys/logs
sudo systemctl restart amazon-cloudwatch-agent

# Verify:
sudo -u cwagent test -r /home/ubuntu/ea-sys/logs/app.log && echo "OK" || echo "STILL BROKEN"
```

The default ACL (`-d`) on the logs dir is critical — without it, new log files created after Pino rotation lose the cwagent access and the agent silently stops shipping new data.

**Logs flowing but not seeing what you expect:**
- The Pino JSON is shipped as-is. Each line is one log event. The `level` field tells you severity (30=info, 40=warn, 50=error, 60=fatal).
- CloudWatch Insights queries: use `fields @timestamp, level, msg, module` + `filter level >= 50` to see all errors.

**Want to stop the agent without uninstalling:**
```bash
sudo systemctl stop amazon-cloudwatch-agent
sudo systemctl disable amazon-cloudwatch-agent
```
Re-enable: `sudo systemctl enable --now amazon-cloudwatch-agent`.

---

## 5. Relation to other observability layers

| Layer | What it captures | Latency | Persistence |
|---|---|---|---|
| **Pino → stdout** | Every log line | Instant | Lost on container restart |
| **`./logs/app.log` file** | Same | Instant | Host disk, rotated by Pino |
| **SystemLog Postgres table** | Same, batched | ~2-5s | DB, included in DR backups |
| **`/logs` dashboard** | Reads SystemLog | Instant | N/A (UI) |
| **Sentry** | Errors only | ~30s | Sentry cloud (US-east) |
| **SES admin-alert email** | Errors only, dedup'd 1/hr per message | ~10s | Inbox |
| **CloudWatch Logs** | Everything | ~30s | AWS, cross-region durable |
| **CloudWatch alarm → SNS** | Error rate spikes | ~1-2min | Email |

CloudWatch Logs is the only path that combines **everything captured** + **AWS-native durability** + **alarms on aggregate rates**. The other paths are individually useful but have specific gaps that CloudWatch fills.

---

*Last updated: June 8, 2026. Setup script: `infra/cloudwatch/setup.sh`. Agent config: `infra/cloudwatch/amazon-cloudwatch-agent.json`.*
