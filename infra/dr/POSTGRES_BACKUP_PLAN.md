# Postgres backup plan — `pg_dump` to Singapore S3

> Plan of record for the database-side DR gap. Closes the last open item
> in [docs/EC2_HARDENING.html](../../docs/EC2_HARDENING.html) "Gaps still
> open" — "Supabase PITR + `pg_dump` to S3 + quarterly restore drill —
> High — biggest remaining data-loss risk".
>
> **Status**: planned 2026-06-03, not yet implemented.
> **Owner**: Krishna.
> **Sister doc**: [infra/dr/README.md](README.md) — covers the compute-
> side DR (uploads, .env, EC2 failover). This plan adds the database side
> on top of that.

---

## 1. Why we're doing this

The Singapore DR plan already covers compute (EC2 + uploads + `.env`).
The remaining single point of failure is **Postgres data inside
Supabase**. Today the recovery options are:

| Failure mode | What we have today |
|---|---|
| Accidental `DELETE` / bad migration / row corruption | Supabase daily snapshot (up to 24h old, restores the whole DB) |
| Supabase platform-level data loss | Supabase daily snapshot (same) |
| Supabase as a company disappearing | Nothing |

The gap is real but bounded. Our own dump to **our own bucket in our
own region** closes the last column AND gives us independent RPO from the
Supabase default. Combined with the existing `uploads/` + `env/` syncs,
the Singapore bucket becomes a one-stop recovery target.

### Decisions locked in (2026-06-03)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| Q1 | Retention | **Flat 30-day** from time of each backup | Simple lifecycle rule; Supabase platform daily backups remain the floor beyond 30d |
| Q2 | Alerting | **Log file + SES email on failure** | Log for routine checks; email so silent failure can't hide. Skip CloudWatch alarm for v1 |
| Q3 | Scope | **All tables in `public` schema** | Including `SystemLog` + `EmailLog`. Excludes Supabase platform schemas (`auth`, `storage`, `realtime`, `vault`, etc.) which reference proprietary extensions unavailable on vanilla PG 17 — see "First-run refinement" below. Revisit at 6-month mark if dumps exceed 1 GB |

### RPO/RTO targets

- **RPO**: ≤2h during Dubai daytime (08:00–22:00 GST), ≤4h overnight — dumps run on `0 2,4,6,8,10,12,14,16,18,22 * * *` UTC (10 dumps/day). Tunable by editing the cron hours; the script is unchanged. (Was 24h once-daily, then 12h, until 2026-06-30.)
- **RTO** (full restore): ~30 minutes (download dump + `pg_restore` to a fresh Supabase project or scratch Postgres)
- **RTO** (single-table or row-level recovery): faster — `pg_restore -t TABLE` is fast

---

## 2. Architecture

```
                                       Singapore — ap-southeast-1
                                       (KMS-encrypted, versioned)
                                    ┌──────────────────────────────┐
  Mumbai EC2 cron                   │ s3://ea-sys-dr-singapore/    │
  ┌──────────────────────────────┐  │   db/                        │
  │ 0 23 * * *                   │  │     2026/                    │
  │  scripts/dr-pg-dump.sh       │─►│       06/                    │
  │    pg_dump -Fc (via DIRECT)  │  │         03-11-mumbai.dump    │
  │    → /tmp/{date}.dump        │  │         03-23-mumbai.dump    │
  │    → aws s3 cp               │  │     ...                       │
  │    → rm /tmp/{date}.dump     │  │   uploads/  ← already running│
  │    → log + email on fail     │  │   env/      ← already running│
  └──────────────────────────────┘  └──────────────────────────────┘
                                          │
                                          └─► S3 lifecycle: expire
                                              after 30 days from each
                                              object's creation date
```

**Single bucket, three prefixes** — one DR target = one place to look
during recovery, one IAM policy to maintain, one KMS key. Database
prefix sits alongside the already-running uploads and env paths.

---

## 3. Components

### 3.1 The dump script — `scripts/dr-pg-dump.sh`

