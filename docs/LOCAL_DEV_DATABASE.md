# Local Development Database

How local development connects to Postgres, why it is isolated from production,
and the daily workflow. **Read this before running any `prisma` command locally.**

> **Why this exists.** On 2026-07-30 a local `prisma db push --force-reset` ran
> against the **production** database (a dev `.env` pointed `DIRECT_URL` at prod)
> and **wiped all of prod** — a SEV-1 data-loss outage recovered from a DR dump
> ([docs/INCIDENTS.md](INCIDENTS.md) INC-002). Local dev must never share the prod
> DB again. This setup is the fix.

---

## TL;DR

```bash
docker compose up -d postgres-prod-local   # start the local dev DB (persists)
npm run db:refresh                         # seed/refresh it from the latest live DR dump
npm run uploads:refresh                    # pull the FILES those rows point at
npm run dev                                 # app + Prisma use local automatically
```

Your `.env` / `.env.local` point at `localhost:54322`. A `prisma db push` /
`migrate reset` from your machine now hits **local** and is harmless. Prod is
reachable only, read-only, and on purpose, via `npm run prod:psql`.

---

## The database

| | |
|---|---|
| **Service** | `postgres-prod-local` in [docker-compose.yml](../docker-compose.yml) |
| **Container** | `ea-sys-prod-local` |
| **Image** | `postgres:17-alpine` — **17, not 16**, because the DR dumps are PG17 (`pg_restore` must be ≥ the dump version) |
| **Host port** | `localhost:54322` |
| **Database** | `ea_sys_prod_local` (user/pass `postgres` / `postgres`) |
| **Storage** | named volume `prod_local_pgdata` — **persists** across `docker compose down` / restarts |

It's a **persistent, 100%-local copy of prod data**. Distinct from the ephemeral,
profile-gated test DBs on the same box:

| DB | Port | Purpose | Persistent? |
|---|---|---|---|
| `ea-sys-prod-local` | 54322 | **daily dev** (this doc) | yes |
| `ea-sys-tenancy-db` (`tenancy`, `crm_test`) | 55432 | RLS harness + CRM integration tests | no (torn down after tests) |
| Homebrew Postgres (`ea_sys_test`) | 5432 | e2e (`test:e2e`) | yes |

---

## One-time setup (new machine)

1. **Docker** running, and **AWS credentials** with read on the DR bucket
   (`aws sts get-caller-identity` should work).
2. Start the DB and seed it:
   ```bash
   docker compose up -d postgres-prod-local
   npm run db:refresh
   ```
   `db:refresh` restores the **latest** Singapore DR dump and prints row counts
   (expect thousands of registrations, dozens of events).
3. **Point your env at local.** In BOTH `.env` and `.env.local` (the app reads
   `.env.local`; the **Prisma CLI reads `.env`** — both must agree):
   ```
   DATABASE_URL="postgresql://postgres:postgres@localhost:54322/ea_sys_prod_local"
   DIRECT_URL="postgresql://postgres:postgres@localhost:54322/ea_sys_prod_local"
   ```
   Leave `DATABASE_URL_TEST` (the Homebrew e2e DB) alone.
4. **Never** put the prod connection string in `.env` / `.env.local`. Prod creds
   live only in `.env.prod` (gitignored), read solely by `npm run prod:psql`.
5. Sanity check — this should say `localhost:54322`, not a Supabase host:
   ```bash
   npx prisma migrate status
   ```

---

## Daily workflow

```bash
docker compose up -d postgres-prod-local   # if not already running
npm run dev                                 # localhost:3113, on the local DB
npm run db:refresh                          # pull fresh prod-like data anytime
npm run db:migrate                          # apply new migrations to local (safe, additive)
npm run db:snapshot                         # bank the current state before anything risky
```

- **`npm run db:refresh`** ([scripts/dev-db-refresh.sh](../scripts/dev-db-refresh.sh))
  drops the local `public` schema and restores the newest DR dump. It's
  destructive to LOCAL only, and doubles as a DR restore drill. Refresh whenever
  you want current data or after schema changes land.
- **`npm run db:migrate`** = `prisma migrate deploy` — applies pending migrations
  to whatever `DATABASE_URL` points at (local). Not guarded (deploy is never
  destructive).

---

## Undo — local snapshots

```bash
npm run db:snapshot                        # bank the current local state
npm run db:snapshot -- --list              # what is on hand
npm run db:restore                         # roll back to the newest snapshot
npm run db:restore -- 20260826-141530.dump # or a specific one
```

`npm run db:push` takes one automatically. Take one by hand before anything you
are unsure about — that is the whole point, since the next footgun will not be
on any list.

