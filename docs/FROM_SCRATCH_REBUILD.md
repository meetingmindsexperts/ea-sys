# From-Scratch Rebuild — EA-SYS Production Box

> **Purpose:** rebuild the entire production server from nothing (a brand-new EC2 instance — same region or a replacement region) to a fully operating EA-SYS: web blue/green + worker + MediaMTX + nginx/TLS + backups + protection + observability.
>
> **How this doc works:** it is an *ordered checklist that mostly cross-links* the existing, proven pieces — and fills the five gaps no other doc covered (swap, IAM role, full crontab, nginx snapshot-vs-template, SG ports). The closest executable artifact is **`infra/dr/user-data.sh`** (the Singapore break-glass bootstrap, proven by the monthly DR drill) — Phase 2 leans on it.
>
> **Live-state snapshots below were captured read-only from the production box on July 13, 2026.** Re-verify anything marked 📸 before trusting it years later.
>
> Related: `deploy/SERVER_SETUP.md` (blue-green wiring only — Phase 4 here), `docs/MUMBAI_SETUP.md` (the 2026 region-migration guide; partially stale — see §Known drift), `infra/dr/README.md` (backup/restore deep runbook), `docs/AWS_OPERATIONS.md` (daily-ops inventory).

---

## Phase 0 — What you're rebuilding (inventory 📸)

| Item | Value |
|---|---|
| AWS account | `803726282629` |
| Region | `ap-south-1` (Mumbai) |
| Instance | `t3.large`, Ubuntu **24.04 (Noble)**, **48 GB** gp3 root, Elastic IP |
| Current instance id | `i-0b51ab1213d084640` |
| IAM instance profile | `ea-sys-mumbai-ec2-role` (§1.1) |
| Security group | `launch-wizard-1` (`sg-01da66338a3c4ce46`) — ports §1.2 |
| Domain | `events.meetingmindsgroup.com` → A record to the Elastic IP (no CDN/proxy — deliberate, see AWS_OPERATIONS §4) |
| Database | Supabase Postgres (external — survives the box; `DATABASE_URL`/`DIRECT_URL` in `.env`) |
| Email | SES `ap-south-1`, sender `meetingmindsexperts.com`, creds via instance role (no keys in `.env`) |
| Images | ECR `803726282629.dkr.ecr.ap-south-1.amazonaws.com/ea-sys` (`:<git-sha>` web, `:worker-<sha>` worker) |
| DR bucket | `s3://ea-sys-dr-singapore` (`ap-southeast-1`) — `.env` snapshots, uploads mirror, pg dumps |
| Containers | `ea-sys-blue`/`ea-sys-green` (web), `ea-sys-worker`, `ea-sys-mediamtx` — all from `docker-compose.prod.yml` |

**What does NOT need rebuilding** (lives off-box): the database, SES identities, ECR images, the DR bucket, DNS zone, GitHub repo + Actions. The box is deliberately cattle; the runbook below re-attaches it to all of those.

---

## Phase 1 — AWS side (before launching anything)

### 1.1 IAM role — `ea-sys-mumbai-ec2-role` 📸

Everything on the box silently depends on this role: ECR pulls in `deploy.sh`, all three backup crons, SES sending, SSM access, CloudWatch shipping. Create role (EC2 trust) + instance profile of the same name, then:

**Attached managed policies:**
- `arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy`
- `arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore`

**Inline policy `DRBackupToSingapore`:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "DRBucketReadWrite", "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::ea-sys-dr-singapore", "arn:aws:s3:::ea-sys-dr-singapore/*"] },
    { "Sid": "DRKMSEncryptDecrypt", "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Encrypt", "kms:Decrypt"],
      "Resource": "arn:aws:kms:ap-southeast-1:803726282629:key/8aa94a9b-deee-453a-a4ee-4e0f54c749de" },
    { "Sid": "SESForBackupAlerts", "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"], "Resource": "*",
      "Condition": { "StringEquals": { "ses:FromAddress": "alerts@meetingmindsexperts.com" } } }
  ]
}
```

**Inline policy `EaSysSesSend`:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "EaSysSesSend", "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": [
        "arn:aws:ses:ap-south-1:803726282629:identity/meetingmindsexperts.com",
        "arn:aws:ses:ap-south-1:803726282629:configuration-set/my-first-configuration-set"
      ] }
  ]
}
```

