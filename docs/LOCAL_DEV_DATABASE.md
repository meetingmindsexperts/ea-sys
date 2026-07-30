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
```

- **`npm run db:refresh`** ([scripts/dev-db-refresh.sh](../scripts/dev-db-refresh.sh))
  drops the local `public` schema and restores the newest DR dump. It's
  destructive to LOCAL only, and doubles as a DR restore drill. Refresh whenever
  you want current data or after schema changes land.
- **`npm run db:migrate`** = `prisma migrate deploy` — applies pending migrations
  to whatever `DATABASE_URL` points at (local). Not guarded (deploy is never
  destructive).

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
3. **npm preflight** — [scripts/guard-db-target.sh](../scripts/guard-db-target.sh)
   runs before `npm run db:push` / `npm run db:reset` and refuses a prod target.
   `db:migrate` (deploy) is intentionally unguarded so the box/CI deploy path is
   unaffected.

**Overrides (deliberate — you almost never should):**
`DANGEROUSLY_ALLOW_PROD_DB=1` (runtime guard) / `ALLOW_PROD_DB=1` (npm preflight).

> A *direct* `npx prisma db push` bypasses the npm preflight — layer 1 (local
> creds) is what protects you there, and **rotating the prod password** is the
> ultimate backstop (INC-002 action item 1).

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