Snapshots are `pg_dump -Fc` files in `.local-snapshots/` (gitignored — they hold
real attendee data). The newest 10 are kept and older ones pruned; each is about
a megabyte.

**Why this is not just `db:refresh`.** `db:refresh` rebuilds from the S3 DR dump,
so it gives you **prod's** state, not **yours** — every test registration and
half-finished scenario you were working through is gone. A snapshot is your
local state, and restoring is a file copy rather than a network round trip.

Two properties worth knowing, both pinned by tests:

- **`db:push` fails closed.** If the snapshot cannot be taken (container down,
  disk full) the push is refused rather than run without an undo point. A
  seatbelt that silently is not there on the one day you need it is worse than
  no seatbelt, because you drove differently believing in it.
  `SKIP_LOCAL_SNAPSHOT=1` overrides deliberately.
- **Restore snapshots first.** Restoring replaces whatever is in the database
  now, so picking the wrong file would otherwise be a second, unrecoverable
  mistake on top of the first. There is no way to lose data through these two
  scripts at all.

Both scripts address the container **by name** and never read `DATABASE_URL`.
That is the design, not an implementation detail: a script that read a URL could
be aimed at production by an environment variable (INC-002's exact shape), and
these structurally cannot be, so there is no check to write and nothing to get
wrong.

### `db:push` does not work here, and that is not your schema edit

```
Error: ERROR: relation "CertificateIssueRunItem_runId_registrationId_key" already exists
```

Migration `20260602100000` created that table's two recipient uniques as
**partial** indexes (`WHERE "registrationId" IS NOT NULL`). Prisma cannot express
a partial unique, so `schema.prisma` declares a plain `@@unique`, and the
July-22 chain-sync migration swaps partial→full **only when building a database
from scratch** — prod deliberately keeps the partial pair. Your local DB is a
restore of a prod dump, so it has the partial pair, and `prisma db push` will
always try to create the full index and collide on the name.

Use the flow CLAUDE.md already prescribes: hand-author the migration SQL (or
`prisma migrate dev --create-only`, which writes the file and never touches a
database), make it additive + idempotent, then `npm run db:migrate`.

`npm run db:reset` is refused outright — `prisma migrate reset` is the command
that wiped production, and locally it buys nothing `db:refresh` or `db:restore`
does not. Data-loss flags (`--accept-data-loss`, `--force-reset`) need an
explicit `LOCAL_DATA_LOSS_OK=1`.

---

## The uploaded files (they do NOT come with the dump)

`db:refresh` restores the **rows**. It does not bring the **files** those rows
point at, because uploads live on the box and in the DR bucket, never in git.

That gap is quiet and confusing: nothing errors, the app just renders a broken
image wherever an upload is referenced. Symptom seen Aug 7, 2026 — "the org
logo is missing everywhere" — where the row held
`/uploads/photos/2026/04/6e1b….png`, the file served 200 on production, and the
local checkout simply did not have it (24 files locally against ~500 in the
bucket). The same applies to event banners, speaker photos, certificate
backgrounds and generated agreements.

```bash
npm run uploads:refresh    # scripts/dev-uploads-refresh.sh
```

Read-only against AWS: it syncs `s3://ea-sys-dr-singapore/uploads/` into
`public/uploads/` (gitignored) and reports counts before and after, by category.
Deliberately **no `--delete`** — mirroring the hourly production sync, whose
non-deleting behaviour is what made [INC-004](INCIDENTS.md) recoverable. Re-runs
are cheap: a second run downloads nothing.

**As of Aug 7, 2026** the mirror holds **514 files / 64 MB**:

| Folder | Files | Size | What it is |
|---|---:|---:|---|
| `photos/` | 406 | 26M | org logo, event banners, attendee + speaker photos |
| `media/` | 58 | 21M | org media library (email + page images) |
| `certificates/` | 42 | 16M | background PDFs + issued certificates |
| `agreements/` | 4 | 324K | uploaded speaker-agreement templates + letterhead |
| `stripe-receipts/` | 2 | 88K | durable snapshots of Stripe's hosted receipts |
| `crm-deal-docs/` | 1 | 12K | CRM deal attachments |

Worth knowing what is NOT there: no `speaker-docs/` and no `reimbursements/`
directory exists in the bucket yet, so passport scans and bank details have not
been uploaded on production to date.

**Think before pulling everything.** This puts real attendee photos on your
laptop, and would put passport and bank documents there too once those folders
exist. It is proportionate on a machine you already trust with a production DB
dump; anywhere else, copy the one file you need instead:

```bash
aws s3 cp s3://ea-sys-dr-singapore/uploads/<path> public/uploads/<dir>/ --region ap-southeast-1
```

---

## The guards (why prod is safe now)

Three layers, so a mistake can't reach prod:

1. **Prod creds are not in the files Prisma auto-reads.** `.env` / `.env.local`
   point at local, so a bare `npx prisma db push --force-reset` hits the local
   DB. This is the primary protection.
2. **Runtime fail-fast** — [src/lib/db.ts](../src/lib/db.ts)
   `assertNotProdDbOutsideProduction()` throws at client creation if
   `DATABASE_URL`/`DIRECT_URL` resolve to the prod project ref **and**
   `NODE_ENV !== "production"`. Covers the app AND every `tsx` script that imports
   `db`. Inert on the box (`NODE_ENV=production`).
3. **npm preflight** — [scripts/db-local-op.sh](../scripts/db-local-op.sh) wraps
   `npm run db:push` / `npm run db:reset` and runs four gates in order: refuse a
   prod target ([guard-db-target.sh](../scripts/guard-db-target.sh)), refuse
   `migrate reset` outright, require `LOCAL_DATA_LOSS_OK=1` for a data-loss flag,
   then snapshot — failing closed if it cannot. The prod check is deliberately
   first: a prod target must be refused before anything else happens, including
   a snapshot that addresses the local container and would be misleading there.
   `db:migrate` (deploy) is intentionally unguarded so the box/CI deploy path is
   unaffected.

**Overrides (deliberate — you almost never should):**
`DANGEROUSLY_ALLOW_PROD_DB=1` (runtime guard) / `ALLOW_PROD_DB=1` (npm preflight).

> A *direct* `npx prisma db push` bypasses the npm preflight — layer 1 (local
> creds) is what protects you there, and **rotating the prod password** is the
> ultimate backstop (INC-002 action item 1).

---

### The trap the guards do not catch

`--shadow-database-url` names a scratch database and **Prisma resets it**:

```bash
# DO NOT — this EMPTIES whatever it points at
npx prisma migrate diff --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$DIRECT_URL"     # ← DIRECT_URL is your local dev DB
```

That is what emptied the local prod copy on 2026-08-25. Nothing above stops it:
it is a direct `npx` call, so the npm preflight never runs, and the destructive
behaviour is implied by a **noun** rather than announced by a flag like
`--accept-data-loss`. No list of forbidden commands catches the ones nobody has
thought of yet, which is the whole argument for a snapshot over a rule.

To check a migration against the schema without a live target: `npx prisma
validate`, then apply the migration SQL to local with `psql -v ON_ERROR_STOP=1
-f` and re-run it to prove idempotency, then read `\d "TableName"`.

---

## Reaching production (read-only, on purpose)

```bash
npm run prod:psql                                   # interactive psql, READ-ONLY session
npm run prod:psql -- -c 'SELECT count(*) FROM "Event"'
```

[scripts/prod-psql.sh](../scripts/prod-psql.sh) reads `DIRECT_URL` from `.env.prod`
and opens the session with `default_transaction_read_only=on`, so a stray
write errors. It's a guardrail, not a vault — don't turn read-only off.

For a **write** to prod (rare — a data fix, a migration outside deploy): do it
deliberately with an explicit URL, e.g.
`DANGEROUSLY_ALLOW_PROD_DB=1 DIRECT_URL="$(grep ^DIRECT_URL .env.prod | cut -d= -f2- | tr -d '\"')" npx prisma …`,
and know exactly what you're running.

---

## Troubleshooting

- **`[INC-002 guard] Refusing to connect …`** — your `.env`/`.env.local` point at
  prod. Fix them to `localhost:54322` (step 3). This is the guard doing its job.
- **`db:refresh` says the container isn't running** — `docker compose up -d postgres-prod-local`.
- **`role "root" does not exist` during a manual restore** — you ran `pg_restore`
  without `-U postgres`. `db:refresh` handles this; if restoring by hand, add `-U postgres`.
- **Host `pg_restore` version error** — the host client is 16; the dumps are 17.
  `db:refresh` restores *inside* the container (PG17), so use it rather than the
  host tools.
- **`prisma migrate status` shows pending migrations after a refresh** — the DR
  dump is a point-in-time snapshot; the repo may have newer migrations. Run
  `npm run db:migrate` to bring local current.
- **Fresh data needed** — `npm run db:refresh` any time. Data older than you want?
  The dump is whatever the latest DR backup captured (every ~2 h daytime).

---

## Related

- [docs/INCIDENTS.md](INCIDENTS.md) — INC-002 (the incident this prevents) + the exact recovery.
- [infra/dr/README.md](../infra/dr/README.md) — the DR dumps `db:refresh` restores from.
- [docs/MULTI_TENANCY.md](MULTI_TENANCY.md) §0 — where a *separate* Supabase project is the right tool (the platform instance), as opposed to local dev.