Lives next to `scripts/deploy.sh`. ~80 lines. Conventions:

- `set -euo pipefail` — fail fast on any error
- `trap` on `ERR` and `EXIT` — captures exit code, writes structured failure log, sends SES alert email
- Parses `DIRECT_URL` from `/home/ubuntu/ea-sys/.env` without `source`-ing the file (avoids running arbitrary `.env` contents as shell)
- Uses `DIRECT_URL` (not `DATABASE_URL`) — PgBouncer pooler doesn't support the session-level ops `pg_dump` performs
- Idempotent install check for `postgresql-client-XX` matching Supabase version
- Logs start/end/duration/size/S3 key, structured one-line-per-event so `grep`-friendly
- Cleans `/tmp/*.dump` on both success and failure paths (don't accumulate)

Draft:

```bash
#!/usr/bin/env bash
# Twice-daily Postgres dump → Singapore DR bucket.
# Cron: 0 23 * * * /home/ubuntu/ea-sys/scripts/dr-pg-dump.sh \
#         >> /home/ubuntu/cron-dr-db-backup.log 2>&1

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────
ENV_FILE="/home/ubuntu/ea-sys/.env"
DR_BUCKET="ea-sys-dr-singapore"
DR_REGION="ap-southeast-1"
PG_VERSION="15"                       # match Supabase's PG version
ALERT_EMAIL_FROM="alerts@meetingmindsexperts.com"
ALERT_EMAIL_TO="krishna@meetingmindsdubai.com"
TMP_DIR="/tmp"

# ── Derived ──────────────────────────────────────────────────────────────
TS_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DATE_PREFIX=$(date -u +%Y/%m)
FILENAME=$(date -u +%d-%H)-mumbai.dump
LOCAL_DUMP="${TMP_DIR}/${FILENAME}"
S3_KEY="db/${DATE_PREFIX}/${FILENAME}"
START_EPOCH=$(date -u +%s)

log() { echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"msg\":\"$*\"}"; }

# ── Failure trap — log + email + clean tmp ───────────────────────────────
on_error() {
  local exit_code=$?
  local last_cmd=${BASH_COMMAND}
  log "dr-pg-dump:FAILED exit=${exit_code} cmd=\"${last_cmd}\""
  if [[ -n "${ALERT_EMAIL_TO}" ]]; then
    aws ses send-email --region ap-south-1 \
      --from "${ALERT_EMAIL_FROM}" \
      --destination "ToAddresses=${ALERT_EMAIL_TO}" \
      --message "Subject={Data=DR pg_dump FAILED on Mumbai},Body={Text={Data=Exit ${exit_code} at ${TS_UTC}. Failed cmd: ${last_cmd}. Check cron-dr-db-backup.log on Mumbai.}}" \
      || log "dr-pg-dump:ses-alert-failed-too"
  fi
  rm -f "${LOCAL_DUMP}" || true
  exit "${exit_code}"
}
trap on_error ERR

# ── Ensure pg_dump installed ─────────────────────────────────────────────
if ! command -v pg_dump >/dev/null; then
  log "dr-pg-dump:installing postgresql-client-${PG_VERSION}"
  sudo apt-get update -qq
  sudo apt-get install -y -qq "postgresql-client-${PG_VERSION}"
fi

# ── Parse DIRECT_URL from .env without sourcing ──────────────────────────
if [[ ! -r "${ENV_FILE}" ]]; then
  log "dr-pg-dump:env-not-readable path=${ENV_FILE}"
  exit 1
fi
DIRECT_URL=$(grep -E '^DIRECT_URL=' "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
if [[ -z "${DIRECT_URL}" ]]; then
  log "dr-pg-dump:DIRECT_URL-missing"
  exit 1
fi

# ── Dump ─────────────────────────────────────────────────────────────────
log "dr-pg-dump:start ts=${TS_UTC} target=s3://${DR_BUCKET}/${S3_KEY}"
pg_dump \
  "${DIRECT_URL}" \
  -Fc \
  --no-owner --no-acl \
  --file="${LOCAL_DUMP}"

DUMP_BYTES=$(stat -c %s "${LOCAL_DUMP}")
log "dr-pg-dump:dump-complete size_bytes=${DUMP_BYTES}"

# ── Upload ───────────────────────────────────────────────────────────────
aws s3 cp "${LOCAL_DUMP}" "s3://${DR_BUCKET}/${S3_KEY}" --region "${DR_REGION}"

# ── Clean + report ───────────────────────────────────────────────────────
rm -f "${LOCAL_DUMP}"
END_EPOCH=$(date -u +%s)
log "dr-pg-dump:ok duration_s=$((END_EPOCH - START_EPOCH)) size_bytes=${DUMP_BYTES} s3_key=${S3_KEY}"
```

### 3.2 Cron entry — Mumbai box

```cron
# Daily Postgres dump to Singapore DR bucket (RPO 24h)
0 23 * * * /home/ubuntu/ea-sys/scripts/dr-pg-dump.sh >> /home/ubuntu/cron-dr-db-backup.log 2>&1
```

**23:00 UTC = 03:00 GST** — middle of the night, no event activity,
sits in the same nightly maintenance cluster as the `.env` snapshot
at 21:00 UTC. **Live schedule (as of 2026-06-30):
`0 2,4,6,8,10,12,14,16,18,22 * * *`** — ≤2h RPO during Dubai daytime,
≤4h overnight. To retune, change the cron hours; the script and IAM
are unchanged.

### 3.3 S3 lifecycle rule

Apply once at setup time:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket ea-sys-dr-singapore \
  --region ap-southeast-1 \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "db-30-day-expiry",
      "Status": "Enabled",
      "Filter": { "Prefix": "db/" },
      "Expiration": { "Days": 30 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 7 }
    }]
  }'
