# Cold-Standby Failover — restore into AWS RDS PostgreSQL

**Use this when:** Supabase (the primary DB) is lost or unusable and you want to
fail EA-SYS over to a Postgres database **you run in AWS** (vendor independence).

**Model:** *cold* standby. Nothing is running or replicating ahead of time — the
source of truth is the twice-daily `pg_dump` in `s3://ea-sys-dr-singapore/db/`.
At failover you provision (or start) an RDS instance, restore the latest dump,
point the app at it by swapping two env vars, and redeploy.

| | |
|---|---|
| **RPO** | ≤ 12h (last `0 11,23 UTC` dump before the disaster) |
| **RTO** | ~20–40 min provision-at-failover · ~5–10 min if an idle RDS is pre-provisioned |
| **Data loss** | everything written to Supabase after the last dump |

> The companion path — restore into a **fresh Supabase project** (lower-friction
> URL swap, stays on Supabase) — is [COLD_STANDBY_SUPABASE.md](COLD_STANDBY_SUPABASE.md).
> Both use the **same dump**; only the target differs.

---

## 0. Pre-verified facts (why this restores cleanly)

- The dump is `pg_dump -Fc --schema=public --no-owner --no-acl` → portable to **any
  vanilla Postgres 17**. (See [POSTGRES_BACKUP_PLAN.md](POSTGRES_BACKUP_PLAN.md).)
- **No extension prerequisites.** Migrations contain no `CREATE EXTENSION`; nothing
  is declared in `schema.prisma`; IDs are app-generated `cuid()`, not DB
  `gen_random_uuid`. So a stock RDS PG17 needs nothing extra installed.
- `pg_dump -Fc` captures sequence values, so **no manual sequence reset** is needed.
- The Mumbai EC2 box already has `postgresql-client-17` (installed by the dump
  script) and an instance role that can **read + KMS-decrypt** the dump from S3.
  **Run the restore from the EC2 box** — it has the client, the S3/KMS access, and
  network reach.

---

## 1. Provision the RDS target  *(AWS mutation — operator runs)*

This environment's real values (Mumbai box `i-0b51ab1213d084640`, verified
2026-06-30) are filled in below — confirm they're still current before relying on
them:

| | |
|---|---|
| VPC | `vpc-0f8a4d20e13457084` |
| EC2 box security group | `sg-01da66338a3c4ce46` (`launch-wizard-1`) |
| Subnets (3 AZs) | `subnet-0ddadf4a664591a2a` (1b), `subnet-012fecc6d3797c847` (1a), `subnet-0fd4e70230c0912c9` (1c) |
| Engine version | PostgreSQL `17.10` (any 17.x) |

Pick **either** path below — Console (1A) or CLI (1B). They produce the same thing.

### 1A. Console (recommended)

Region in the console = **Asia Pacific (Mumbai) ap-south-1** for every step.

**Step 1 — Security group** (EC2 console → Security Groups → Create security group)
- **Name** `ea-sys-standby-rds` · **Description** `EA-SYS standby RDS` · **VPC** `vpc-0f8a4d20e13457084`
- **Inbound → Add rule:** Type `PostgreSQL` (port 5432 auto-fills); **Source** Custom → `sg-01da66338a3c4ce46` (`launch-wizard-1`)
- Create.

**Step 2 — DB subnet group** (RDS console → Subnet groups → Create DB subnet group)
- **Name** `ea-sys-standby-subnets` · **Description** `EA-SYS standby` · **VPC** `vpc-0f8a4d20e13457084`
- **Add subnets:** AZs `ap-south-1a/1b/1c`; subnets `subnet-012fecc6d3797c847`, `subnet-0ddadf4a664591a2a`, `subnet-0fd4e70230c0912c9`
- Create.

**Step 3 — Create database** (RDS console → Databases → Create database)
- Method `Standard create` · Engine `PostgreSQL` · Version `17.10` · Template `Dev/Test` · `Single DB instance`
- **Settings:** DB instance identifier `ea-sys-standby`; Master username `easys`; Credentials `Self managed` → strong master password (save it)
- **Instance:** Burstable → `db.t4g.micro`
- **Storage:** `gp3`, `20` GiB, Encryption ✅ (default `aws/rds` key)
- **Connectivity:** Don't connect to an EC2 compute resource; VPC `vpc-0f8a4d20e13457084`; DB subnet group `ea-sys-standby-subnets`; Public access **No**; VPC security group → Choose existing → add `ea-sys-standby-rds`, remove `default`
- **Additional config:** Initial database name `easys`; Backup retention `7 days`
- Create → wait until **Available** → open `ea-sys-standby` → **Connectivity & security** → copy the **Endpoint**.

