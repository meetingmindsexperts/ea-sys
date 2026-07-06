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
| Health endpoints | `https://events.meetingmindsgroup.com/health` (alias of `/api/health`), `/worker/health` | — |
| **Uptime monitor (external)** | Uptime Robot → `https://events.meetingmindsgroup.com/health` | external |
| **Route 53 health check** | `ea-sys-health` (`20c6ff28-1c3d-456c-8bc2-84f88b39e325`) → HTTPS `/health`, 30s, fail×3 | global (metrics in `us-east-1`) |
| **CloudWatch alarms** | `ea-sys-health-down` (Route53 /health) · `ea-sys-ec2-status-check-failed` (hypervisor hard-down) — both → SNS `ea-sys-alerts` | `us-east-1` · `ap-south-1` |
| **SNS alert topics** | `ea-sys-alerts` (one per region — SNS is regional) → `krishna@` + `vivek@meetingmindsdubai.com` | `us-east-1` + `ap-south-1` |

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
(blue-green). You don't run them by hand.

> **ECR deploy is live (2026-07-01, Step 2 shipped `e118830`).** A `build-push` CI
> job builds the web + worker images and pushes them to **ECR** (`…/ea-sys`, see
> §5.x); the deploy job then **pulls** those exact images on the box
> (`docker compose pull`, keyed on `IMAGE_TAG=<git-sha>`) instead of building
> on-box — SSH deploy ~8 min → ~1–2 min, and the box never runs a memory-heavy
> build (the INC-001 fix). Migrations run **from the pulled worker image** (it
> ships the Prisma CLI) so DB creds stay in `.env`, never CI. **Fallbacks:** a
> failed ECR pull → on-box build; a failed migration → deploy aborts before the
> nginx swap (old slot keeps serving). Rollback = redeploy a previous `:<sha>`.

Two things to know:

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

### 1.7 Monitoring & alerting — how you find out something broke

Two layers, because they cover different failure modes:

**A. App-driven (fast, for anything the app can emit)** — errors surface in
**seconds to ~1 min** via four parallel paths: **Sentry**, an **SES email on
every `error`-level log**, **CloudWatch Logs** (`ea-sys/error`), and the
in-dashboard **`/logs`** viewer (Postgres `SystemLog`, batched ~2s). See §1.3
for the Insights queries. *Limitation:* if the box is fully **down**, the app
can't email you — hence layer B.

**B. Outage detection (external / infra — catches a hard down)** — LIVE:

| Signal | What it watches | Fires within |
|---|---|---|
| **Uptime Robot** (external) | HTTPS `GET /health` from outside AWS | ~1–2 min |
| **Route 53 health check** `ea-sys-health` → alarm **`ea-sys-health-down`** (`us-east-1`) → SNS **`ea-sys-alerts`** | HTTPS `/health` from ~15 global checkers, 30s, fail×3 | ~1.5 min |
| **EC2 alarm `ea-sys-ec2-status-check-failed`** (`ap-south-1`) → SNS **`ea-sys-alerts`** (`ap-south-1`) | `StatusCheckFailed` — hypervisor hard-down (reboot loop, kernel panic, net-dead) where `/health` may hang | ~2 min |

> **Region gotchas:** (1) Route 53 health-check metrics exist **only in
> `us-east-1`**, so `ea-sys-health-down` **and** its SNS topic live there — look
> under CloudWatch **N. Virginia**, not Mumbai. (2) **SNS is regional**, so there
> are **two** same-named `ea-sys-alerts` topics (us-east-1 for the health alarm,
> ap-south-1 for the EC2 alarm); a recipient must confirm **once per topic**.
> Recipients: `krishna@` + `vivek@meetingmindsdubai.com`. A dormant
> `ea-sys-alerts-prod` topic also exists in ap-south-1 (no alarms use it — leftover).

Verify / test:
```bash
# Health check status (all checkers should be Success)
aws route53 get-health-check-status --health-check-id 20c6ff28-1c3d-456c-8bc2-84f88b39e325 \
  --query 'HealthCheckObservations[].StatusReport.Status' --output text
# Alarm state (us-east-1!) + subscription confirmed?
aws cloudwatch describe-alarms --region us-east-1 --alarm-names ea-sys-health-down \
  --query 'MetricAlarms[].StateValue' --output text
aws sns list-subscriptions --region us-east-1 \
  --query "Subscriptions[?contains(TopicArn,'ea-sys')].{Endpoint:Endpoint,Sub:SubscriptionArn}" --output json
# Fire drill: point the check at a bad path, watch it alarm, then set it back
aws route53 update-health-check --health-check-id 20c6ff28-1c3d-456c-8bc2-84f88b39e325 --resource-path /nope
# …wait ~2 min for the email, then:
aws route53 update-health-check --health-check-id 20c6ff28-1c3d-456c-8bc2-84f88b39e325 --resource-path /health
```

