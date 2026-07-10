# Rollback Runbook — EA-SYS

**Last updated:** July 10, 2026
**Audience:** operators (Krishna / on-call). Browseable in-app at `/admin/docs`.

EA-SYS has **two independent rollback axes**. Know which one you need before touching anything:

| What broke | What to roll back | Tool | Time to restore | Data loss |
|---|---|---|---|---|
| A bad deploy — new code misbehaves, UI broken, 500s after a release | **Code (Docker image)** | `IMAGE_TAG=<sha> bash scripts/deploy.sh` | ~1–2 min | None |
| Bad/lost DATA — wrong bulk edit, accidental deletes, corruption | **Database** | S3 `pg_dump` restore points (Singapore DR bucket) | 15–60 min | Up to 1 dump interval |
| Lost uploaded files (photos, cert PDFs, agreement docs) | **Uploads** | Hourly S3 mirror | Minutes | ≤ 1 hour |
| Broken `.env` on the box | **Env file** | Daily S3 copy | Minutes | ≤ 24 h (env rarely changes) |

Code and data roll back **independently** — a code rollback never touches the DB, and a DB restore never touches the running containers.

---

## 1. Code rollback — previous Docker image

### How it works

Every push to `main` triggers GitHub Actions, which builds and pushes two images to ECR
tagged with the **full 40-character git commit SHA**:

- web: `803726282629.dkr.ecr.ap-south-1.amazonaws.com/ea-sys:<sha>`
- worker: `…/ea-sys:worker-<sha>`

