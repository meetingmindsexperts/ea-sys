# AWS Operations — EA-SYS runbook

Single reference for the AWS CLI commands used to run EA-SYS day to day **and**
to recover from disasters. Aggregates what was previously scattered across
`infra/dr/README.md`, `infra/cloudwatch/README.md`, and `docs/runbook-ses.md`.
Those remain the authoritative *deep* runbooks for their areas — this doc is the
one-page index plus the commands you reach for most.

> **Every command needs `--region`.** EA-SYS infra spans two regions; the CLI
> defaults to whatever is in your `~/.aws/config`, which is rarely the one you
> want. When in doubt, pass it explicitly.

---

## 0. Inventory — what's where

| Thing | Value | Region |
|---|---|---|
| **Primary EC2** (web + worker) | `i-0b51ab1213d084640` | `ap-south-1` (Mumbai) |
| Primary public IP (Elastic IP) | `3.108.247.193` | ap-south-1 |
| Primary security group | `sg-01da66338a3c4ce46` | ap-south-1 |
| Primary instance role | `ea-sys-mumbai-ec2-role` | — |
| **DR EC2** (break-glass, normally **destroyed**) | `i-075c400567ed002e6` | `ap-southeast-1` (Singapore) — terraform-managed |
| **DR S3 bucket** | `s3://ea-sys-dr-singapore/` (`uploads/`, `env/`, `db/`) | ap-southeast-1 |
| DR KMS key | customer-managed (see `infra/dr/terraform.tfvars`) | ap-southeast-1 |
| **CloudWatch log groups** | `ea-sys/app` (30-day), `ea-sys/error` (90-day) | ap-south-1 |
| **SES** | sender `meetingmindsexperts.com`; alerts → `krishna@meetingmindsdubai.com` | ap-south-1 |
| App checkout on box | `/home/ubuntu/ea-sys` (user `ubuntu`) | — |
| Containers | `ea-sys-blue` / `ea-sys-green` (web, blue-green), `ea-sys-worker`, `ea-sys-mediamtx` | — |
| Health endpoints | `https://events.meetingmindsgroup.com/api/health`, `/worker/health` | — |

**Prereqs:** `aws --version` (v2), the Session Manager plugin for `aws ssm
start-session`, and `aws sts get-caller-identity` returning your identity. The
box itself uses its **instance role** — no AWS keys live in `.env`.

---

## 1. Daily operations

### 1.1 Get onto the box — SSM, not SSH

Port 22 is brute-forced and fail2ban-guarded; **SSM is the reliable path** (no
open port, IAM-scoped, CloudTrail-audited).

```bash
# Interactive shell (lands as ssm-user / root):
aws ssm start-session --target i-0b51ab1213d084640 --region ap-south-1

# Most app commands run as the repo owner — switch after connecting:
sudo -iu ubuntu
```

**Run a command without an interactive session** (scriptable; what to use for
quick checks). SSM runs as **root**, so run git/app commands via `sudo -u ubuntu`
or git trips its "dubious ownership" guard:

```bash
CMD_ID=$(aws ssm send-command --region ap-south-1 \
  --instance-ids i-0b51ab1213d084640 \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["sudo -u ubuntu git -C /home/ubuntu/ea-sys log --oneline -1","docker ps --format \"{{.Names}}: {{.Status}}\" | grep ea-sys"]' \
  --query 'Command.CommandId' --output text)
sleep 8
aws ssm get-command-invocation --region ap-south-1 \
  --command-id "$CMD_ID" --instance-id i-0b51ab1213d084640 \
  --query 'StandardOutputContent' --output text
```

### 1.2 Is the box healthy?

```bash
# Instance + status checks
aws ec2 describe-instance-status --instance-ids i-0b51ab1213d084640 \
  --region ap-south-1 --include-all-instances \
  --query 'InstanceStatuses[0].{State:InstanceState.Name,Sys:SystemStatus.Status,Inst:InstanceStatus.Status}' \
  --output table

# Public IP + Elastic-IP association (confirm the EIP is still attached)
aws ec2 describe-instances --instance-ids i-0b51ab1213d084640 --region ap-south-1 \
  --query 'Reservations[0].Instances[0].{PublicIp:PublicIpAddress,SG:SecurityGroups[*].GroupId}' --output json
aws ec2 describe-addresses --region ap-south-1 \
  --filters "Name=instance-id,Values=i-0b51ab1213d084640" \
  --query 'Addresses[*].{EIP:PublicIp,AssocId:AssociationId}' --output json

# App health from anywhere
curl -I https://events.meetingmindsgroup.com/api/health     # expect 200, database: connected
curl -I https://events.meetingmindsgroup.com/worker/health  # worker tier
```

### 1.3 Logs

Four parallel log paths exist (Sentry, SES error-alerts, the `/logs` Postgres
dashboard, and CloudWatch). For AWS-side querying:

```bash
# Live tail of the app log group
aws logs tail ea-sys/app --follow --region ap-south-1

# Errors only, last 50 (CloudWatch Logs Insights — run in console or start-query):
#   fields @timestamp, level, module, msg | filter level >= 50 | sort @timestamp desc | limit 50
# Error count by source module:
#   fields module | filter level >= 50 | stats count() by module | sort count desc
# Slowest cron ticks:
#   fields @timestamp, msg, durationMs | filter msg like /cron:tick/ and durationMs > 100 | sort durationMs desc
# Email failures by AWS error code:
#   fields awsErrorName, to.0, subject | filter awsErrorName != "" | stats count() by awsErrorName
```

On the box (emergency / when CloudWatch lag matters): `tail -f
/home/ubuntu/ea-sys/logs/{app,error}.log`, or `docker logs ea-sys-blue`. In the
dashboard: `/logs` (source = database) and the `/admin/docs` viewer.

> CloudWatch agent issues → `infra/cloudwatch/README.md` §4. Quick check on the
> box: `sudo systemctl status amazon-cloudwatch-agent`.

### 1.4 Email (SES)

```bash
# From the box, prove the instance role can call SES at all:
sudo -u ubuntu aws sts get-caller-identity --region ap-south-1

# Sender domain still verified?
aws ses get-identity-verification-attributes \
  --identities meetingmindsexperts.com --region ap-south-1   # expect VerificationStatus: Success

# Send quota / rate (are we throttled or in sandbox?)
aws ses get-send-quota --region ap-south-1
```

> Deeper email triage (bounces, DMARC, the single-DMARC-record rule) →
> `docs/runbook-ses.md`.

### 1.5 S3 housekeeping

```bash
# Confirm the DR backups are actually landing (newest last)
aws s3 ls s3://ea-sys-dr-singapore/uploads/ --region ap-southeast-1 --recursive | tail -3
aws s3 ls s3://ea-sys-dr-singapore/env/     --region ap-southeast-1 | sort -k1,2 | tail -3
aws s3 ls s3://ea-sys-dr-singapore/db/      --region ap-southeast-1 --recursive | sort -k1,2 | tail -3
```

### 1.6 Deploy

Deploys are **GitHub Actions → SSH (`appleboy`) → `bash scripts/deploy.sh`**
(blue-green). You don't run them by hand. Two things to know:

- The SSH step occasionally fails with `dial tcp :22: i/o timeout` — that's
  **fail2ban transiently banning the GitHub runner IP**, not a config break.
  Just re-run: `gh run rerun <id> --failed` (or push again). Because
  `deploy.sh` does `git reset --hard origin/main`, one good run ships
  everything on `main`.
- If you ever must deploy out-of-band (CI down), do it via SSM:
  ```bash
  aws ssm send-command --region ap-south-1 --instance-ids i-0b51ab1213d084640 \
    --document-name AWS-RunShellScript \
    --parameters 'commands=["sudo -u ubuntu bash -lc \"cd /home/ubuntu/ea-sys && git fetch origin main && git reset --hard origin/main && bash scripts/deploy.sh\""]'
  ```
- **`.env` edits**: edit on the box (`sudo -iu ubuntu vim /home/ubuntu/ea-sys/.env`)
  then **re-run `scripts/deploy.sh`** — `docker compose` only re-reads `env_file`
  on container create, NOT on restart. After adding a secret, snapshot it to DR
  immediately (see §2.2).

---

## 2. Disaster recovery

Scope of the blast radius decides the path. The full, scenario-by-scenario
runbook is **`infra/dr/README.md`** — the commands below are the ones you'll
actually type, inlined so this page is self-sufficient for the common cases.

### 2.1 Lost the uploads directory (Mumbai still up)

Mirror back from S3, newest-wins. `--dryrun` first.

```bash
# On the Mumbai box (SSM, then):
sudo -u ubuntu aws s3 sync s3://ea-sys-dr-singapore/uploads/ \
  /home/ubuntu/ea-sys/public/uploads/ --region ap-southeast-1 \
  --exclude "*/.gitkeep" --dryrun        # drop --dryrun when the plan looks right
```
RPO: up to 60 min (one cron tick).

### 2.2 Lost or corrupted `.env`

```bash
LATEST=$(sudo -u ubuntu aws s3 ls s3://ea-sys-dr-singapore/env/ \
  --region ap-southeast-1 | sort -k1,2 | tail -1 | awk '{print $4}')
sudo -u ubuntu aws s3 cp "s3://ea-sys-dr-singapore/env/$LATEST" \
  /home/ubuntu/ea-sys/.env --region ap-southeast-1
sudo -u ubuntu bash /home/ubuntu/ea-sys/scripts/deploy.sh   # re-read env_file

# Tighten RPO ad-hoc after rotating a secret:
sudo -u ubuntu aws s3 cp /home/ubuntu/ea-sys/.env \
  "s3://ea-sys-dr-singapore/env/$(date -u +%F).env" --region ap-southeast-1
```
RPO: up to 24h.

### 2.3 One file back / a prior version