**Inline policy `ecr-pull`:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "EcrAuth", "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    { "Sid": "EcrPull", "Effect": "Allow",
      "Action": ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
      "Resource": "arn:aws:ecr:ap-south-1:803726282629:repository/ea-sys" }
  ]
}
```

### 1.2 Security group 📸

| Port | Protocol | Source | Why |
|---|---|---|---|
| 80 | tcp | 0.0.0.0/0 | HTTP → certbot challenges + redirect |
| 443 | tcp | 0.0.0.0/0 | HTTPS |
| **1935** | tcp | 0.0.0.0/0 | **RTMP ingest for MediaMTX live streaming** — the port every older doc forgets |
| 22 | tcp | 0.0.0.0/0 | SSH (GitHub Actions deploy; fail2ban `sshd` jail mitigates). Hardening option: restrict to office IP + use SSM instead — but note the Actions deploy currently needs 22 open to shared runner IPs |

Ports **3000/3001/3099/8888** stay unpublished/localhost-only (nginx proxies; worker health is internal).

### 1.3 Launch

t3.large, Ubuntu 24.04 LTS, 48 GB gp3, the §1.1 instance profile, the §1.2 SG, allocate + associate an **Elastic IP**. Don't point DNS yet (Phase 4 decides when).

---

## Phase 2 — Box bootstrap (packages + THE swap gap)

**Base:** follow `infra/dr/user-data.sh` §1–§2 verbatim — it is the maintained, drill-proven sequence: `apt` base packages (`ca-certificates curl gnupg git nginx jq unzip unattended-upgrades`), **AWS CLI v2 via the official installer** (apt's `awscli` package does not exist on Noble — known gotcha), Docker CE + compose plugin from Docker's repo, `usermod -aG docker ubuntu`.

**Then the step NO other doc has — create swap (the INC-001 fix):**

```bash
# The box froze during an on-box docker build because it was swapless (INC-001).
# deploy.sh still has an on-box-build fallback when ECR is unreachable, so a
# rebuilt box WITHOUT swap regresses to the exact freeze configuration.
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # 📸 matches live fstab
swapon --show   # expect: /swapfile file 4G
```

Two packages that other scripts install lazily — do them now so nothing surprises you later: `postgresql-client-17` needs the **PGDG repo** on Noble (`scripts/dr-pg-dump.sh` auto-installs on first run, but see `infra/dr/README.md` §6 to do it explicitly), and `acl` (`infra/cloudwatch/setup.sh` handles it).

---

## Phase 3 — App checkout + secrets + data

Follow `infra/dr/user-data.sh` §3–§5b, which does exactly this:

1. **`.env`** — pull the newest snapshot: `aws s3 cp s3://ea-sys-dr-singapore/env/<latest>.env /home/ubuntu/ea-sys/.env --region ap-southeast-1` (list with `aws s3 ls s3://ea-sys-dr-singapore/env/`). `chmod 600`, owner `ubuntu`.
2. **Repo** — clone `meetingmindsexperts/ea-sys` (branch `main`) using the `GITHUB_DR_TOKEN` that lives inside that `.env` (fine-grained PAT, Contents:read).
3. **Dirs** — `mkdir -p public/uploads logs` (both are compose volume mounts).
4. **Uploads** — `aws s3 sync s3://ea-sys-dr-singapore/uploads/ public/uploads/ --region ap-southeast-1` (Mumbai mirrors hourly; worst case you're ≤60 min stale).
5. If restoring after a DB loss too: `infra/dr/README.md` §Surgical recovery / the cold-standby runbooks (`COLD_STANDBY_RDS.md` / `COLD_STANDBY_SUPABASE.md`).

`.env` sanity check before first boot: `DATABASE_URL`/`DIRECT_URL` include the pool params (`connection_limit=10&pool_timeout=15`), `NEXTAUTH_URL`/`NEXT_PUBLIC_APP_URL` point at the prod domain, `CRON_SECRET` present.

---

## Phase 4 — nginx + TLS + blue-green wiring

1. **Use the live snapshot, NOT the template:** copy **`deploy/nginx.live-snapshot.conf`** → `/etc/nginx/sites-available/ea-sys` (symlink into `sites-enabled`, remove `default`). The box's nginx is Certbot-managed and drifted from `deploy/nginx.conf` long ago; the snapshot is the captured live truth (re-verified content-identical to live on 2026-07-13). It already contains the rate-limit zones, the `/stream/` MediaMTX proxy, and `X-Real-IP` wiring that `getClientIp()` trusts.
2. **Blue-green wiring:** run `deploy/SERVER_SETUP.md` steps 1, 2 and 5 — the nginx sudoers for `ubuntu`, the initial `ea-sys-upstream.conf` (blue :3000), and `echo blue > /home/ubuntu/.active-slot`. (Skip its step 4 — that was a one-time 2026 migration.)
3. **TLS bootstrap:** on a fresh box there's no cert yet — use the self-signed stub sequence from `infra/dr/user-data.sh` §5 (openssl self-signed into the letsencrypt live path + certbot snippet stubs) so `nginx -t` passes immediately.
4. **Real cert (after DNS):** point the A record at the Elastic IP, wait for propagation, then `sudo certbot --nginx -d events.meetingmindsgroup.com --non-interactive --agree-tos -m <admin email>`. Certbot installs its own renewal timer.
5. After any certbot run, **re-snapshot**: if `diff /etc/nginx/sites-available/ea-sys deploy/nginx.live-snapshot.conf` shows real drift, copy live → snapshot and commit (the box is the source of truth; the repo file is the recovery copy).

---

## Phase 5 — First deploy

```bash
cd /home/ubuntu/ea-sys
bash scripts/deploy.sh        # pulls :latest web + worker from ECR, health-checks, switches nginx
```

Notes: an unparameterized run uses the moving `:latest`/`:worker-latest` tags; to pin, `IMAGE_TAG=<full-git-sha> bash scripts/deploy.sh` (see `docs/ROLLBACK.md`). If ECR is unreachable it falls back to building on-box — which is why Phase 2's swap is non-negotiable. `deploy.sh` also applies pending Prisma migrations (additive-only policy).

Verify: `curl -s localhost:3000/api/health` (or :3001 per slot), `curl -s https://events.meetingmindsgroup.com/health`, `curl -s https://events.meetingmindsgroup.com/worker/health` (proxies the worker's internal :3099), `docker ps` shows blue-or-green + `ea-sys-worker` + `ea-sys-mediamtx` all healthy.

---

## Phase 6 — Crontab (the complete live set 📸)

`crontab -e` as **ubuntu**. This is the full active crontab as of July 13, 2026 (the `[worker-cutover 2026-06-09]`-commented legacy `/api/cron/*` lines are intentionally dead — the worker container is the sole runner; keep or drop the comments, never re-enable without reading `docs/WORKER_EXTRACTION_PLAN.md`):

```cron
CRON_SECRET=<value from .env>

# Nightly .env backup to Singapore DR bucket (21:00 UTC = 02:30 IST)
0 21 * * * aws s3 cp /home/ubuntu/ea-sys/.env s3://ea-sys-dr-singapore/env/$(date -u +\%F).env --region ap-southeast-1 >> /home/ubuntu/cron-dr-backup.log 2>&1

# Hourly uploads mirror to Singapore DR bucket. The trailing heartbeat write
# is LOAD-BEARING — the infra DR card reads heartbeats/uploads-mirror to know
# the sync ran (sync alone only writes when a file changed; without the
# heartbeat the card false-alarms on quiet days). Added 2026-07-17.
0 * * * * aws s3 sync /home/ubuntu/ea-sys/public/uploads/ s3://ea-sys-dr-singapore/uploads/ --region ap-southeast-1 --exclude "*/.gitkeep" >> /home/ubuntu/cron-dr-uploads-sync.log 2>&1 && echo ok | aws s3 cp - s3://ea-sys-dr-singapore/heartbeats/uploads-mirror --region ap-southeast-1 >> /home/ubuntu/cron-dr-uploads-sync.log 2>&1

# Postgres dump to Singapore DR bucket — ≤2h RPO Dubai daytime, ≤4h overnight
0 2,4,6,8,10,12,14,16,18,22 * * * /home/ubuntu/ea-sys/scripts/dr-pg-dump.sh >> /home/ubuntu/cron-dr-db-backup.log 2>&1

# Weekly docker prune (Friday 03:00 UTC)
0 3 * * 5 /home/ubuntu/ea-sys/scripts/docker-prune.sh >> /home/ubuntu/cron-docker-prune.log 2>&1
```

All application-level jobs (cert-issue, scheduled-emails, webinar syncs, oauth-cleanup, invoice-reconciliation, log-archive, contacts sync) run inside `ea-sys-worker` via node-cron — nothing to configure; they start with the container.

---

## Phase 7 — Protection + observability

1. **fail2ban:** `sudo apt-get install -y fail2ban` (sshd jail comes enabled by default), then `bash infra/fail2ban/setup.sh` for the nginx 429 jail. 📸 Live jail values: `maxretry=100 findtime=120 bantime=1800 backend=auto logpath=/var/log/nginx/error.log`. Add the office egress IP to `ignoreip` (live currently has localhost only). Verify: `sudo fail2ban-client status nginx-rate-limit`.
2. **CloudWatch agent:** `bash infra/cloudwatch/setup.sh` — ships `logs/app.log` + `logs/error.log` to log groups `ea-sys/app` (30d) / `ea-sys/error` (90d). The §1.1 role already carries the policy. Verify entries appear in `ap-south-1` CloudWatch within minutes.
3. **SSM:** should already work via the role (agent is stock on Ubuntu AMIs) — verify `aws ssm start-session --target <new-instance-id> --region ap-south-1` from your machine.

---

## Phase 8 — CI/CD reattachment

Update GitHub repo **Actions secrets** for the deploy workflow (host = new Elastic IP, plus the SSH key — see `docs/MUMBAI_SETUP.md` step 8 for the exact secret names) and put the deploy public key in `/home/ubuntu/.ssh/authorized_keys`. Then push a trivial commit to `main` and watch the workflow do a full build→ECR→SSH→`deploy.sh` round trip. If the SSH step times out with `dial tcp :22 i/o timeout`, that's the known fail2ban-vs-shared-runner flakiness — re-run the job.

---

## Phase 9 — Final verification checklist

- [ ] `https://events.meetingmindsgroup.com` serves with a valid Let's Encrypt cert
- [ ] `/api/health` + `/worker/health` both 200; `docker ps` shows web + worker + mediamtx healthy
- [ ] `/logs` dashboard shows fresh `worker:tick-end` lines at expected cadences (search `worker:`)
- [ ] Log in, load an event, print a badge (exercises DB + uploads + PDF path)
- [ ] Send yourself a test email from Communications (exercises SES via the role)
- [ ] Force one of each backup: run the three cron commands by hand once, confirm objects land in `s3://ea-sys-dr-singapore/{env,uploads,db}/`
- [ ] `sudo fail2ban-client status` lists both jails; CloudWatch log groups receiving
- [ ] A GitHub Actions deploy completes end-to-end (Phase 8)
- [ ] Run `scripts/dr-restore-drill.sh` once from the box — proves the new box can also *restore*
- [ ] Update `docs/AWS_OPERATIONS.md` inventory + this doc's Phase 0 table with the new instance id

---

## Known drift in the older docs (why this doc exists)

- `docs/MUMBAI_SETUP.md` says Ubuntu 22.04 / 30 GB / installs Node 20 on the host — live is **Noble 24.04 / 48 GB**, and no host Node is needed (everything runs in containers; migrations run via deploy.sh). It also predates the worker cutover, ECR pulls, swap, fail2ban's nginx jail, and CloudWatch.
- `deploy/SERVER_SETUP.md` is blue-green wiring only; its step 4 is a historical migration and its original timing table described the pre-ECR on-box-build era (corrected July 13, 2026).
- `deploy/nginx.conf` is a **reference template** — the live file and `deploy/nginx.live-snapshot.conf` are the truth.
- The `logs/archive/` monthly SystemLog archives are **not** in any S3 sync yet (single copy on box disk) — decision pending; see ROADMAP if it's been added since.