**Not yet wired (the remaining silent-failure modes):**
- **DB-backup freshness** — no alarm if `dr-pg-dump.sh` silently stops (the
  script SES-alerts on *failure*, but a down box means the cron never runs).
  Fix = emit a heartbeat metric on success (`aws cloudwatch put-metric-data
  --namespace EA-SYS/DR --metric-name DbBackupSuccess --value 1`) at the end of
  `dr-pg-dump.sh`, plus an `ap-south-1` alarm (`--period 10800 --threshold 1
  --comparison-operator LessThanThreshold --treat-missing-data breaching`) — no
  heartbeat in 3h → page (dumps run every 2h).
- There are **no CloudWatch metric alarms on CPU / memory / disk** — triage those
  reactively via §3.

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

Dumps run on `0 2,4,6,8,10,12,14,16,18,22 * * *` UTC (= **≤2h RPO during Dubai
daytime 08:00–22:00 GST, ≤4h overnight**) and land at
`s3://ea-sys-dr-singapore/db/{YYYY}/{MM}/{DD-HH}-mumbai.dump`
(`pg_dump -Fc --schema=public`, portable to any vanilla PG 17).

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

## 3. Troubleshooting — CPU / memory / disk spikes

> **The t3.large is burstable.** Its CPU baseline is ~30% per vCPU; bursting
> above that spends **CPU credits**. If credits hit zero, the box is throttled
> *to baseline* — the app goes slow while `CPUUtilization` sits *pinned at ~30%,
> not 100%*. So a "spike" can present as **sustained mediocrity, not a peak**.
> Always check `CPUCreditBalance` alongside `CPUUtilization`.

### 3.1 First look — CloudWatch (no box access needed)