> Shortcut: in Step 3 Connectivity you can instead pick **"Connect to an EC2 compute
> resource"** → instance `i-0b51ab1213d084640`, and RDS auto-creates the SG rule
> (skip Step 1). Step 1 is kept explicit so the rule is named + visible.

### 1B. CLI (alternative — run from your Mac)

```bash
RDS_PASS='<generate-a-strong-password>'   # store it; goes into .env later

# DB subnet group (needs >=2 AZs)
aws rds create-db-subnet-group --region ap-south-1 \
  --db-subnet-group-name ea-sys-standby-subnets \
  --db-subnet-group-description "EA-SYS standby" \
  --subnet-ids subnet-0ddadf4a664591a2a subnet-012fecc6d3797c847 subnet-0fd4e70230c0912c9

# SG: Postgres only from the EC2 box's SG
RDS_SG=$(aws ec2 create-security-group --region ap-south-1 \
  --group-name ea-sys-standby-rds --description "EA-SYS standby RDS" \
  --vpc-id vpc-0f8a4d20e13457084 --query GroupId --output text)
aws ec2 authorize-security-group-ingress --region ap-south-1 \
  --group-id "$RDS_SG" --protocol tcp --port 5432 --source-group sg-01da66338a3c4ce46

# Instance (PG17, encrypted, private)
aws rds create-db-instance --region ap-south-1 \
  --db-instance-identifier ea-sys-standby \
  --engine postgres --engine-version 17.10 \
  --db-instance-class db.t4g.micro \
  --allocated-storage 20 --storage-type gp3 --storage-encrypted \
  --master-username easys --master-user-password "$RDS_PASS" \
  --db-name easys \
  --vpc-security-group-ids "$RDS_SG" \
  --db-subnet-group-name ea-sys-standby-subnets \
  --no-publicly-accessible --backup-retention-period 7

# Wait + endpoint
aws rds wait db-instance-available --region ap-south-1 --db-instance-identifier ea-sys-standby
aws rds describe-db-instances --region ap-south-1 --db-instance-identifier ea-sys-standby \
  --query 'DBInstances[0].Endpoint.Address' --output text
```

Connection string you'll use (note `sslmode=require` — RDS forces TLS):
```
postgresql://easys:<RDS_PASS>@<rds-endpoint>:5432/easys?sslmode=require
```

> **Same VPC + private** is the simplest secure shape: the EC2 box reaches RDS over
> the VPC, nothing is internet-exposed.

---

## 2. Find + download the latest dump  *(on the EC2 box)*

```bash
ssh / SSM into i-0b51ab1213d084640, then as ubuntu:

# Latest dump key (objects sort lexically; newest is last)
LATEST=$(aws s3 ls s3://ea-sys-dr-singapore/db/ --recursive --region ap-southeast-1 \
  | sort | tail -1 | awk '{print $4}')
echo "Restoring from: $LATEST"

aws s3 cp "s3://ea-sys-dr-singapore/$LATEST" /tmp/restore.dump --region ap-southeast-1

# Sanity: peek inside without applying (lists every object in the dump)
pg_restore -l /tmp/restore.dump | head
```

---

## 3. Prepare the target schema

The dump contains its own `CREATE SCHEMA public`, and RDS auto-creates an empty
`public` at init — restoring straight in collides on the first statement. Reset
`public` first (this is exactly what the restore drill does):

```bash
RDS_URL='postgresql://easys:<RDS_PASS>@<rds-endpoint>:5432/easys?sslmode=require'

psql "$RDS_URL" -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
```

---

## 4. Restore

```bash
pg_restore --no-owner --no-acl --exit-on-error \
  --dbname "$RDS_URL" /tmp/restore.dump

# spot-check row counts
psql "$RDS_URL" -c 'SELECT
  (SELECT count(*) FROM "Event")        AS events,
  (SELECT count(*) FROM "Registration") AS registrations,
  (SELECT count(*) FROM "Payment")      AS payments;'

rm -f /tmp/restore.dump
```

If `pg_restore` reports errors other than benign "already exists" noise, **stop**
and investigate before pointing the app at it.

---

