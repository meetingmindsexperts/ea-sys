# Rollback Runbook — EA-SYS

**Last updated:** July 14, 2026
**Audience:** operators (Krishna / on-call). Browseable in-app at `/admin/docs`.

> ✅ **The code-rollback path was drilled end-to-end on production on July 14, 2026 — it works.**
> Measured: **22 seconds**, zero downtime. Full drill log, real timings and the four things it
> taught us are in **[§1.6 Drill log](#16-drill-log--july-14-2026)**. An untested rollback path is
> not a rollback path; re-drill after any change to `deploy.sh`, the compose file, or the CI workflow.

EA-SYS has **two independent rollback axes**. Know which one you need before touching anything:

| What broke | What to roll back | Tool | Time to restore | Data loss |
|---|---|---|---|---|
| A bad deploy — new code misbehaves, UI broken, 500s after a release | **Code (Docker image)** | `IMAGE_TAG=<sha> bash scripts/deploy.sh` | **~25 s** (measured) | None |
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

**Two timings, don't conflate them** (this is why an incident feels faster than a release):

| Path | What it does | Measured |
|---|---|---|
| **Pinned rollback** (`IMAGE_TAG=<sha>`) | Pull 2 images from ECR → migrate → health-check → nginx switch | **~22 s** |
| Full CI deploy (a push to `main`) | Lint + typecheck + **build 2 images** + push to ECR + the above | **~7 min** |

In an incident you are on the first row. The build is what costs the minutes, and a rollback skips it.

### Steps

**Step 1 — find the image tag.** The tag is the **full 40-character git commit SHA** — a short
SHA will not work. Three ways to get one:

```bash
# (a) From git — the usual way. Pick the last-known-good commit, then expand it:
git log --oneline -15
git rev-parse ba69eab            # → ba69eabac3ae3ecaed9c5a9025b745cf1ebd1e60

# (b) From ECR — what is actually deployable right now (newest first):
aws ecr describe-images --repository-name ea-sys --region ap-south-1 \
  --query "reverse(sort_by(imageDetails,&imagePushedAt))[:10].imageTags" --output table

# (c) From the box — what you are rolling back FROM (the tag is in the image name):
docker ps --format '{{.Names}} | {{.Image}}'
```

⚠️ **Do not roll back to `:latest`.** It is a moving tag — it points at the newest build, which
during an incident is usually the thing you are trying to escape. Always pin an explicit SHA.

💡 Identical code produces one ECR image with several tags (the July-14 drill's empty commit
deduplicated onto the previous worker image's digest). Two tags pointing at one digest is normal,
not a bug.

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

**Step 5 — stop CI from re-deploying the bad code.** ⚠️ **The rollback pins the running
containers, not the repo.** The box now runs an old image while `main` still contains the bad
commit — so **the next push that touches code re-deploys it and undoes your rollback**. Either:

- `git revert <bad-sha>` and push (preferred — history stays honest and CI redeploys the
  reverted state), or
- hold all code pushes until a forward fix lands.

(Docs-only pushes are safe in the meantime — they don't deploy. See Gotchas.)

### Gotchas

- **The worker rolls back with the web tier** — `deploy.sh` deploys both images from the
  same `IMAGE_TAG`. Don't try to roll them back separately. (Verified in the drill: both
  containers came back on the pinned SHA.)

- **The box's git checkout does NOT roll back — only the image does.** `deploy.sh` pulls the
  old *image* from ECR, but the script and `docker-compose.prod.yml` it runs still come from
  whatever is checked out on the box (i.e. the *newer* commit). Harmless today, but if a
  commit ever changes `docker-compose.prod.yml` (new service, new env var, changed mount) and
  you roll the image back past it, you get a **newer compose file running an older image**.
  If a rollback crosses a compose-file change, `git checkout <sha> -- docker-compose.prod.yml`
  on the box first.

- **Migrations, precisely.** `deploy.sh` runs `prisma migrate deploy` **from the image being
  deployed** — so a rollback runs the *old* image's migration folder against a DB that already
  has *newer* migrations applied. `migrate deploy` only applies **pending** migrations and does
  not tear anything down, so it should be a clean no-op — and the additive/idempotent-only
  migration policy means **old code runs correctly against a newer schema** (it simply ignores
  new columns/tables). ⚠️ **This specific case has not been drilled** — the July-14 drill did not
  cross a migration boundary. Treat it as *believed safe, unverified*. What is definitively NOT
  safe (and is why the policy exists) is a destructive migration; never ship one. **Next drill
  should cross a migration boundary.**

- **Bind mounts are untouched**: `public/uploads/`, `logs/`, and `.env` live on the host
  and survive any image swap. (The DB is untouched too — a code rollback never touches data.)

- **How far back can you go?** The weekly on-box prune keeps recent SHA tags locally, and
  ECR retains more; anything in `git log` from the last few weeks is effectively
  one-command restorable. Older than that → the build-on-box fallback path.

- **Docs-only and empty commits do not deploy at all.** The workflow has `paths-ignore` for
  `docs/**`, `**.md`, `LICENSE`, `.gitignore` — a deliberate INC-001 guard (an on-box build can
  freeze the host, so a doc typo must never trigger one). An **empty commit touches no paths, so
  GitHub skips the workflow entirely**. Consequence: *the newest commit in `git log` is not
  necessarily what production is running* — check `docker ps`, not `git log`. To force a deploy
  with no code change, use **`workflow_dispatch`** (below).

### 1.5 Forcing a deploy without a code change (`workflow_dispatch`)

Because docs-only/empty commits are skipped (see Gotchas), there are times you need to deploy
the current `main` anyway — re-deploying after a rollback, redeploying an unchanged HEAD, or
staging a drill. The workflow exposes `workflow_dispatch`:

```bash
gh workflow run deploy.yml --ref main       # builds + deploys main HEAD (~7 min)
gh run list --limit 3                       # watch it
```

Or in the GitHub UI: **Actions → Deploy to EC2 → Run workflow**.

---

### 1.6 Drill log — July 14, 2026

**First end-to-end production rollback drill. Result: the path works.** Everything below is
measured, not estimated.

**What we did:** pushed a deliberately empty commit (`5f2b00d`) as a harmless "bad deploy" →
force-deployed it → rolled production back to the previous image (`ba69eab`, the M3 commit) →
verified → left production on `ba69eab` (which *is* the newest code-bearing commit; the ones
after it are docs + the empty commit, which by design never deploy).

| Phase | Measured |
|---|---|
| Empty commit pushed to `main` | **No deploy** — workflow skipped (`paths-ignore`, no paths touched) |
| Forced deploy via `workflow_dispatch` | **7 min 21 s** (lint + typecheck + build 2 images + push + deploy) |
| Pre-rollback state | slot **blue** :3000 on `5f2b00d`, public health 200 |
| **Pinned rollback** — `IMAGE_TAG=ba69eab… bash scripts/deploy.sh` | **22 s** (script's own timer) · 32 s wall incl. SSM overhead |
| ├─ health check on the new slot | 6 s |
| ├─ nginx switch + reload | 1 s |
| └─ worker restart + `/health` | 8 s |
| Post-rollback state | slot **green** :3001 on `ba69eab` — **web *and* worker** |
| Verification | `/api/health` **200**, `/worker/health` **200**, containers healthy |
| **Downtime** | **None** (nginx reload is graceful — in-flight requests finish on the old slot) |

**What the drill taught us** (all four are now folded into the sections above):

1. **An empty commit doesn't deploy — and neither do docs commits.** `paths-ignore` skips them.
   So *the newest commit in `git log` is not necessarily what prod is running* — always check
   `docker ps`. `workflow_dispatch` (§1.5) is the lever when you need to deploy anyway. This is
   the single most surprising thing the drill surfaced, and it would have wasted real minutes
   during an incident.
2. **The runbook's "~1–2 min" was conflating two different numbers.** A pinned rollback is
   **~22 s** (pull only); a full CI deploy is **~7 min** (it builds). In an incident you're on
   the fast path — now stated explicitly at the top.
3. **The box's git checkout doesn't roll back**, only the image does — so a rollback across a
   `docker-compose.prod.yml` change would run a *new* compose file against an *old* image.
   Now a documented gotcha with the fix.
4. **Migrations across a rollback boundary remain UNDRILLED.** `deploy.sh` runs
   `prisma migrate deploy` from the *image being deployed*; today's commits carried no
   migrations, so the drill didn't exercise it. Documented as *believed safe, unverified* rather
   than claimed working.

**For the next drill (do these, they're the gaps):**
- [ ] **Cross a migration boundary** — roll back past a commit that adds a migration, and confirm
      `prisma migrate deploy` no-ops cleanly instead of erroring on the extra applied migration.
      This is the one real unknown left in the code-rollback path.
- [ ] **Drill a *failing* health check** — deploy an image that won't come up, and confirm nginx
      never switches and the old slot keeps serving (the script claims this; we haven't watched it).
- [ ] **Drill the ECR-unreachable fallback** — confirm the on-box build path still works (~8 min)
      and, critically, that the box's **4 GB swap** is present (the INC-001 freeze happened on a
      swapless box doing exactly this build).
- [ ] Re-run the whole drill after any change to `deploy.sh`, `docker-compose.prod.yml`, or the
      CI workflow.

**Cadence:** re-drill **quarterly**, and always before a conference season. Pair it with the DB
restore drill (`scripts/dr-restore-drill.sh`) so both axes get exercised in the same sitting.

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