`CPUUtilization` is a default EC2 metric; memory/disk are not (they'd need the
agent's metrics config, which today ships logs only — use the box for those).

```bash
# CPU over the last 3h (macOS date syntax; on Linux use -d '3 hours ago')
aws cloudwatch get-metric-statistics --region ap-south-1 \
  --namespace AWS/EC2 --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value=i-0b51ab1213d084640 \
  --start-time $(date -u -v-3H +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 300 --statistics Average Maximum --output table

# CPU credit balance — the burst gotcha. If this trends toward 0, you're throttled.
aws cloudwatch get-metric-statistics --region ap-south-1 \
  --namespace AWS/EC2 --metric-name CPUCreditBalance \
  --dimensions Name=InstanceId,Value=i-0b51ab1213d084640 \
  --start-time $(date -u -v-6H +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 300 --statistics Minimum Average --output table
```

### 3.2 On the box — find the hot process/container

One SSM call that dumps the whole picture (CPU, memory, disk, per-container,
OOM history):

```bash
CMD_ID=$(aws ssm send-command --region ap-south-1 \
  --instance-ids i-0b51ab1213d084640 \
  --document-name AWS-RunShellScript \
  --parameters 'commands=[
    "echo === LOAD ===","uptime",
    "echo === MEM ===","free -h",
    "echo === DISK ===","df -h / && docker system df",
    "echo === TOP ===","top -bn1 | head -15",
    "echo === CONTAINERS ===","docker stats --no-stream --format \"table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\"",
    "echo === OOM ===","(sudo dmesg -T 2>/dev/null | grep -iE \"out of memory|killed process\" | tail -5) || echo none",
    "echo === UPLOADS/LOGS SIZE ===","sudo du -sh /home/ubuntu/ea-sys/logs /home/ubuntu/ea-sys/public/uploads 2>/dev/null"
  ]' --query 'Command.CommandId' --output text)
sleep 10
aws ssm get-command-invocation --region ap-south-1 \
  --command-id "$CMD_ID" --instance-id i-0b51ab1213d084640 \
  --query 'StandardOutputContent' --output text
```

`docker stats` tells you **which container** — that's the fork in the road:

| Hot container | Likely cause | Where to look |
|---|---|---|
| `ea-sys-mediamtx` | A **live stream is running** — RTMP→HLS remux is CPU-heavy. Expected during events. | Any session with `liveStreamEnabled`. Ends when the stream stops. |
| `ea-sys-worker` | A cron job is doing real work — **cert PDF rendering** (pdfkit), **bulk email**, or **webinar sync**. Bursty by design. | `/logs` → search `worker:` ; `docker logs ea-sys-worker`. |
| `ea-sys-blue`/`green` (web) | Traffic spike, a heavy report/PDF endpoint, or an N+1 query under load. | `/logs` for slow requests; CloudWatch Insights `durationMs` query. |
| *None pinned, but app slow* | **CPU-credit throttling** (§3.1) or **DB connection exhaustion** (§3.4) — the box isn't busy, it's *waiting*. | `CPUCreditBalance`; Postgres/pooler. |
| `top` shows `sshd`/unknown | **SSH brute-force** churn (fail2ban is mitigating). Rarely the real cause but visible. | Normal background noise; see `docs/EC2_HARDENING.html`. |

### 3.3 Memory / OOM

`free -h` low + a container with **recent uptime** in `docker ps` (it restarted)
+ an OOM line in `dmesg` = the kernel OOM-killed a container and Docker
restarted it. The worker (pdfkit rendering large cert batches) and the web tier
under a heavy export are the usual suspects.

```bash
# Confirm a container restarted recently (short "Up" time):
# docker ps --format "{{.Names}}: {{.Status}}"   (via the §3.2 bundle)
# Tail what it was doing just before:
#   docker logs --tail 200 ea-sys-worker
```
Mitigations: lower batch sizes for the offending job, or **resize the box**
(§3.5). The cert worker already drains 50 renders/tick — a smaller tick helps if
rendering is the OOM trigger.

**Add swap (the missing cushion — see INC-001).** The box ships with **no swap**,
so a transient memory spike (e.g. an on-box `docker compose build`) has zero
buffer and freezes the whole OS instead of slowing down. A 4 GB swap file fixes
that. Run on the box (SSM / Session Manager — no deploy, OS-only, idempotent):

```bash
# Skip if already present:  swapon --show   (empty = no swap)
sudo fallocate -l 4G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=4096
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
# Persist across reboots (only add the line once):
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
# Prefer RAM; only swap under real pressure:
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf
sudo sysctl vm.swappiness=10
# Verify:
swapon --show && free -h
```
Disk check first: `df -h /` — a 4 GB file needs 4 GB free (the box had ~12 GB
free). This is a stopgap; the real fix is to **build the image in CI/ECR** so the
prod host never runs a heavy build (see INC-001 action items).

### 3.4 App hangs / `P2024` / `worker:tick-wrapper-uncaught` (DB connection exhaustion)

A "spike" that's really **the box waiting on Postgres**. Symptom: slow/hung
requests, worker pages with `P2024` *"Timed out fetching a new connection from
the connection pool"*. Root cause is usually several jobs ticking at the top of
the minute on a shared Prisma pool. Levers (set in `DATABASE_URL`, shared by web
+ worker): **`connection_limit`** (concurrency headroom — the primary fix, but
bounded by what pgbouncer/Postgres can serve) and **`pool_timeout`** (patience
before P2024 — keep modest so the web side fails fast). Current values are
`connection_limit=10&pool_timeout=15`. Full incident write-up + reasoning is in
CLAUDE.md ("Worker connection-pool fix", June 10 2026). Distinguish from a
Supabase-side outage: if `CPUUtilization` is low and `/logs` shows DB connection
errors across *all* tiers, suspect the pooler/Supabase, not the box.

### 3.5 When it's just under-provisioned — resize the box

If the spikes are real load (not a bug) and credits are chronically drained,
move off burstable or size up. Brief downtime; the **Elastic IP stays attached**.

```bash
aws ec2 stop-instances  --instance-ids i-0b51ab1213d084640 --region ap-south-1
aws ec2 wait instance-stopped --instance-ids i-0b51ab1213d084640 --region ap-south-1
aws ec2 modify-instance-attribute --instance-id i-0b51ab1213d084640 \
  --instance-type '{"Value":"t3.xlarge"}' --region ap-south-1     # or c7a.large (non-burstable) for steady CPU
aws ec2 start-instances --instance-ids i-0b51ab1213d084640 --region ap-south-1
# Docker containers restart on boot via the compose restart policy; verify:
curl -I https://events.meetingmindsgroup.com/api/health
```
> For predictable CPU-heavy load (lots of live streaming / cert rendering),
> prefer a **non-burstable** type (`c7a.large` / `c6a.large`) over a bigger T —
> no credits to exhaust. Match the DR box's `instance_type` in
> `infra/dr/variables.tf` if you change it.

### 3.6 Quick relief without a resize

```bash
# Restart just the worker (safe — Postgres advisory locks prevent double-runs):
aws ssm send-command --region ap-south-1 --instance-ids i-0b51ab1213d084640 \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["docker restart ea-sys-worker"]'
# Disk full from logs? They ship to CloudWatch + Postgres anyway:
#   sudo truncate -s 0 /home/ubuntu/ea-sys/logs/app.log   (don't rm — the file is bind-mounted)
# Reclaim Docker space (old images/build cache from past deploys):
#   docker image prune -f && docker builder prune -f
```

### 3.7 Processes & threads — going deeper

When "which container" (§3.2) isn't enough and you need to know **which
process/thread inside it** is hot or stuck.

**Mental model for EA-SYS:** the web + worker containers each run **one Node
process** (`next start` / `npx tsx worker/index.ts`). Node is a **single main
thread** (the event loop) plus a small **libuv thread pool** (default 4 threads,
`UV_THREADPOOL_SIZE`) used for `fs`, `crypto`, DNS, and zlib. So:
- **One thread pinned at ~100% + the app unresponsive** = something is **blocking
  the event loop** synchronously (a big PDF render with pdfkit, a huge JSON
  parse/stringify, sync crypto). This is the common Node failure mode.
- **All ~4 pool threads busy** = the libuv pool is saturated (lots of concurrent
  `fs`/`crypto` — e.g. a cert batch). Raising `UV_THREADPOOL_SIZE` can help, but
  fixing the workload (smaller batches) is usually right.

**See processes inside a container without installing anything** — `docker top`
runs on the host, so it works even though the `node:slim` images have no `ps`:

```bash
# Via SSM. Maps container processes to HOST PIDs (the namespaced PID differs).
docker top ea-sys-worker -eLf        # -L = one row per THREAD; -e = env-less full listing
# Per-thread CPU on the host for that Node PID (H = threads):
top -H -p "$(docker inspect -f '{{.State.Pid}}' ea-sys-worker)" -bn1 | head -25
```

**What is a process/thread actually doing / blocked on** (use the **host PID**
from `docker inspect` above; `/proc` needs no extra tooling):

```bash
PID=$(docker inspect -f '{{.State.Pid}}' ea-sys-worker)
cat /proc/$PID/status | grep -E 'State|Threads|VmRSS'   # State: R(run) S(sleep) D(uninterruptible I/O) Z(zombie); thread count; RSS
sudo cat /proc/$PID/stack                                # kernel stack — where it's parked (often a futex/io wait)
ls /proc/$PID/fd | wc -l                                 # open file descriptors (sockets+files)
# Heavier tools (install on demand — not on the box by default):
sudo apt-get install -y strace lsof sysstat
sudo strace -p $PID -f -e trace=network,desc -tt        # live syscalls (Ctrl-C to stop) — what it's syscalling on
sudo lsof -p $PID | grep -E 'TCP|ESTAB' | head           # open sockets — stuck DB/HTTP connections
pidstat -t -p $PID 1 5                                   # per-thread CPU sampled over 5s
```

**Reading the signals:**

| Symptom | Means | Likely EA-SYS cause |
|---|---|---|
| `State: D` (uninterruptible sleep), high **load avg** but low **%CPU** | Blocked on I/O — *load counts D-state*, so load can be 4 while CPU is 10%. | Postgres/pooler wait (see §3.4), or disk I/O. |
| One thread `R` at 100%, event loop unresponsive | **Sync work blocking the event loop**. | Big pdfkit render, large JSON, sync crypto on the main thread. |
| `Threads:` climbing, never settling | Thread/leak or pool churn. | Rare — investigate the libuv pool / a native addon. |
| `ls /proc/$PID/fd` near the `ulimit -n` ceiling; `EMFILE` in logs | **File-descriptor / socket exhaustion** — leaked DB/HTTP connections or open file handles. | Unclosed streams, a connection leak (cross-check §3.4 pool). `ulimit -n` shows the cap. |
| `State: Z` (defunct) under `docker top` | **Zombie** — a child exited, parent didn't reap. | Usually harmless unless they pile up; means a spawned subprocess isn't being waited on. |
| `strace` shows it spinning on `epoll_wait`/`futex` doing nothing | Idle/waiting (fine) — not your culprit. | — |

**Node-specific deep dive (CPU/heap profile of the live process):** the app
already streams structured timings to `/logs` (`worker:tick-start`/`-end`
durations, request `durationMs`) — check those first; they usually pinpoint the
slow path without touching the process. If you need a real profile, the
container would need `--inspect` enabled (not on in prod) — prefer reproducing
locally with `node --prof` / `--cpu-prof` against the same code, or add a
temporary timing log around the suspect path and redeploy. Don't attach a
debugger to the live prod Node process.

> **Tool availability:** `ps`, `top`, `/proc` are always there on the host;
> `htop`, `strace`, `lsof`, `pidstat` (sysstat) are **not installed by default**
> — `sudo apt-get install -y htop strace lsof sysstat` first, or stick to
> `docker top` + `/proc` which need nothing. Inside `node:slim` containers there
> are almost no tools, so inspect from the **host** (via `docker inspect` PID),
> not `docker exec`.

### 3.8 Docker disk usage — build cache + the weekly auto-prune

**What "Docker disk" is, in plain terms.** When you build a container image,
Docker saves every build step as a **build cache** so the next build is faster,
and it keeps old **image layers** even after a new build replaces them. The prod
box rebuilds the app image on **every deploy** (`docker compose build` in
[scripts/deploy.sh](../scripts/deploy.sh)), so both pile up over time. This space
is **invisible to a normal `df`** — `df` just shows "disk getting full" with no
obvious culprit — but `docker system df` breaks it out:

```bash
sudo docker system df
# TYPE          TOTAL  ACTIVE  SIZE      RECLAIMABLE
# Images        7      4       23.6GB    19.9GB (84%)   ← old layers from past builds
# Build Cache   154    0       20.6GB    18.2GB         ← rebuildable scratch
# Local Volumes 1      0        1.1GB
```

On 2026-06-30 this was **~38 GB reclaimable at 74% disk** — none of it live data,
all rebuildable scratch. Left unchecked it eventually fills `/`, and then a
deploy's image build can fail or freeze the box (the disk cousin of INC-001).

**Manual reclaim (safe — keeps running + rollback images):**
```bash
docker builder prune -af   # build cache — usually the biggest win
docker image prune -f      # dangling/untagged layers ONLY (no -a → tagged rollback images stay)
```
**Do NOT** use `docker system prune -a` (deletes the last-3 **rollback image
tags**) or `--volumes` (the local volume / uploads bind-mount).

**Weekly auto-prune (the standing fix).** [scripts/docker-prune.sh](../scripts/docker-prune.sh)
runs exactly those two safe prunes and logs how much it reclaimed. Install it on
the box crontab (ubuntu user), Fridays 03:00 UTC = 07:00 GST, low traffic:
```cron
0 3 * * 5 /home/ubuntu/ea-sys/scripts/docker-prune.sh >> /home/ubuntu/cron-docker-prune.log 2>&1
```
Check it ran: `tail /home/ubuntu/cron-docker-prune.log` → look for
`docker-prune:done … reclaimed_gb=…`.

**Durable fix (DONE 2026-07-01):** the box no longer builds — CI builds + pushes to
**ECR** and the box only `docker compose pull`s (§5.x; the "CI → ECR" item in
[docs/ROADMAP.md](ROADMAP.md), and INC-001 in [docs/INCIDENTS.md](INCIDENTS.md)).
No build cache accumulates from deploys anymore, so the weekly prune is now
belt-and-braces (it still reaps the pulled-image churn / dangling layers).

---

## 4. Security — DDoS / bot posture

**Verified state (June 2026).** EA-SYS runs on a single directly-exposed EC2.
There is **no CDN, no AWS WAF, and no host WAF**. Defense is entirely
origin-side:

| Layer | What's there | Notes |
|---|---|---|
| **L3/L4 volumetric** | AWS **Shield Standard** only (free, automatic) | A single EC2 cannot absorb a real volumetric flood — this is the known gap (no CDN by decision). |
| **AWS WAF** | **None** — verified empty across WAFv2 Regional (ap-south-1, ap-southeast-1), WAFv2 CloudFront, and WAF Classic. No ALB/CloudFront for one to attach to anyway. | AWS WAF can't bind to a bare EC2. |
| **Host WAF (ModSecurity)** | **None** — nginx not built with it, no modsec config. | — |
| **nginx rate limiting** | **LIVE** — `limit_req` + `limit_conn` keyed on `$binary_remote_addr` (the real client IP, since no proxy is in front). | See §4.1. |
| **In-app rate limiting** | `checkRateLimit` across ~80 buckets keyed by **IP / userId / org / API-key / OAuth-token**. | In-memory + per-container → resets on deploy, not shared across blue/green. Best-effort. |
| **fail2ban** | **`sshd`** jail (SSH brute-force) **+ `nginx-rate-limit`** jail — bans IPs that repeatedly trip the nginx 429 limit. | `fail2ban-client status`; config + runbook in `infra/fail2ban/` |
| **ufw + Security Group** | Both **active but open** on 22/80/443 to `0.0.0.0/0`. 22 stays open (GitHub Actions deploy needs it; fail2ban + SG guard it). | — |
| **Payments** | Stripe **Radar** (fraud/card-testing) — confirm it's enabled in the Stripe dashboard. | — |

Verify any of these yourself: AWS WAF → `aws wafv2 list-web-acls --scope REGIONAL --region ap-south-1`; host → the §3.2 SSM bundle plus `fail2ban-client status` / `ufw status verbose` / `nginx -V 2>&1 | grep -i modsec`.

### 4.1 nginx per-IP rate limiting (live config)

Lives in the box's `/etc/nginx/sites-available/ea-sys` (a stripped,
Certbot-managed file that has **diverged from the committed `deploy/nginx.conf`**
— the box is the source of truth for nginx; the git file is a reference).

