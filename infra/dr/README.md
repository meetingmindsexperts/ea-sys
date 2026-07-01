# EA-SYS DR — Singapore break-glass box

Terraform module that provisions a replacement EA-SYS box in `ap-southeast-1`
when Mumbai is down. **No standing cost** — provision on demand, destroy after.

RTO target: **~10 minutes** from `terraform apply` to serving traffic.

## What's in here

| File | Purpose |
|---|---|
| `main.tf` | EC2 + EIP + SG + IAM in Singapore. SG allows 80/443 per `var.http_allow_cidrs` (default wide-open, matching Mumbai's direct-exposure posture), no port 22 (SSM for shell). |
| `user-data.sh` | First-boot bootstrap. Installs Docker, clones the repo, fetches `.env` from S3, runs `scripts/deploy.sh`. |
| `variables.tf` | `region`, `instance_type`, `git_ref`, `github_repo`, `dr_bucket_name`, `dr_kms_key_arn`. |
| `outputs.tf` | `public_ip`, `instance_id`, `ssm_session_command`. |

## One-time setup (before first `terraform apply`)

You only need to do this once. Steps mirror §6a of the hardening plan.

### 1. Create the DR S3 bucket + KMS key in Singapore

```bash
# Customer-managed KMS key (do NOT reuse the Mumbai key)
aws kms create-key --region ap-southeast-1 \
  --description "EA-SYS DR bucket encryption" \
  --tags TagKey=Project,TagValue=ea-sys TagKey=Environment,TagValue=dr
# Note the KeyArn from output — pass as dr_kms_key_arn to Terraform.

# Bucket (name must be globally unique)
aws s3api create-bucket --bucket ea-sys-dr-singapore \
  --region ap-southeast-1 \
  --create-bucket-configuration LocationConstraint=ap-southeast-1

# Versioning + encryption + public-access block
aws s3api put-bucket-versioning --bucket ea-sys-dr-singapore \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption --bucket ea-sys-dr-singapore \
  --server-side-encryption-configuration '{
    "Rules":[{"ApplyServerSideEncryptionByDefault":{
      "SSEAlgorithm":"aws:kms",
      "KMSMasterKeyID":"<KEY_ARN_FROM_ABOVE>"
    }}]
  }'

aws s3api put-public-access-block --bucket ea-sys-dr-singapore \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
```

### 2. Add `GITHUB_DR_TOKEN` to the Mumbai `.env`

The DR box clones the repo with this token on first boot. Create a
**fine-grained** GitHub PAT with `Contents: read` scoped to the
`meetingmindsexperts/ea-sys` repo only. **No other scopes.**

SSM into Mumbai and append to `.env`:

```bash
aws ssm start-session --target <mumbai-instance-id> --region ap-south-1
sudo -iu ubuntu
echo 'GITHUB_DR_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' >> /home/ubuntu/ea-sys/.env
```

Next `.env` cron run (02:30 IST) will ship it to Singapore.

### 3. Set up the Mumbai→Singapore backup crons

On the Mumbai box (`sudo -iu ubuntu`, then `crontab -e`):

```cron
# Daily .env snapshot to Singapore DR bucket (21:00 UTC = 02:30 IST)
0 21 * * * aws s3 cp /home/ubuntu/ea-sys/.env s3://ea-sys-dr-singapore/env/$(date -u +\%F).env --region ap-southeast-1 >> /home/ubuntu/cron-dr-backup.log 2>&1

# Hourly uploads mirror to Singapore DR bucket (covers user-uploaded media)
0 * * * * aws s3 sync /home/ubuntu/ea-sys/public/uploads/ s3://ea-sys-dr-singapore/uploads/ --region ap-southeast-1 --exclude "*/.gitkeep" >> /home/ubuntu/cron-dr-uploads-sync.log 2>&1
```

Both require the Mumbai EC2's IAM role (`ea-sys-mumbai-ec2-role`) to have
`s3:PutObject` on `arn:aws:s3:::ea-sys-dr-singapore/*` and
`kms:GenerateDataKey`/`kms:Encrypt` on the Singapore KMS key — attach the
inline policy `DRBackupToSingapore` to the role.

RPO implications:
- `.env`: up to 24 hours of `.env` changes lost in a regional disaster. Acceptable (`.env` rarely changes). Run the command manually after adding a new secret if you need tighter.
- Uploads: up to 1 hour of user uploads lost in a regional disaster. Tighten the cron to `*/5 * * * *` (every 5 min) if that's too loose.

### 4. Create `terraform.tfvars`

Do NOT commit this file — it's in `.gitignore`.

```hcl
# infra/dr/terraform.tfvars
dr_kms_key_arn = "arn:aws:kms:ap-southeast-1:123456789012:key/..."
# All other vars have sensible defaults in variables.tf.
```

### 5. Smoke-test the read path (untested backups aren't backups)

After the first cron tick has populated the bucket, prove the Mumbai
IAM role can actually **read** from it — not just write. A bucket the
role can write but can't read is a dead-end during recovery, and the
problem only surfaces when you need it.

```bash
# On the Mumbai box:
sudo -u ubuntu aws s3 ls s3://ea-sys-dr-singapore/uploads/ \
  --region ap-southeast-1 --recursive | head -3

# Pull any one object back and confirm it round-trips:
KEY=$(sudo -u ubuntu aws s3 ls s3://ea-sys-dr-singapore/uploads/ \
  --region ap-southeast-1 --recursive \
  | awk '$3 > 0 {print $4; exit}')
sudo -u ubuntu aws s3 cp "s3://ea-sys-dr-singapore/$KEY" /tmp/dr-test \
  --region ap-southeast-1
file /tmp/dr-test    # expect: JPEG / PDF / PNG image data
rm /tmp/dr-test
```

If the `ls` or `cp` fails with `AccessDenied`, the `DRBackupToSingapore`
inline policy on `ea-sys-mumbai-ec2-role` is missing `s3:GetObject` and/
or `kms:Decrypt`. Add them — the [surgical recovery section](#surgical-recovery--mumbai-is-up-you-lost-specific-files)
below depends on this path working.

### 6. Set up the Postgres backup cron (≤2h day / ≤4h night RPO)

Closes the database-side DR gap. Without this, the only recovery option
for Supabase data loss is the Supabase platform's own backups (daily,
up to 24h old). With this, you have an independent twice-daily dump sitting
in your own bucket in your own region, restorable to any Postgres
anywhere — protects against Supabase-platform issues, not just Supabase
operator mistakes.

See [POSTGRES_BACKUP_PLAN.md](POSTGRES_BACKUP_PLAN.md) for the design
rationale; this section is the operator runbook.

#### 6.1 Install the Postgres client matching Supabase's server version

```bash
# On the Mumbai box. The script auto-installs on first run, but doing
# it explicitly here makes the version pinning visible.
sudo -iu ubuntu
sudo apt-get update -qq
sudo apt-get install -y postgresql-client-17   # match Supabase's PG version (verified 2026-06-03)
pg_dump --version    # expect: pg_dump (PostgreSQL) 17.x
```

If Supabase moves to PG 16+, bump both the apt package and the
`PG_VERSION` default in [scripts/dr-pg-dump.sh](../../scripts/dr-pg-dump.sh).

#### 6.2 Verify SES sender domain

Failure alerts go out via `alerts@meetingmindsexperts.com` to
`krishna@meetingmindsdubai.com`. The sender domain must be verified in
SES in `ap-south-1`.

```bash
aws ses get-identity-verification-attributes \
  --identities meetingmindsexperts.com \
  --region ap-south-1
# Expect: VerificationStatus: Success
```

If not verified, add the domain in the SES console (5 min, one TXT
record at the registrar).

#### 6.3 Widen the IAM policy + add SES permission

The existing `DRBackupToSingapore` inline policy on `ea-sys-mumbai-ec2-role`
needs two updates: (a) add `db/*` to the write Resource list, (b) add a
new statement allowing `ses:SendEmail` for the alerts sender. Full
policy JSON is in [POSTGRES_BACKUP_PLAN.md §3.4](POSTGRES_BACKUP_PLAN.md#34-iam-policy-update).

#### 6.4 Apply the 30-day lifecycle rule on `db/` prefix

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

#### 6.5 Run the dump once manually + verify end-to-end

```bash
sudo -u ubuntu bash /home/ubuntu/ea-sys/scripts/dr-pg-dump.sh
# Watch the structured JSON log lines fly by — expect a final
# {"msg":"dr-pg-dump:ok ..."} line.

# Confirm the object landed in Singapore:
aws s3 ls s3://ea-sys-dr-singapore/db/ --recursive \
  --region ap-southeast-1 | tail -3

# Run the restore drill to prove the dump is actually restorable:
bash /home/ubuntu/ea-sys/scripts/dr-restore-drill.sh
# Expect: "✓ DR RESTORE DRILL PASSED" at the bottom.
```

#### 6.6 Install the cron line

```bash
sudo -u ubuntu crontab -e
# Append:
# Postgres dump to Singapore DR bucket — ≤2h RPO Dubai daytime, ≤4h overnight
0 2,4,6,8,10,12,14,16,18,22 * * * /home/ubuntu/ea-sys/scripts/dr-pg-dump.sh >> /home/ubuntu/cron-dr-db-backup.log 2>&1
```

**Timing** (as of 2026-06-30): `0 2,4,6,8,10,12,14,16,18,22 * * *` UTC — every 2h
during Dubai daytime (08:00–22:00 GST → 04:00–18:00 UTC) and every 4h overnight,
so **≤2h RPO in the day, ≤4h at night** (10 dumps/day, ~1.2 MB each — negligible
load, all inside the S3 30-day retention). To change RPO, edit the cron hours;
the script is unchanged. (History: 24h once-daily → 12h `0 11,23` → this.)

#### 6.7 Verify the next two scheduled runs

```bash
# After 23:00 UTC tonight, a new dump should appear:
aws s3 ls s3://ea-sys-dr-singapore/db/ --recursive \
  --region ap-southeast-1 | tail -5

# Check the log file for any error lines:
sudo -u ubuntu tail -50 /home/ubuntu/cron-dr-db-backup.log
```

If a run silently failed, the SES email should have arrived in
`krishna@meetingmindsdubai.com` (check spam folder for the first one;
auto-whitelist after).

#### 6.8 Calendar entry — quarterly restore drill

15th of every quarter (Jul, Oct, Jan, Apr) run:
```bash
bash /home/ubuntu/ea-sys/scripts/dr-restore-drill.sh
```
Takes ~3-5 min. Either passes cleanly or surfaces drift between the
dump format and the restore process before a real disaster needs it.

## Monthly drill (15th of each month, 5 min)

Validates that the bootstrap still works before you actually need it.

```bash
cd infra/dr
terraform init    # first time only
terraform apply -auto-approve

# Wait ~7 min total (4 min provisioning + 3 min user-data). Tail the log:
aws ssm start-session --target $(terraform output -raw instance_id) --region ap-southeast-1
# Inside the session:
sudo tail -f /var/log/ea-sys-bootstrap.log
# Expect: [bootstrap] complete

# Validate the app is serving
curl -kI "https://$(terraform output -raw public_ip)/api/health"
# Expect: HTTP/2 200  + body says database: connected

# Tear down
terraform destroy -auto-approve
```

If the drill fails, **do not destroy** — debug first. This is exactly the
moment you want to find problems, not during a real outage.

## Surgical recovery — Mumbai is up, you lost specific files

For the small-blast-radius incidents that don't need a full failover:
someone `rm`'d the wrong directory, a deploy script clobbered `.env`, an
operator overwrote a cert background on the wrong template. Mumbai is
still serving traffic — you just need to pull specific objects back from
the bucket. Faster than terraform-applying the Singapore box.

All commands run on the Mumbai box (`aws ssm start-session --target
i-0b51ab1213d084640 --region ap-south-1`). All start with `sudo -u
ubuntu` so the IAM instance-role credentials are picked up regardless
of who you're logged in as.

### A. Lost the uploads directory (or part of it)

The full mirror, newest-wins. Use `--dryrun` to preview before letting it
overwrite anything currently on disk.

```bash
sudo -u ubuntu aws s3 sync \
  s3://ea-sys-dr-singapore/uploads/ \
  /home/ubuntu/ea-sys/public/uploads/ \
  --region ap-southeast-1 \
  --exclude "*/.gitkeep" \
  --dryrun

# Drop --dryrun once the plan looks right.
```

**RPO**: up to 60 min back (one cron tick). Anything uploaded since the
last hour's sync is not in the bucket.

### B. Lost or corrupted `.env`

Daily snapshots are keyed by date (`env/2026-06-03.env`). Pull the most
recent and re-deploy so the containers re-read it.

```bash
# List recent snapshots, newest last:
sudo -u ubuntu aws s3 ls s3://ea-sys-dr-singapore/env/ \
  --region ap-southeast-1 | sort -k1,2 | tail -5

# Restore the latest:
LATEST=$(sudo -u ubuntu aws s3 ls s3://ea-sys-dr-singapore/env/ \
  --region ap-southeast-1 | sort -k1,2 | tail -1 | awk '{print $4}')
sudo -u ubuntu aws s3 cp \
  "s3://ea-sys-dr-singapore/env/$LATEST" \
  /home/ubuntu/ea-sys/.env \
  --region ap-southeast-1

# Re-deploy — docker compose only re-reads env_file on container create:
sudo -u ubuntu bash /home/ubuntu/ea-sys/scripts/deploy.sh
```

**RPO**: up to 24 hours. If you added a secret today and lost the file
before the 21:00 UTC snapshot, that secret is gone and has to be
re-added by hand (and the .env re-snapshotted manually with `aws s3 cp
.env s3://ea-sys-dr-singapore/env/$(date -u +%F).env --region
ap-southeast-1` to lock it in).

### C. Lost a specific object (one cert background, one photo, one .docx)

Cheaper than the full sync when you know exactly what's missing — and
safer, because it can't accidentally overwrite anything else.

```bash
# Locate it in the bucket (use the same path it had on disk):
sudo -u ubuntu aws s3 ls \
  s3://ea-sys-dr-singapore/uploads/certificates/{eventId}/ \
  --region ap-southeast-1 --recursive

# Pull just that one back:
sudo -u ubuntu aws s3 cp \
  s3://ea-sys-dr-singapore/uploads/certificates/{eventId}/{uuid}.pdf \
  /home/ubuntu/ea-sys/public/uploads/certificates/{eventId}/{uuid}.pdf \
  --region ap-southeast-1
```

Common paths:
- Cert backgrounds — `uploads/certificates/{eventId}/{uuid}.pdf`
- Issued cert PDFs — `uploads/certificates/issued/{runId}/{certId}.pdf`
- Speaker agreements — `uploads/agreements/{eventId}/{uuid}.docx`
- Attendee/speaker photos — `uploads/photos/{YYYY}/{MM}/{uuid}.jpg`
- Org media — `uploads/media/{YYYY}/{MM}/{uuid}.{ext}`

### D. Restore a previous version of a file (object overwritten today, want yesterday's)

The bucket has versioning enabled (§1 setup). Every overwrite keeps the
prior version retrievable by version-id — useful when an operator
uploaded the wrong cert background or a typo'd `.env` got snapshotted.

```bash
# List every version of the specific key, newest first:
sudo -u ubuntu aws s3api list-object-versions \
  --bucket ea-sys-dr-singapore \
  --prefix uploads/certificates/{eventId}/bg.pdf \
  --region ap-southeast-1 \
  --query 'Versions[].[VersionId,LastModified,Size]' \
  --output table

# Pick a VersionId from the table above and restore it as the current
# version (server-side copy — doesn't transit your laptop):
sudo -u ubuntu aws s3api copy-object \
  --bucket ea-sys-dr-singapore \
  --copy-source 'ea-sys-dr-singapore/uploads/certificates/{eventId}/bg.pdf?versionId=<OLD-VID>' \
  --key uploads/certificates/{eventId}/bg.pdf \
  --region ap-southeast-1

# Then sync that path back to Mumbai (see A or C above).
```

### E. Restore the database (or one table) from a `pg_dump`

> **Full DB-loss failover?** For the complete "Supabase is gone, stand the DB up
> elsewhere and point the app at it" runbooks, use the two cold-standby docs (each
> self-contained, follow top-to-bottom in an incident):
> - **[COLD_STANDBY_RDS.md](COLD_STANDBY_RDS.md)** — restore into AWS RDS PG17 (vendor independence; both URLs → `:5432`).
> - **[COLD_STANDBY_SUPABASE.md](COLD_STANDBY_SUPABASE.md)** — restore into a fresh Supabase project (lowest-friction URL swap).
>
> The steps below are for *surgical* DB recovery (one table / a quick local restore).

The twice-daily Postgres backup writes `*.dump` files to
`s3://ea-sys-dr-singapore/db/{YYYY}/{MM}/{DD-HH}-mumbai.dump`. Each
file is a `pg_dump -Fc --schema=public` (custom format, application
schema only) — compressed, restorable as a whole or one table at a
time, and portable to any vanilla PG 17 cluster (RDS, Crunchy, a new
Supabase project, the local Docker drill).

The dump intentionally excludes Supabase platform schemas (`auth`,
`storage`, `realtime`, `graphql_public`, `vault`, `pgsodium`,
`_realtime`, `extensions`) — EA-SYS uses none of those features
(NextAuth not Supabase Auth, `STORAGE_PROVIDER=local` not Supabase
Storage, no Realtime/GraphQL/Vault). Restoring to a new Supabase
project is still the recommended DR target: Supabase recreates the
platform schemas at project creation and our `public` dump layers on
top.

Two scenarios — full DB rebuild vs surgical row/table recovery:

#### Full DB rebuild (Supabase data loss, fresh target)

```bash
# 1. Locate the dump you want (newest by default):
aws s3 ls s3://ea-sys-dr-singapore/db/ --recursive --region ap-southeast-1 \
  | sort -k1,2 | tail -5

# 2. Pull it locally or to a scratch box:
LATEST=$(aws s3 ls s3://ea-sys-dr-singapore/db/ --recursive --region ap-southeast-1 \
  | sort -k1,2 | tail -1 | awk '{print $4}')
aws s3 cp "s3://ea-sys-dr-singapore/${LATEST}" /tmp/restore.dump --region ap-southeast-1

# 3. Restore into a NEW Supabase project (or any PG 17+ cluster):
PG_DSN="postgresql://postgres:PASSWORD@NEW-DB-HOST:5432/postgres"
pg_restore --no-owner --no-acl --jobs=4 -d "${PG_DSN}" /tmp/restore.dump

# 4. Update .env DATABASE_URL + DIRECT_URL on Mumbai box, redeploy:
sudo -u ubuntu vim /home/ubuntu/ea-sys/.env
sudo -u ubuntu bash /home/ubuntu/ea-sys/scripts/deploy.sh
```

**RPO**: ≤2h during Dubai daytime (08:00–22:00 GST), ≤4h overnight (the time
between the disaster and the last scheduled dump).

#### Surgical: restore just one table

```bash
# Same first two steps as above, then restore a specific table only.
# Useful when you accidentally dropped or corrupted one table and
# everything else is fine.
PG_DSN="postgresql://postgres:PASS@SCRATCH-HOST:5432/postgres"
pg_restore --no-owner --no-acl -t "Registration" -d "${PG_DSN}" /tmp/restore.dump
```

#### Surgical: extract specific rows without touching prod

When the disaster is "operator deleted 3 specific registrations" rather
than a whole-table loss, restore the dump to a scratch DB and SELECT
from it — then re-insert into prod via a small SQL patch.

```bash
# Stand up a scratch PG 17 in Docker (same as the restore drill does):
docker run --rm -d --name pg-scratch -e POSTGRES_PASSWORD=temp \
  -p 55432:5432 postgres:17
sleep 5

# Restore into it:
PGPASSWORD=temp pg_restore -h localhost -p 55432 -U postgres -d postgres \
  --no-owner --no-acl --jobs=4 /tmp/restore.dump

# Query for the rows you need:
PGPASSWORD=temp psql -h localhost -p 55432 -U postgres -d postgres \
  -c 'SELECT * FROM "Registration" WHERE id IN (...)'

# Generate INSERT statements and apply to prod manually.
docker stop pg-scratch
```

The `scripts/dr-restore-drill.sh` script exercises exactly this scratch-
DB flow each quarter to keep it warm — copy its approach when needed.

### What S3 does NOT cover

For honesty:

- **Uploads written between the last cron tick and the disaster** — up
  to 60 min of `public/uploads/` is not in the bucket yet. Tighten the
  cron to `*/5 * * * *` if that's too loose for your event flow.
- **`.env` changes made today before 21:00 UTC** — same idea, 24h RPO.
  Run `aws s3 cp .env s3://ea-sys-dr-singapore/env/$(date -u +%F).env
  --region ap-southeast-1` immediately after rotating a secret to
  tighten that RPO ad-hoc.
- **Postgres changes between the last scheduled dump and the disaster** —
  ≤2h during Dubai daytime, ≤4h overnight (`0 2,4,6,8,10,12,14,16,18,22 * * *`).
  For tighter precision, add more cron entries (same script, no other changes) —
  or enable Supabase PITR (~$25-50/mo, seconds-precision rollback within 7d
  retention).
  Trade-off documented in [POSTGRES_BACKUP_PLAN.md §1](POSTGRES_BACKUP_PLAN.md#decisions-locked-in-2026-06-03).

## Promotion runbook (real outage, Mumbai down)

1. **Confirm Mumbai is really down.**
   - AWS Health Dashboard for `ap-south-1`.
   - `aws ssm start-session --target <mumbai-id> --region ap-south-1` times out or errors.

2. **Provision the DR box.**
   ```bash
   cd infra/dr
   terraform apply -auto-approve
   # Takes ~7 min.
   ```

3. **Copy the new public IP.**
   ```bash
   terraform output public_ip
   ```

4. **Update DNS at the registrar.**
   - At your domain registrar (GoDaddy/etc.) → DNS → `events` A record → replace value with the new IP.
   - TTL is usually 1 hour; lower it to 60 seconds before a known-risky change for faster failover.
   - DNS points **directly** at the box's EIP (no CDN/proxy in front, matching prod).

5. **Verify traffic is serving.**
   ```bash
   curl -I https://events.meetingmindsgroup.com/api/health
   # Expect: 200, database: connected
   ```
   Confirm the new IP is resolving (`dig +short events.meetingmindsgroup.com`).

6. **Issue a proper TLS cert** (the bootstrap uses a self-signed cert for the
   break-glass window — browsers warn until this runs, so swap ASAP):
   ```bash
   aws ssm start-session --target $(terraform output -raw instance_id) --region ap-southeast-1
   sudo certbot --nginx -d events.meetingmindsgroup.com \
     --non-interactive --agree-tos -m <your-email>
   ```

7. **Monitor for 15 min.** Check `/api/health`, /logs viewer, Sentry.

## Post-incident: returning to Mumbai

1. Mumbai region is healthy again and your Mumbai box either recovered or
   was rebuilt from the Mumbai EBS snapshot.
2. **Before flipping DNS back**, sync any uploads that happened on the
   Singapore DR box back to the S3 bucket so Mumbai can restore them:
   ```bash
   # On the DR box (via SSM):
   aws s3 sync /home/ubuntu/ea-sys/public/uploads/ \
     s3://ea-sys-dr-singapore/uploads/ --region ap-southeast-1
   ```
   Then on Mumbai, pull them down:
   ```bash
   aws s3 sync s3://ea-sys-dr-singapore/uploads/ \
     /home/ubuntu/ea-sys/public/uploads/ --region ap-southeast-1
   ```
3. **Registrar DNS** → `events` A record → point back at the Mumbai EIP.
4. Verify: `curl -I https://events.meetingmindsgroup.com/api/health` returns
   200 with `database: connected`.
5. `cd infra/dr && terraform destroy -auto-approve` — kills the Singapore box.
   (Don't destroy before step 2, or fresh uploads written during the outage
   are gone.)

## Known gaps

- **ECR is Mumbai-only (deploy image registry, added 2026-07-01).** The app now
  deploys as pre-built images from ECR (`…/ea-sys`) — great for a **box-only**
  rebuild (a replacement box pulls in ~1–2 min vs an ~8-min on-box build). But
  ECR lives in `ap-south-1`, so a **full-Mumbai-region loss** takes it down too,
  and a Singapore recovery box can't pull. **Fix:** enable ECR **cross-region
  replication → `ap-southeast-1`** (this bucket's region) so images exist in both.
  Tracked in [ROADMAP.md](../../docs/ROADMAP.md). NOTE: the CI→ECR cutover is
  **complete** (Step 1 + Step 2 shipped 2026-07-01) — deploys now pull from ECR,
  but `scripts/deploy.sh` still falls back to an **on-box build from the GitHub
  checkout** if the pull fails, so a box-only recovery isn't blocked even if ECR
  is briefly unreachable. For a full-region loss, either enable cross-region
  replication (above) or let the Singapore box use that on-box-build fallback.
- **Uploads written during the outage window itself are at risk.** The normal
  flow is Mumbai hourly sync → S3 bucket → DR box pulls on boot. During an
  outage, Mumbai's cron can't run. Uploads that happen *on the DR box* during
  the outage live on its ephemeral EBS volume until step 2 of the post-incident
  runbook above sends them back. If you skip that step or `terraform destroy`
  before syncing, those outage-window uploads are lost. Future fix: a reverse
  cron on the DR box that periodically pushes `public/uploads/` back to S3.
- **Postgres data — ≤2h RPO (Dubai day) / ≤4h (overnight)** via the
  `0 2,4,6,8,10,12,14,16,18,22 * * *` `pg_dump` to Singapore (§6 /
  [POSTGRES_BACKUP_PLAN.md](POSTGRES_BACKUP_PLAN.md)). Truly-zero RPO would need
  Supabase PITR (~$25-50/mo). Not enabled today by explicit trade-off — the
  frequent cron + daily Supabase platform backup is sufficient for the stated
  tolerance (and Stripe is the payment system-of-record, so payment data isn't
  at risk in the window).
- **Supabase compute downtime.** If Supabase itself is unreachable (vs
  data-lost), the Singapore DR box still can't serve. Fail-over here
  means restoring the latest `pg_dump` to a NEW Supabase project + DNS
  swap on the DB URL. See [Surgical Recovery §E](#e-restore-the-database-or-one-table-from-a-pg_dump).
- **10-minute RTO includes a Docker build.** `scripts/deploy.sh` does
  `docker compose build` on first run. If the build time balloons, the
  RTO balloons with it.

## Cost estimate

When destroyed (99%+ of the time):
- S3 `.env` versions: pennies/month
- KMS key: $1/mo
- **Total: ~$1/mo**

When provisioned (during an outage):
- t3.large in Singapore: ~$0.09/hr
- EIP (while attached): free
- **Total: ~$2/day while running**
