# Cold-Standby Failover — restore into a fresh Supabase project

**Use this when:** the primary Supabase project is lost, corrupted, or unusable
(deleted, region outage, bad migration, billing lockout) and you want EA-SYS back
up **on Supabase** with the least friction.

**Model:** *cold* standby. Nothing runs ahead of time — the source of truth is the
twice-daily `pg_dump` in `s3://ea-sys-dr-singapore/db/`. At failover you create a
new Supabase project, restore the latest dump, swap two env vars, and redeploy.

| | |
|---|---|
| **RPO** | ≤ 12h (last `0 11,23 UTC` dump before the disaster) |
| **RTO** | ~15–30 min (Supabase project creation + restore + deploy) |
| **Data loss** | everything written after the last dump |

> **Why this path is the lowest-friction swap:** a Supabase project hands you a
> `DATABASE_URL` (pooler, `:6543`) and a `DIRECT_URL` (direct, `:5432`) whose
> **shapes match our `.env` exactly** — failover is a near-literal two-line swap, no
> pooling decision to make. The AWS-RDS alternative (vendor independence, both URLs
> at `:5432`) is [COLD_STANDBY_RDS.md](COLD_STANDBY_RDS.md). Same dump, different target.

---

## 0. Pre-verified facts (why this restores cleanly)

- The dump is `pg_dump -Fc --schema=public --no-owner --no-acl` — **only our app
  schema**, deliberately excluding Supabase platform schemas (`auth`, `storage`,
  `vault`, …). A new Supabase project recreates those platform schemas itself on
  creation; our `public` dump layers on top. (See [POSTGRES_BACKUP_PLAN.md](POSTGRES_BACKUP_PLAN.md).)
- **No extension prerequisites** (no `CREATE EXTENSION` in migrations, IDs are
  `cuid()`), so the restore doesn't depend on anything the new project must add.
- `pg_dump -Fc` captures sequence values — **no manual sequence reset**.
- EA-SYS uses **none** of Supabase's platform features (NextAuth not Supabase Auth,
  `STORAGE_PROVIDER=local` not Supabase Storage, no Realtime/PostgREST/Vault), so
  there is nothing to reconfigure on the platform side beyond the DB itself.
- **Run the restore from the Mumbai EC2 box** — it has `postgresql-client-17` and
  S3/KMS read access to the dump.

---

## 1. Create the new Supabase project  *(operator, in the Supabase dashboard)*

1. Supabase dashboard → **New project** (same org). Pick a region (Singapore
   `ap-southeast-1` or Mumbai `ap-south-1` — closest to the EC2 box for latency).