- `limit_req_zone … zone=ea_req rate=100r/s` → `limit_req burst=200 nodelay` on
  `location /` (HTML/RSC/API), `burst=50` on `/api/mcp`. Static `/_next/static/`
  and the `/stream/` HLS path are intentionally **un-limited**.
- `limit_conn_zone … zone=ea_conn` → `limit_conn ea_conn 100` (per-IP concurrent).
- Exceeding either returns **429** and logs `limiting requests … zone "ea_req"`
  to `/var/log/nginx/error.log`.
- Keyed on `$binary_remote_addr` — safe today because the origin is directly
  exposed, so that IS the true client IP.

**Shared-NAT caveat (EA-SYS-specific):** event attendees often share one
venue-WiFi IP, so per-IP limits can clip a whole crowd. The thresholds are tuned
to tolerate a normal on-site audience; for a very large single-NAT rush, raise
`limit_conn` / `rate`, `nginx -t`, then `systemctl reload nginx`.

Verify it works (from anywhere — hits only your IP, resets in ~2s):
```bash
for i in $(seq 1 400); do curl -s -o /dev/null -w "%{http_code}\n" \
  https://events.meetingmindsgroup.com/api/health; done | sort | uniq -c
# expect 200s then 429s. On the box: tail -f /var/log/nginx/error.log | grep limiting
```