```

- `Expiration.Days: 30` — every object auto-deletes 30 days after its creation date
- `NoncurrentVersionExpiration.NoncurrentDays: 7` — bucket has versioning on; old versions of the same key linger 7 more days

### 3.4 IAM policy update

The existing `DRBackupToSingapore` inline policy on `ea-sys-mumbai-ec2-role`
likely scopes to `uploads/*` and `env/*`. Widen to include `db/*`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteToDRBucket",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:PutObjectAcl"],
      "Resource": [
        "arn:aws:s3:::ea-sys-dr-singapore/uploads/*",
        "arn:aws:s3:::ea-sys-dr-singapore/env/*",
        "arn:aws:s3:::ea-sys-dr-singapore/db/*"
      ]
    },
    {
      "Sid": "ReadFromDRBucketForSurgicalRecovery",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::ea-sys-dr-singapore",
        "arn:aws:s3:::ea-sys-dr-singapore/*"
      ]
    },
    {
      "Sid": "KMSForDRBucket",
      "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Encrypt", "kms:Decrypt"],
      "Resource": "arn:aws:kms:ap-southeast-1:<ACCOUNT-ID>:key/<DR-KEY-ID>"
    },
    {
      "Sid": "SESForBackupAlerts",
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "ses:FromAddress": "alerts@meetingmindsexperts.com"
        }
      }
    }
  ]
}
```

Two new lines: `db/*` in the write Resource list, and the `SESForBackupAlerts` statement. The `Read*` + `KMS*` blocks were already added during the surgical-recovery hardening; just listed here for completeness.

### 3.5 Quarterly restore drill — `scripts/dr-restore-drill.sh`

Separate script — important enough to deserve its own ceremony. Manual quarterly cadence; automating it adds CI surface area and catches zero additional problems.

Draft behaviour:

```bash
#!/usr/bin/env bash
# Quarterly: prove the latest dump actually restores cleanly.
# Run: bash scripts/dr-restore-drill.sh

set -euo pipefail

DR_BUCKET="ea-sys-dr-singapore"
DR_REGION="ap-southeast-1"
CONTAINER="ea-sys-dr-drill"
PG_PASS="drillpass"

# 1. Spin up scratch Postgres
docker run --rm -d --name "${CONTAINER}" \
  -e POSTGRES_PASSWORD="${PG_PASS}" \
  -p 55432:5432 postgres:17
sleep 5

# 2. Pull latest dump
LATEST=$(aws s3 ls "s3://${DR_BUCKET}/db/" --recursive --region "${DR_REGION}" \
  | sort -k1,2 | tail -1 | awk '{print $4}')
aws s3 cp "s3://${DR_BUCKET}/${LATEST}" /tmp/drill-restore.dump --region "${DR_REGION}"

# 3. Restore
PGPASSWORD="${PG_PASS}" pg_restore \
  -h localhost -p 55432 -U postgres -d postgres \
  --no-owner --no-acl --jobs=4 \
  /tmp/drill-restore.dump

# 4. Smoke: row counts on critical tables
for TABLE in "Event" "Registration" "IssuedCertificate" "Payment" "EmailLog" "Speaker" "Abstract" "CertificateTemplate"; do
  COUNT=$(PGPASSWORD="${PG_PASS}" psql -h localhost -p 55432 -U postgres -d postgres -tAc "SELECT COUNT(*) FROM \"${TABLE}\";")
  echo "  ${TABLE}: ${COUNT} rows"
done

# 5. Tear down
docker stop "${CONTAINER}"
rm -f /tmp/drill-restore.dump

echo "✓ Restore drill complete — dump ${LATEST} is restorable"
```

**Calendar reminder**: 15th of every quarter (Jan/Apr/Jul/Oct), same as the existing monthly DR drill but quarterly cadence.

### 3.6 Documentation slot-ins for `infra/dr/README.md`

Three additions to the existing README — keep this plan doc as design history, but the README is what an operator reads under pressure:

#### §6 — one-time setup: "Set up DB backup cron"

Slots in after §5 (smoke test) in the existing one-time-setup section. Mirrors §3 (uploads cron) but with the new line + the `apt install` step + the lifecycle policy command.

#### Surgical Recovery §E — "Restore from a pg_dump"

Slots after §D (previous-version restore) in the existing Surgical Recovery section:

```bash
# Find the most recent dump:
aws s3 ls s3://ea-sys-dr-singapore/db/ --recursive --region ap-southeast-1 \
  | sort -k1,2 | tail -5

# Pull it locally (or to a scratch box):
LATEST=$(aws s3 ls s3://ea-sys-dr-singapore/db/ --recursive --region ap-southeast-1 \
  | sort -k1,2 | tail -1 | awk '{print $4}')
aws s3 cp "s3://ea-sys-dr-singapore/${LATEST}" /tmp/restore.dump --region ap-southeast-1

# Restore to a target DB. Two scenarios:
#  a) Full disaster — restore to a NEW Supabase project, then point .env
#     DATABASE_URL/DIRECT_URL at it, redeploy.
#  b) Surgical — restore one table to a scratch DB and SELECT what you need:
PG_DSN="postgresql://postgres:PASS@SCRATCH-HOST:5432/postgres"
pg_restore --no-owner --no-acl --jobs=4 -d "${PG_DSN}" /tmp/restore.dump

# Or pick one table:
pg_restore --no-owner --no-acl -t "Registration" -d "${PG_DSN}" /tmp/restore.dump
```

#### Known gaps §3 update

The current README has "Supabase dependency" under Known gaps. Update wording: "Postgres data — covered by daily `pg_dump` to Singapore (24h RPO). Tighter RPO would need a twice-daily cron or Supabase PITR (separate decision, not enabled today)."

---

## 4. Alerting design (decision Q2 = A + C)

Two channels, both routed off the script's `on_error` trap:

### A. Log file
`/home/ubuntu/cron-dr-db-backup.log` — one JSON line per event. Every failure carries:
- Exit code
- Last failed command (`BASH_COMMAND` at trap time)
- UTC timestamp
- Optional: pg_dump stderr tail

### C. SES email
`aws ses send-email` from `alerts@meetingmindsexperts.com` to `krishna@meetingmindsdubai.com`. The sender domain is already verified for SES (per the existing EA-SYS SES setup); no DKIM / domain-verification work needed.

The script's failure trap fires SES BEFORE re-raising, so the email goes
out even on partial failures. SES send is wrapped in `|| log "ses-alert-failed-too"` so a SES outage can't hide the original Postgres failure.

**Configurable bits via env if needed later**:
```bash
ALERT_EMAIL_TO  # default: krishna@meetingmindsdubai.com (hardcoded for v1)
```

Add `ALERT_EMAIL_TO` to `.env.example` documentation so others picking up this repo see the channel.

---

## 5. Cost estimate

| Item | Monthly |
|---|---|
| S3 storage (60 dumps × ~150 MB avg = ~9 GB) | ~$0.20 |
| S3 PUT (60/mo) | ~$0.00 |
| KMS encrypt calls (60/mo) | ~$0.00 |
| SES emails (typically 0/mo, ~$0.0001 per send if any) | ~$0.00 |
| CPU + bandwidth on Mumbai box (daily dump) | ~$0.00 (already paying for the box) |
| **Total incremental** | **~$0.20–0.50/mo** |

Compare to the open alternative (Supabase PITR at ~$25-50/mo): this is **<2% of the cost** for ~75% of the protection. The remaining 25% is the sub-24h RPO precision PITR offers but our 24h tolerance doesn't need.

---

## 6. Execution checklist (in order)

When ready to implement:

- [ ] **6.1** Determine Supabase PG version (`SELECT version();` on the dashboard SQL editor). Update `PG_VERSION` in `scripts/dr-pg-dump.sh` if not 15.
- [ ] **6.2** Verify SES sender — `alerts@meetingmindsexperts.com` is verified in SES `ap-south-1`. If not, verify it (5 min, one DNS record).
- [ ] **6.3** Write `scripts/dr-pg-dump.sh` from the §3.1 draft. Test locally on Mac if possible (with a fresh Supabase scratch project or local Postgres) before deploying.
- [ ] **6.4** Write `scripts/dr-restore-drill.sh` from the §3.5 draft.
- [ ] **6.5** Update IAM policy `DRBackupToSingapore` per §3.4. Verify with `aws iam get-role-policy` after.
- [ ] **6.6** Apply S3 lifecycle rule (§3.3 command).
- [ ] **6.7** On Mumbai box: `sudo apt-get install -y postgresql-client-17` (Supabase verified at PG 17 on 2026-06-03).
- [ ] **6.8** On Mumbai box: place `scripts/dr-pg-dump.sh` and run **once manually** end-to-end. Verify:
  - Exits 0
  - Log file has the structured success line
  - S3 has the new object
  - Object size is reasonable (~50-500 MB compressed)
  - Restore drill (`scripts/dr-restore-drill.sh`) successfully restores it
- [ ] **6.9** Install cron line on Mumbai box (§3.2).
- [ ] **6.10** Update `infra/dr/README.md` with §6 + §E + Known gaps fix.
- [ ] **6.11** Commit + push the scripts + README + this plan doc (which becomes design history).
- [ ] **6.12** Calendar entry: quarterly restore drill (15 Jul, 15 Oct, 15 Jan, 15 Apr).
- [ ] **6.13** Wait 24h. Confirm the 23:00 UTC tick fired cleanly. Look at the log + S3 list.

Estimated effort: ~90 min total (~30 min coding + ~30 min infra + ~30 min docs + manual verification).

---

## 7. Open items / deferrals

Things we explicitly chose NOT to do in v1:

| Item | Why deferred | Re-eval trigger |
|---|---|---|
| Exclude `SystemLog` + `EmailLog` from dumps | Dumps still small; full table = full audit recovery | If dump size > 1 GB |
| Tiered retention (30d daily + 12w weekly + 12mo monthly) | Flat 30d sufficient given Supabase platform daily backups behind us | Compliance requirement, or business-historical reason |
| CloudWatch metric + alarm | Email + log is enough signal for one operator | When you grow past 1 person on-call |
| Auto-run quarterly drill | Adds CI surface; catches no new problems | Multi-person team that doesn't trust manual cadence |
| Supabase PITR | Cost ~$25-50/mo for diminishing return at 24h RPO | Flagship event where 24h of registration/checkin loss is unacceptable |
| Cross-region read replica for true HA | Cost + complexity; warm DB needed only for sub-minute RTO | If "Supabase regional outage" becomes a real business risk |
| Per-object integrity check (sha256 manifest) | Restore drill catches corruption end-to-end | If S3 object integrity becomes a regulatory concern |

---

## 8. Future revisits

- **6-month checkpoint (Dec 2026)**: review dump size. If under 1 GB, no action. If approaching, exclude noisy tables (per Q3 deferral).
- **1-year checkpoint (Jun 2027)**: review whether PITR is now worth the spend (event volume, data sensitivity, regulatory pressure).
- **When `mmg-recording-pipeline` ships**: separate DR consideration — its Postgres is its own DB, not EA-SYS. May or may not adopt the same `pg_dump → S3` pattern.

---

## 9. Cross-references

- [infra/dr/README.md](README.md) — compute DR plan this plugs into
- [docs/EC2_HARDENING.html](../../docs/EC2_HARDENING.html) — original gap identified at line 895
- [scripts/deploy.sh](../../scripts/deploy.sh) — blue-green deploy that should NOT need to know about this plan (independent surface)
- Memory: [reference_ses_email.md](../../../../.claude/projects/-Users-krishnapallapolu-Downloads-upcoming-ea-sys/memory/reference_ses_email.md) — SES sender setup
- Memory: [feedback_always_log_failures.md](../../../../.claude/projects/-Users-krishnapallapolu-Downloads-upcoming-ea-sys/memory/feedback_always_log_failures.md) — every failure path must log + alert

---

## 10. Sign-off

Plan accepted by Krishna 2026-06-03. Implementation can begin against
the §6 checklist when scheduled.

---

## 11. First-run refinement (2026-06-03 same day)

Implementation revealed one detail not anticipated in the plan: the
first `pg_dump` against the actual Supabase project included Supabase
platform schemas (`auth`, `storage`, `realtime`, `graphql_public`,
`vault`, `pgsodium`, `_realtime`, `extensions`) which reference
proprietary extensions (`supabase_vault`, `pgsodium`, ...). The
restore drill failed with `extension "supabase_vault" is not
available` because vanilla `postgres:17` doesn't ship those.

**Resolution**: added `--schema=public` to the `pg_dump` invocation
in `scripts/dr-pg-dump.sh`. EA-SYS uses none of the Supabase platform
features (NextAuth not Supabase Auth, `STORAGE_PROVIDER=local` not
Supabase Storage, no Realtime/GraphQL/Vault) so the public schema is
all the application data we have.

**DR posture impact**: net positive.
- Smaller, faster dumps (1.29 MB on first run vs ~3-5 MB had we
  included platform schemas)
- **Portable**: restores to ANY vanilla PG 17 (RDS, Crunchy, Aiven,
  Postgres in Docker), not just Supabase. Real disaster scenarios
  where Supabase itself is unreachable now have a non-Supabase fail-
  over path.
- Real DR flow unchanged: restoring to a new Supabase project still
  works — Supabase recreates the platform schemas on project
  creation, our `public` dump layers on top.

**Re-evaluation trigger**: if EA-SYS ever adopts Supabase Auth, Supabase
Storage, or Realtime, revisit. Either (a) widen the dump scope and use
the `supabase/postgres:17` image in the drill, or (b) treat those
features as ephemeral and rebuild on disaster (often acceptable for
Realtime / GraphQL state).