## 5. Point the app at RDS  *(on the EC2 box, as ubuntu)*

Edit `/home/ubuntu/ea-sys/.env`. RDS has **no built-in pooler**, so point **both**
URLs at the RDS endpoint (`:5432`). Keep the existing pool tuning query params.

```bash
cp /home/ubuntu/ea-sys/.env /home/ubuntu/ea-sys/.env.pre-failover.$(date -u +%F-%H%M)

# Both URLs → RDS. (Was: DATABASE_URL=pooler:6543, DIRECT_URL=direct:5432 on Supabase.)
DATABASE_URL=postgresql://easys:<RDS_PASS>@<rds-endpoint>:5432/easys?sslmode=require&connection_limit=10&pool_timeout=15
DIRECT_URL=postgresql://easys:<RDS_PASS>@<rds-endpoint>:5432/easys?sslmode=require
```

Then **redeploy** — `docker compose restart` does NOT re-read `env_file`, so use the
deploy script (it recreates the web + worker containers, both of which read the
same `.env`):

```bash
cd /home/ubuntu/ea-sys && bash scripts/deploy.sh
```

> **Optional, recommended:** put RDS Proxy in front and use **its** endpoint for
> `DATABASE_URL` (pooled) while `DIRECT_URL` stays the raw `:5432`. This restores
> the Supabase-like pooler/direct split and protects RDS from connection storms.
> Not required for a small instance with `connection_limit=10`.

---

## 6. Apply any newer migrations

If the dump predates the currently-deployed code (a migration shipped after the
last dump), bring the restored DB up to schema:

```bash
cd /home/ubuntu/ea-sys
docker compose exec web npx prisma migrate deploy   # or run from the host with DIRECT_URL set
```

(If schema and dump match, this is a no-op.)

---

## 7. Verify

- `https://events.meetingmindsgroup.com` loads; log in.
- Open an event → registrations list renders with real data.
- `/worker/health` and `/api/health` return 200.
- `/logs` (source = database) shows no DB connection errors after the swap.
- Do one harmless write (e.g. edit a test registration's notes) to confirm writes land.
- **Console cross-check:** RDS → `ea-sys-standby` → **Monitoring** → *DatabaseConnections*
  climbs once the app cuts over — a quick visual confirmation the swap took effect.

---

## 8. Failback (return to Supabase) — avoid split-brain

Once Supabase is healthy again, **do not write to both**. Pick the current
primary (RDS) as source of truth, then:

1. Quiesce: put the app in maintenance / accept a brief window of no writes.
2. `pg_dump -Fc --schema=public --no-owner --no-acl "$RDS_URL" -f /tmp/failback.dump`
3. On the restored/replacement Supabase project: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` then `pg_restore` the failback dump (use the Supabase **DIRECT_URL**).
4. Restore `/home/ubuntu/ea-sys/.env` from `.env.pre-failover.*` (or set the new Supabase URLs), `bash scripts/deploy.sh`, `prisma migrate deploy`, verify (§7).
5. Stop/delete the standby RDS to stop the bill (`aws rds delete-db-instance --db-instance-identifier ea-sys-standby --skip-final-snapshot` — or keep a final snapshot).

---

## 9. Gotchas

- **`sslmode=require` is mandatory on RDS.** Without it Prisma/`psql` fail to
  connect. If TLS verification complains, `sslmode=require` (encrypt, don't verify
  CA) is acceptable inside the VPC; use `verify-full` + the RDS CA bundle if you
  want full verification.
- **Both URLs at `:5432` on RDS** (no pooler) unless you add RDS Proxy. Don't copy
  the Supabase `:6543` pooler port — RDS doesn't have it.
- **`scripts/deploy.sh`, not `docker compose restart`** — the latter doesn't
  re-read `env_file`, so the DB swap wouldn't take effect.
- **The worker container** reads the same `.env`, so it fails over automatically on
  the same deploy. Nothing extra to do.
- **Idle-RDS variant:** to cut RTO, keep this RDS running and `pg_restore` the
  latest dump into it on a schedule (e.g. nightly). Then failover is just §5 +
  §7. Costs ~$12–15/mo for `db.t4g.micro`. Everything else in this runbook is
  identical.
- **KMS:** reading the dump needs `kms:Decrypt` on the DR key — the EC2 instance
  role already has it (`DRBackupToSingapore` policy). Running the restore from
  your Mac instead would need that grant on your user.