### 4.2 fail2ban — ban repeat rate-limit offenders

The nginx layer (§4.1) *throttles*; the `nginx-rate-limit` fail2ban jail
*escalates* — an IP that keeps tripping the 429 limit gets dropped at the
firewall (default: 100+ rejected requests in 120s → 30-min ban). **Applied +
verified live** (status shows `File list: /var/log/nginx/error.log`). Config +
installer + full runbook live in [`infra/fail2ban/`](../infra/fail2ban/README.md).

```bash
bash /home/ubuntu/ea-sys/infra/fail2ban/setup.sh   # idempotent install + reload
sudo fail2ban-client status nginx-rate-limit       # armed? currently-banned list
sudo fail2ban-client get nginx-rate-limit logpath  # MUST be /var/log/nginx/error.log
sudo fail2ban-client set nginx-rate-limit unbanip <IP>   # false-positived your office
```

**Backend gotcha (fixed):** Ubuntu's `jail.d/defaults-debian.conf` sets
`backend = systemd` globally; nginx logs to a **file**, so the jail must override
with `backend = auto` or it reads the (empty-for-nginx) journal and never bans —
if `get … logpath` ever says *"No file is currently monitored"*, that's the cause.

Same **shared-NAT caveat** as §4.1: a ban blocks the whole IP, so thresholds are
high to avoid banning a venue-WiFi crowd; whitelist trusted IPs via `ignoreip`
(the operator office egress IP is already in there). The deploy SSH (port 22) is
covered by the separate `sshd` jail, so this can't interfere with GitHub Actions.