2. Set a strong database password (you'll need it for the connection strings).
3. Wait for it to provision (~2 min).
4. Project → **Settings → Database → Connection string** — copy both:
   - **Pooler / Transaction** (host `...pooler.supabase.com`, port `6543`) → this becomes `DATABASE_URL`
   - **Direct** (port `5432`) → this becomes `DIRECT_URL`

Hold onto both. The restore uses the **DIRECT** one (pg_restore needs a session
connection; the transaction pooler doesn't support the commands it issues).

---

## 2. Find + download the latest dump  *(on the EC2 box)*

```bash
SSM / ssh into i-0b51ab1213d084640, then as ubuntu:

LATEST=$(aws s3 ls s3://ea-sys-dr-singapore/db/ --recursive --region ap-southeast-1 \
  | sort | tail -1 | awk '{print $4}')
echo "Restoring from: $LATEST"

aws s3 cp "s3://ea-sys-dr-singapore/$LATEST" /tmp/restore.dump --region ap-southeast-1
pg_restore -l /tmp/restore.dump | head      # peek inside, don't apply
```

---

## 3. Prepare the target schema

The dump carries its own `CREATE SCHEMA public`, and the new project already has an
empty `public` → reset it first to avoid a first-statement collision:

```bash
NEW_DIRECT='postgresql://postgres:<NEW_DB_PASS>@db.<ref>.supabase.co:5432/postgres'

psql "$NEW_DIRECT" -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
```

> Note: this drops the project's default `public` grants. EA-SYS connects as the
> `postgres`/service role and uses no PostREST/anon access, so that's fine. If you
> ever *did* use the Supabase data API you'd re-run the default grants
> (`GRANT USAGE ON SCHEMA public TO anon, authenticated;` etc.) — not needed here.

---

## 4. Restore

```bash
pg_restore --no-owner --no-acl --exit-on-error \
  --dbname "$NEW_DIRECT" /tmp/restore.dump

psql "$NEW_DIRECT" -c 'SELECT
  (SELECT count(*) FROM "Event")        AS events,
  (SELECT count(*) FROM "Registration") AS registrations,
  (SELECT count(*) FROM "Payment")      AS payments;'

rm -f /tmp/restore.dump
```

Errors beyond benign "already exists" noise → stop and investigate before cutting over.

---

## 5. Point the app at the new project  *(on the EC2 box, as ubuntu)*

Edit `/home/ubuntu/ea-sys/.env`. The shapes match the old values exactly — pooler →
`DATABASE_URL`, direct → `DIRECT_URL`. Keep the existing pool query params.

```bash
cp /home/ubuntu/ea-sys/.env /home/ubuntu/ea-sys/.env.pre-failover.$(date -u +%F-%H%M)

DATABASE_URL=postgresql://postgres.<ref>:<NEW_DB_PASS>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=10&pool_timeout=15
DIRECT_URL=postgresql://postgres:<NEW_DB_PASS>@db.<ref>.supabase.co:5432/postgres
```

> Copy the **exact** strings from the Supabase dashboard (the pooler username format
> `postgres.<ref>` and host differ slightly between Supabase generations) and append
> our pool params to `DATABASE_URL`. Keep `pgbouncer=true` on the pooler URL.

Redeploy (`docker compose restart` does **not** re-read `env_file`):

```bash
cd /home/ubuntu/ea-sys && bash scripts/deploy.sh
```

---

## 6. Apply any newer migrations

If code shipped a migration after the last dump:

```bash
cd /home/ubuntu/ea-sys
docker compose exec web npx prisma migrate deploy
```

(No-op if schema and dump already match.)

---

## 7. Verify

- Site loads + login works.
- An event's registrations list shows real data.
- `/api/health` and `/worker/health` return 200.
- `/logs` (database source) shows clean DB connections after the swap.
- One harmless write lands (edit a test registration's notes).
- **Re-point the DR dump cron's source** if the project ref changed: the dump
  script reads `DIRECT_URL` from `.env`, so once `.env` points at the new project
  the `0 11,23` dump backs up the *new* primary automatically — confirm the next
  tick's log line shows the expected size.

---

## 8. Failback / steady state

Restoring into a fresh Supabase project usually **is** the recovery — the new
project becomes the primary and you stay there; no failback needed. Just:

- Keep `.env.pre-failover.*` for the record.
- Delete the old broken project once you're confident (and after confirming the
  new one is being backed up by the next dump tick).
- If you only spun this up temporarily and intend to return to a *specific*
  recovered project, treat it like the RDS failback in
  [COLD_STANDBY_RDS.md](COLD_STANDBY_RDS.md) §8 (dump current → restore into the
  target → swap `.env` → deploy) to avoid split-brain.

---

## 9. Gotchas

- **Restore over the DIRECT (`:5432`) URL, never the pooler.** PgBouncer transaction
  mode rejects the session-level commands `pg_restore` issues.
- **Reset `public` first** (DROP/CREATE) or the restore collides on the dump's own
  `CREATE SCHEMA public`.
- **`scripts/deploy.sh`, not `docker compose restart`** — env_file isn't re-read by
  restart, so the swap wouldn't take effect. The worker container picks up the new
  DB on the same deploy.
- **The dump only contains `public`** — that's intentional and complete for EA-SYS.
  Don't try to restore Supabase platform schemas from it; the new project supplies
  its own.
- **KMS:** reading the dump needs `kms:Decrypt` on the DR key — the EC2 instance
  role already has it; running the restore from your Mac would need that grant on
  your user.