`scripts/deploy.sh` accepts `IMAGE_TAG=<sha>` and pulls exactly that pair. A rollback is
therefore **the normal blue-green deploy, pinned to an old SHA** — same health check, same
graceful nginx switch, zero downtime. If the health check fails, nginx never switches and
the currently-running version keeps serving (a rollback can't make things worse).

### Steps

**Step 1 — find the commit to roll back to** (your machine or the box):

```bash
git log --oneline -15            # pick the last-known-good commit
git rev-parse <short-sha>        # expand to the full 40-char SHA (ECR tags use the full SHA)
```

**Step 2 — confirm the image exists in ECR** (optional but cheap):

```bash
aws ecr describe-images --repository-name ea-sys --region ap-south-1 \
  --query "reverse(sort_by(imageDetails,&imagePushedAt))[0:10].imageTags" --output table
```

If the SHA is missing from ECR (very old commit, lifecycle-pruned), `deploy.sh` falls back
to **building on the box from the checked-out code** — in that case `git checkout <sha>`
in `/home/ubuntu/ea-sys` first, and expect ~8 min instead of ~1 min.

**Step 3 — run the pinned deploy on the box:**

```bash
aws ssm start-session --target i-0b51ab1213d084640 --region ap-south-1
sudo su - ubuntu
cd /home/ubuntu/ea-sys
IMAGE_TAG=<full-40-char-sha> bash scripts/deploy.sh
```

Never run raw `docker compose` in `/home/ubuntu/ea-sys` — always go through the script
(it owns slot selection, health checks, the nginx switch, and stopping the old slot).

**Step 4 — verify:**

```bash
curl -s https://events.meetingmindsgroup.com/api/health      # 200
curl -s https://events.meetingmindsgroup.com/worker/health   # 200 with fresh lastTickAt
docker ps                                                     # active slot + worker up
```

Then in the app: log in, open an event's registrations list, and check `/logs` for a clean
minute (no error-level entries from the fresh containers).

**Step 5 — stop CI from re-deploying the bad code.** A rollback pins the box, but the
next push to `main` deploys the newest SHA again. Either:

- `git revert <bad-sha>` and push (preferred — history stays honest and CI redeploys the
  reverted state), or
- hold all pushes until a forward fix lands.

### Gotchas

- **The worker rolls back with the web tier** — `deploy.sh` deploys both images from the
  same `IMAGE_TAG`. Don't try to roll them back separately.
- **Migrations do not roll back, by design.** The migrations policy is additive/idempotent
  only (blue-green safety), which means **old code runs correctly against newer schema** —
  rolling the image back across a migration is safe; old code simply ignores new
  columns/tables. What is NOT safe (and is why the policy exists) is a destructive
  migration; never ship one.
- **Bind mounts are untouched**: `public/uploads/`, `logs/`, and `.env` live on the host
  and survive any image swap.
- **How far back can you go?** The weekly on-box prune keeps recent SHA tags locally, and
  ECR retains more; anything in `git log` from the last few weeks is effectively
  one-command restorable. Older than that → the build-on-box fallback path.

---

## 2. Database rollback — hourly restore points

Postgres (Supabase, PG 17) is dumped by cron on the Mumbai box via
`scripts/dr-pg-dump.sh` → `s3://ea-sys-dr-singapore/db/{YYYY}/{MM}/{DD-HH}-mumbai.dump`
(`pg_dump -Fc --schema=public`, 30-day S3 expiry, SES alert on failure).

- **Target cadence: hourly** (`5 * * * *`) — the "restore point every hour" decision of
  July 10, 2026. Until that crontab edit is applied the live cadence is 2-hourly daytime
  (`0 2,4,6,8,10,12,14,16,18,22 * * *` UTC).
- Restore procedures live in **[infra/dr/README.md](../infra/dr/README.md)**:
  - **Surgical recovery** (§A–E) — restore the dump into a scratch Postgres 17 container
    (`scripts/dr-restore-drill.sh` does exactly this), then copy back just the damaged
    rows/tables. This is the right move for "someone bulk-deleted registrations" — you do
    NOT roll the whole production DB back for a partial loss.
  - **Full restore / promotion** — for total DB loss; follow the promotion runbook.
- **Point-in-time (to-the-second) recovery is NOT available** — restore points are
  discrete dumps. If a tighter window is ever needed, Supabase PITR (~$25–50/mo) is the
  upgrade path (deliberately deferred).

Quick reference — spin up the latest dump locally for inspection:

```bash
bash scripts/dr-restore-drill.sh    # ephemeral postgres:17 on :55432 + row counts
```

---

## 3. Uploads + .env restore

- **Uploads** mirror hourly: `aws s3 sync` of `/home/ubuntu/ea-sys/public/uploads/` →
  `s3://ea-sys-dr-singapore/uploads/`. Restore a lost file/folder by syncing back the
  other way (see [infra/dr/README.md](../infra/dr/README.md) surgical recovery).
- **`.env`** is copied daily at 21:00 UTC to `s3://ea-sys-dr-singapore/env/{date}.env`.
  Restore = download, place at `/home/ubuntu/ea-sys/.env` (0600, ubuntu-owned), then
  `bash scripts/deploy.sh` (containers only read env at start; `docker compose restart`
  does NOT re-read `env_file`).

---

## 4. Combined scenarios

| Scenario | Order of operations |
|---|---|
| Bad deploy, data fine | Code rollback only (§1). Don't touch the DB. |
| Bad deploy that also wrote bad data (e.g. a buggy bulk job ran) | Code rollback first (stop the bleeding), then surgical DB recovery (§2) for the affected rows. |
| Data disaster, code fine | Surgical or full DB restore only. Leave the deploy alone. |
| Whole box lost | Regional failover: [infra/dr/README.md](../infra/dr/README.md) promotion runbook (Singapore break-glass box) + [docs/AWS_OPERATIONS.md](AWS_OPERATIONS.md) DR section. |

---

## 5. After any rollback — checklist

1. `/api/health` + `/worker/health` return 200.
2. `/logs` clean for ~5 minutes (no error-level from the new containers).
3. If you rolled back CODE: decide the forward plan (revert commit vs. hold pushes) —
   write it down before walking away, or CI will silently roll you forward on the next push.
4. If you restored DATA: run `npx tsx scripts/reconcile-soldcounts.ts` (dry-run) if
   registrations were touched, and spot-check the affected event's counts.
5. Note what happened in [docs/INCIDENTS.md](INCIDENTS.md) if it was incident-driven.