### 4.3 Adding a CDN / Cloudflare later (not currently used)

If you ever put Cloudflare (or any proxy/CDN) in front, the origin stops seeing
the real client IP — every request arrives from a **Cloudflare edge IP**, and the
true IP comes in `CF-Connecting-IP`. Without handling that, **all rate limiting
collapses** (everyone buckets as ~a dozen Cloudflare IPs).

**The clean fix needs ZERO app-code changes** — restore the real IP at nginx with
the `real_ip` module (ships with Ubuntu nginx):
```nginx
# Trust CF-Connecting-IP ONLY from Cloudflare's ranges (cloudflare.com/ips)
set_real_ip_from 173.245.48.0/20;   # …all ~15 IPv4 + ~7 IPv6 CIDRs
real_ip_header CF-Connecting-IP;
```
This rewrites `$remote_addr` to the true client IP, so everything downstream just
works: nginx `limit_req`/`limit_conn`, `X-Real-IP`, and `getClientIp()` (which
prefers `X-Real-IP`) all resolve the real client — **no change to `src/lib/security.ts`.**

**Critical ordering (don't break it):**
1. Get Cloudflare proxying (orange cloud); confirm `curl -I` shows a `cf-ray` header.
2. **Then** lock the Security Group: 443/80 inbound → **Cloudflare CIDRs only** (keep 22 for GitHub Actions). Without this lock, an attacker hits the EIP directly with a forged `CF-Connecting-IP` and bypasses everything.
3. **Then** add the nginx `set_real_ip_from` block.

Locking the SG *before* Cloudflare is actually serving = real users locked out (the "522 origin unreachable" trap).

**Change checklist:**

| Area | Change |
|---|---|
| Cloudflare | Add site → change registrar nameservers → **preserve MX + SPF/DKIM/DMARC** (or org email dies) → `events` A record = Proxied → SSL mode **Full (strict)** (keep the origin Let's Encrypt cert) |
| Security Group | 443/80 → Cloudflare CIDRs only; keep 22 |
| nginx | Add `set_real_ip_from` + `real_ip_header CF-Connecting-IP`; optionally relax `limit_req` (Cloudflare absorbs floods at the edge — keep nginx limits as backstop) |
| App code | **None** (with the `real_ip` approach) |
| DR terraform | Set `infra/dr` `http_allow_cidrs` to Cloudflare CIDRs; re-add the Cloudflare DNS step to `infra/dr/README.md` |
| Docs | Un-drop the Cloudflare steps in `docs/EC2_HARDENING.html`; update the "not behind a CDN" comment in `src/lib/security.ts` |

**Standing gotchas once on Cloudflare:** CF adds CIDRs ~twice/year — update the SG
+ `set_real_ip_from` list or new edge traffic gets 522'd. Turn on the freebies:
Bot Fight Mode, WAF managed/OWASP rulesets, and Cloudflare edge **rate limiting**
(which becomes the primary limiter, nginx the backstop).

---

## 5. One-time / occasional infra

These are setup operations you rarely run — full context in the linked docs.

### 5.x ECR — the deploy image registry (2026-07-01)

The app deploys as pre-built images from a private ECR repo instead of building
on the box (cutover complete — Step 1 + Step 2 shipped; see the ROADMAP "CI → ECR"
item). `scripts/deploy.sh` ECR-logs-in, `docker compose pull`s the `:<sha>` images,
and swaps blue/green; if the pull fails it falls back to an on-box build so a
deploy never hard-fails.

- **Repo:** `803726282629.dkr.ecr.ap-south-1.amazonaws.com/ea-sys` (Mumbai, AES256, scan-on-push).
- **Tags:** web = `:<git-sha>` + `:latest`; worker = `:worker-<git-sha>` + `:worker-latest`.
- **Auth:** CI pushes via **GitHub OIDC** role `ea-sys-gha-ecr-push` (no stored keys); the box **pulls** via an `ecr-pull` inline policy on `ea-sys-mumbai-ec2-role`.
- **Migrations** run on the box from the **worker image** (`docker run <worker-image> npx prisma migrate deploy`) — it ships the full node_modules incl. the Prisma CLI, so **DB creds stay in `.env`, never in GitHub**.

```bash
# What images are in ECR right now:
aws ecr list-images --region ap-south-1 --repository-name ea-sys \
  --query 'imageIds[].imageTag' --output json

# Manually pull + run an image on the box (login first):
aws ecr get-login-password --region ap-south-1 | docker login --username AWS \
  --password-stdin 803726282629.dkr.ecr.ap-south-1.amazonaws.com
docker pull 803726282629.dkr.ecr.ap-south-1.amazonaws.com/ea-sys:<tag>
```

- **Rollback** = redeploy a previous `:<sha>` (no rebuild) — e.g. run
  `IMAGE_TAG=<old-sha> bash scripts/deploy.sh` on the box, or re-run the older
  green Actions deploy.
- **DR caveat:** ECR is in **Mumbai** — a full-region loss takes it down too. For
  region-independent recovery, enable **ECR cross-region replication → Singapore**
  (`ap-southeast-1`, where the DR S3 bucket is) — a one-time registry setting.

#### Image hygiene (applied 2026-07-01)

Three separate accumulation sources, three fixes — **all in place**:

1. **Untagged attestation manifests (registry).** `docker/build-push-action`
   defaults to `provenance: true`, which pushes an extra **untagged** provenance
   manifest per build (~4/deploy) that nothing pulls. Turned OFF with
   `provenance: false` + `sbom: false` on both build steps in `deploy.yml`
   (from commit `7092f8a` on). A clean image now shows
   `artifactMediaType = docker.container.image.v1+json`; older builds show a
   blank media type = an **OCI image index / manifest list** (image + attestation).
2. **Old `:<sha>` images accumulating in the registry** → **ECR lifecycle policy**
   (applied; `aws ecr get-lifecycle-policy --repository-name ea-sys`):
   rule 1 expires **untagged** after 1 day; rule 2 keeps the **10 most recent
   tagged** (≈5 deploys of web+worker rollback), expiring older ones.
3. **Old pulled `:<sha>` images accumulating on the box** (~780 MB/deploy, tagged
   so the dangling-only prune missed them) → `scripts/docker-prune.sh` now trims
   old repo tags, keeping the newest 3 web + 3 worker + the `:latest` pointers.

```bash
# Re-apply / view the lifecycle policy:
aws ecr get-lifecycle-policy --repository-name ea-sys --region ap-south-1
# Non-destructive preview of what it WOULD expire:
aws ecr start-lifecycle-policy-preview --repository-name ea-sys --region ap-south-1
aws ecr get-lifecycle-policy-preview  --repository-name ea-sys --region ap-south-1
```

> **Gotcha — you CANNOT `batch-delete-image` an untagged child of a manifest list.**
> ECR rejects it with `ImageReferencedByManifestList`. Those untagged entries are
> the attestation children of the *older* (pre-`provenance:false`) `:<sha>` index
> manifests, so they can't be deleted directly — they're removed automatically
> when their **parent `:<sha>` tag** rotates out of the keep-10 window (deleting
> the index takes its children with it). They cost ~nothing meanwhile (ECR dedupes
> layer blobs). So: don't hand-delete untagged — let the lifecycle policy rotate
> the parents. New (`provenance:false`) builds are plain single manifests with no
> child, so this only applies to the handful of pre-2026-07-01 images.

- **DR follow-up (LOW, ROADMAP):** enable ECR cross-region replication → Singapore.

#### Restore / roll back from the registry

Every `:<sha>` in ECR is a restore point. List them newest-first:
```bash
aws ecr describe-images --repository-name ea-sys --region ap-south-1 \
  --query 'reverse(sort_by(imageDetails,&imagePushedAt))[?imageTags].{tag:imageTags[0],pushed:imagePushedAt}' \
  --output table
```

**A — roll back a bad deploy (box healthy, the 90% case), one line on the box:**
```bash
cd /home/ubuntu/ea-sys && IMAGE_TAG=<old-sha> bash scripts/deploy.sh
```
Pulls that exact web+worker sha, runs `migrate deploy` from the worker image,
blue-green swaps, repoints nginx. ~1–2 min, no rebuild. ⚠️ **Migrations only roll
*forward*** — rolling the image back is safe only if the old code tolerates any
newer columns (our migrations are additive, so it usually is); a schema revert is
a manual `prisma migrate resolve` + down-SQL, not this path.

**B — pull one image by hand (surgical / debugging):**
```bash
aws ecr get-login-password --region ap-south-1 | docker login --username AWS \
  --password-stdin 803726282629.dkr.ecr.ap-south-1.amazonaws.com
docker pull 803726282629.dkr.ecr.ap-south-1.amazonaws.com/ea-sys:<sha>
```

**C — rebuild a lost box (Mumbai region OK):** the registry supplies only the
*app*; provision box + `git clone` (code) + restore `.env` and `uploads/` from the
Singapore S3 DR bucket + ensure the DB (Supabase, or a restored `pg_dump`) is
reachable, then `IMAGE_TAG=<sha> bash scripts/deploy.sh` pulls + starts. Full
step-by-step in [infra/dr/README.md](../infra/dr/README.md).

**D — full Mumbai-region loss:** ECR is Mumbai-only, so it's down too. `deploy.sh`
**auto-falls back to an on-box build** from the GitHub checkout (slower but works);
the durable fix is the cross-region-replication item above.

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

## 6. Gotchas worth memorising

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
- **t3 = burstable.** "App is slow but CPU isn't maxed" usually means **CPU
  credits exhausted** (throttled to ~30% baseline) — check `CPUCreditBalance`,
  not just `CPUUtilization` (§3.1).
- **A spike can be a wait, not a peak** — `P2024` connection-pool timeouts make
  the app hang while the box looks idle (§3.4).

---

*This doc is browsable in-dashboard at `/admin/docs`. Last aggregated: June 10, 2026.*