```bash
# Pull one object (paths: uploads/certificates/{eventId}/{uuid}.pdf,
# uploads/agreements/{eventId}/{uuid}.docx, uploads/photos/{YYYY}/{MM}/{uuid}.jpg, ...)
sudo -u ubuntu aws s3 cp s3://ea-sys-dr-singapore/uploads/<path> \
  /home/ubuntu/ea-sys/public/uploads/<path> --region ap-southeast-1

# Versioning is on — restore yesterday's version of an overwritten object:
sudo -u ubuntu aws s3api list-object-versions --bucket ea-sys-dr-singapore \
  --prefix uploads/<path> --region ap-southeast-1 \
  --query 'Versions[].[VersionId,LastModified,Size]' --output table
sudo -u ubuntu aws s3api copy-object --bucket ea-sys-dr-singapore \
  --copy-source 'ea-sys-dr-singapore/uploads/<path>?versionId=<OLD-VID>' \
  --key uploads/<path> --region ap-southeast-1
```

### 2.4 Database restore from `pg_dump`

Daily dumps land at `s3://ea-sys-dr-singapore/db/{YYYY}/{MM}/{DD-HH}-mumbai.dump`
(`pg_dump -Fc --schema=public`, portable to any vanilla PG 17). RPO ≤ 24h.

```bash
# Newest dump → scratch:
LATEST=$(aws s3 ls s3://ea-sys-dr-singapore/db/ --recursive --region ap-southeast-1 \
  | sort -k1,2 | tail -1 | awk '{print $4}')
aws s3 cp "s3://ea-sys-dr-singapore/${LATEST}" /tmp/restore.dump --region ap-southeast-1

# Full rebuild into a NEW Supabase project (or any PG 17+):
pg_restore --no-owner --no-acl --jobs=4 -d "postgresql://postgres:PASS@NEW-HOST:5432/postgres" /tmp/restore.dump
# Then update DATABASE_URL + DIRECT_URL in .env and redeploy (§2.2).

# Surgical — one table only:
pg_restore --no-owner --no-acl -t "Registration" -d "$PG_DSN" /tmp/restore.dump
```
Full surgical-row recovery (scratch Docker PG + SELECT) and the restore drill →
`infra/dr/README.md` §E and `scripts/dr-restore-drill.sh`.

### 2.5 Full regional failover — Mumbai is DOWN

Confirm it's really down (AWS Health Dashboard for `ap-south-1`; SSM to the
Mumbai instance times out). Then provision the Singapore break-glass box:

```bash
cd infra/dr
terraform apply -auto-approve          # ~7 min
terraform output public_ip             # new IP for DNS

# Registrar → events A record → new IP (lower TTL to 60s before risky changes).

curl -I https://events.meetingmindsgroup.com/api/health   # expect 200, database: connected

# Tail the boot log if it's not serving:
aws ssm start-session --target $(terraform output -raw instance_id) --region ap-southeast-1
sudo tail -f /var/log/ea-sys-bootstrap.log                # expect [bootstrap] complete
```

**Returning to Mumbai** (after region recovers): sync DR-box uploads back to S3
**before** flipping DNS or destroying, then `terraform destroy -auto-approve`.
Full promotion + return runbook → `infra/dr/README.md` §"Promotion runbook" and
§"Post-incident".

---

## 3. One-time / occasional infra

These are setup operations you rarely run — full context in the linked docs.

```bash
# Attach the CloudWatch agent policy to the instance role (logs setup):
aws iam attach-role-policy --role-name ea-sys-mumbai-ec2-role \
  --policy-arn arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy
aws iam list-attached-role-policies --role-name ea-sys-mumbai-ec2-role   # verify
```

| Task | Authoritative doc |
|---|---|
| CloudWatch agent install / metric-filter alarm / SNS email | `infra/cloudwatch/README.md` |
| DR bucket + KMS + backup crons + IAM policy | `infra/dr/README.md` §"One-time setup" |
| Postgres backup cron + restore drill | `infra/dr/POSTGRES_BACKUP_PLAN.md` |
| SES sender, DMARC, bounce triage | `docs/runbook-ses.md` |
| EC2 hardening (fail2ban, ufw, SSM) | `docs/EC2_HARDENING.html` |
| Mumbai box from scratch | `docs/MUMBAI_SETUP.md` |

---

## 4. Gotchas worth memorising

- **Always `--region`.** Mumbai = `ap-south-1`, Singapore/DR = `ap-southeast-1`,
  and SES + CloudWatch are in `ap-south-1`.
- **SSM runs as root** → prefix app/git commands with `sudo -u ubuntu`.
- **`deploy.sh` after `.env` edits** — restart alone won't re-read `env_file`.
- **`dial tcp :22 i/o timeout`** on a deploy = fail2ban banned the GitHub
  runner IP; transient, just re-run.
- **Don't manually run raw `docker compose` in `/home/ubuntu/ea-sys`** — it can
  break the blue-green state. Use `scripts/deploy.sh`.
- **Untested backups aren't backups** — the quarterly restore drill
  (`scripts/dr-restore-drill.sh`, 15 Jul/Oct/Jan/Apr) exists for a reason.

---

*This doc is browsable in-dashboard at `/admin/docs`. Last aggregated: June 10, 2026.*
