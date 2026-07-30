# EA-SYS — Incident Log & Outage Post-Mortems

Production incidents, what caused them, how we diagnosed and fixed them, and the
action items to prevent recurrence. Newest first.

When prod is down, the fast triage order is in
[docs/AWS_OPERATIONS.md](AWS_OPERATIONS.md) §1.2 (health) and §3 (CPU/mem/disk).
The general method that worked for INC-001 is captured in
["How to diagnose a frozen box"](#appendix--how-to-diagnose-a-frozen-box) below.
For **data-loss** incidents, the recovery path is the DR restore in
[infra/dr/README.md](../infra/dr/README.md) and [docs/ROLLBACK.md](ROLLBACK.md).

---

## INC-002 — Production database wiped: a local `prisma db push --force-reset` hit the prod DB (2026-07-30)

| | |
|---|---|
| **Date** | 2026-07-30, wipe between **08:00–08:55 UTC** (~12:00–12:55 GST); detected ~08:59 UTC |
| **Duration** | App effectively unusable ~08:5x–09:13 UTC (~15–20 min from detection to recovery) |
| **Severity** | SEV-1 — total data outage. Every org-scoped query returned empty ("no events"); CRM seed writes threw FK violations. The app was *up* (health 200) but had **no data**. |
| **Trigger** | A **destructive Prisma command run from a developer machine whose `.env` pointed `DIRECT_URL`/`DATABASE_URL` at the PROD Supabase project** (`postgres.nifaqvgnfwddgsusxapy`). |
| **Root cause** | **Local development shares the production database** (documented, accepted risk — there is no separate dev DB yet). A `prisma db push --force-reset` (or a manual `DROP SCHEMA public CASCADE`) executed against that prod URL **dropped every table and all data**, then rebuilt empty tables from `schema.prisma`. |
| **How we know it was `db push --force-reset`, not `migrate reset`** | `_prisma_migrations` **did not exist** after the wipe (`42P01`). `prisma migrate reset` *recreates* that table and re-applies every migration; `db push` never writes it and does not run the seed. Empty tables **+** absent `_prisma_migrations` **+** no seed data = `db push --force-reset`. |
| **Who** | A local `db push` against prod leaves **no actor record in our app, AWS, or CloudTrail**. The **only** place the source is recorded is **Supabase → Logs → Postgres** (the `DROP`/`CREATE SCHEMA` DDL around 08:5x UTC carries the client IP). That lookup is the one way to name the person and is an **open action item** (needs the Supabase dashboard). Circumstantial: schema/plan files (`schema.prisma`, `SESSION_PROPOSALS_PLAN.md`) were being edited that morning, consistent with someone doing local Prisma work. |
| **Fix** | **Restored the latest DR pg_dump** (`s3://ea-sys-dr-singapore/db/2026/07/30-08-mumbai.dump`, 08:00 UTC) into the prod DB via `DIRECT_URL`, then restarted the app + worker. |
| **Data loss** | **RPO ≈ 55 min.** Restored to the 08:00 UTC snapshot; any writes between 08:00 and the wipe (~08:55 UTC, i.e. ~12:00–12:55 GST, midday) are **permanently lost** — this is the best snapshot available (Supabase PITR is not enabled; DR dumps run every ~2 h daytime and one landed ~1 h before the wipe). |
| **Status** | **Resolved.** DB restored (2 orgs, 35 events, 3,592 registrations, 99 users, 143 migrations — matching the validated dump), app + worker health 200, zero errors, worker rebooted clean (13 jobs). Prevention items below are **open**. |

### Timeline (UTC)
- **08:00** — Last healthy DR `pg_dump` uploaded (2.56 MB — normal size). Recovery point.
- **08:00–08:55** — Destructive `prisma db push --force-reset` runs against prod `DIRECT_URL`. All data + `_prisma_migrations` dropped; empty tables rebuilt.
- **08:55:20** — `mcp-remote@system.local` (the MCP system user) is created — the **first write into the freshly-emptied DB** (n8n/MCP traffic), and the timestamp that bounds the wipe.
- **08:59:48** — First FK-violation errors surface: `CrmProduct_organizationId_fkey` / `CrmEmailTemplate_organizationId_fkey` on `createMany` (the CRM catalog/template seed-on-first-load, stamping an `organizationId` that no longer exists). All org-scoped reads return empty → "no events".
- **~09:00** — Reported ("entire prod is down").
- **09:09** — DR restore drill validated the 08:00 dump in a scratch Postgres → 35 events, 3,592 registrations (full, healthy).
- **09:12** — Safety-dumped the current (empty) prod, then `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` + `pg_restore` the 08:00 dump via `DIRECT_URL`. Counts verified.
- **09:13** — Restarted `ea-sys-blue` + `ea-sys-worker` (to drop stale Prisma prepared statements against the dropped tables). App + worker health 200. Recovered.

### How we diagnosed it
A read-only query inside the worker container (`docker exec -w /app ea-sys-worker node …` via SSM) showed the smoking gun in one shot: `0 organizations, 0 events, 0 registrations, 1 user (org null)` on the **confirmed real prod project** (`DATABASE_URL`/`DIRECT_URL` both `postgres.nifaqvgnfwddgsusxapy` — so the URL was **not** swapped to an empty DB). `_prisma_migrations` missing (`42P01`) pinned it to `db push --force-reset`. The stray `mcp-remote@system.local` user's `createdAt` (08:55:20) bounded the wipe. **The two frontend commits deployed just before (deal-form layout, product-card colours) were ruled out immediately — pure CSS/JSX cannot cause an FK violation.**

### Resolution (the exact recovery, for next time)
```bash
# On the box, as ubuntu. DIRECT_URL parsed from /home/ubuntu/ea-sys/.env (never printed).
# 1. Safety dump of the current state first (insurance).
pg_dump -Fc --schema=public "$DIRECT_URL" > /tmp/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).dump
# 2. Pull the latest healthy DR dump (Singapore bucket).
aws s3 cp s3://ea-sys-dr-singapore/db/<latest>.dump /tmp/recovery.dump --region ap-southeast-1
# 3. Reset the schema and restore. --no-owner --no-privileges avoids Supabase role noise.
psql "$DIRECT_URL" -c 'DROP SCHEMA IF EXISTS public CASCADE;' -c 'CREATE SCHEMA public;'
pg_restore --no-owner --no-privileges -d "$DIRECT_URL" /tmp/recovery.dump   # 1 benign "schema public already exists" error is expected
# 4. Verify counts, then: docker restart ea-sys-blue ea-sys-worker
```
**Validate the dump in a scratch Postgres first** (`sudo -u ubuntu bash scripts/dr-restore-drill.sh`) — it restores the latest dump into a throwaway container and prints row counts, with **zero** risk to prod. We did this before touching prod.

### Prevention / action items
1. **Rotate the prod DB password.** ⏳ **OPEN (owner).** Every dev `.env` that ever held the prod `DIRECT_URL` is a loaded gun; the plaintext prod password is also still in `.env.prod` on the dev machine. Rotating it (Supabase → Database → Reset password) instantly disarms every copy. Then re-set it on the box `.env` + CI/Vercel secrets + `.env.prod`. **Highest remaining priority.**
2. **Give local dev its own database.** ✅ **SHIPPED (2026-07-30).** New `postgres-prod-local` service (`postgres:17`, `localhost:54322`, persistent volume, db `ea_sys_prod_local`) in `docker-compose.yml`; **`npm run db:refresh`** ([scripts/dev-db-refresh.sh](../scripts/dev-db-refresh.sh)) restores the latest Singapore DR dump into it (realistic prod-like data locally + doubles as a restore drill). The dev machine's `.env` / `.env.local` now point at `localhost:54322`; the only prod copy left is `.env.prod`, read solely by the deliberate read-only **`npm run prod:psql`** ([scripts/prod-psql.sh](../scripts/prod-psql.sh)). A `prisma db push` from a dev machine now hits the local DB, not prod.
3. **Guard the destructive Prisma commands.** ✅ **SHIPPED (2026-07-30).** Two layers: (a) a runtime fail-fast in [src/lib/db.ts](../src/lib/db.ts) (`assertNotProdDbOutsideProduction`) that **throws at startup** if `DATABASE_URL`/`DIRECT_URL` resolve to the prod project ref and `NODE_ENV !== "production"` — covers the app + every `tsx` script (inert on the box, where `NODE_ENV=production`); (b) an npm preflight [scripts/guard-db-target.sh](../scripts/guard-db-target.sh) on `db:push` / `db:reset` that refuses when the target is prod. `DANGEROUSLY_ALLOW_PROD_DB=1` / `ALLOW_PROD_DB=1` are the deliberate overrides. Note: a *direct* `npx prisma db push` still bypasses the npm preflight — the real protection there is that prod creds are no longer in the files Prisma auto-reads (item 2), and rotating the password (item 1) is the ultimate backstop.
4. **Enable Supabase PITR.** ⏳ **OPEN.** Would cut RPO from ~55 min to seconds and give a rollback independent of the 2 h DR dump cadence. (Previously deferred on cost; re-evaluate — this incident had real, unrecoverable data loss.)
5. **Pull Supabase Postgres logs** around 08:5x UTC to identify the source IP/person (the only record of "who"). ⏳ **OPEN (owner — needs the Supabase dashboard).**
6. Consider an automatic `pg_dump` immediately *before* any migration/schema op, and/or a tighter DR cadence. ⏳ OPEN.

---

## INC-001 — Production fully down: on-box `docker build` froze the server (2026-06-16)

| | |
|---|---|
| **Date** | 2026-06-16, ~07:37–08:01 UTC (~11:37–12:01 GST) |
| **Duration** | Site unreachable ~20 min; recovered ~3.5 min after the reboot signal |
| **Severity** | SEV-1 — full outage (every page + API timing out) |
| **Trigger** | A deploy ran `docker compose build` on the production host |
| **Root cause** | A **`docker build` memory peak on a t3.large (8 GB) with NO swap, building while the old containers were still up.** The **systemic cause is a chronically heavy build with zero margin**, NOT any single library. The module graph is large in aggregate — `next` (155 MB), Prisma (client+engines ~230 MB), `@zoom/meetingsdk` (112 MB), `@next/swc` (99 MB), `@sentry` (64 MB), pdf/canvas/sharp, etc. (node_modules is **1.4 GB**) — so `next build` + the worker image already peaked **near 8 GB**. Idle usage is healthy (~1.4 GB; web ~230 MB, worker ~230 MB, mediamtx 11 MB — NOT a leak, NOT mediamtx). With **zero swap there's no buffer for the build spike** → the kernel thrashed and **froze all of userland** (nginx, app, *and the SSM agent*). The earlier "~4.4 GB" reading was taken *mid-build*, not steady state. |
| **Why THIS deploy** | The `/api-docs` deploy (`49a1fc1`) added `@scalar/api-reference-react` (~105 MB transitive, a Vue app bundled into a **client** chunk via `ssr:false`). **It was the increment that tipped an already-at-the-edge build — the straw, not a uniquely large dependency.** ⚠️ *Correction (2026-06-16): an earlier version of this post-mortem over-attributed the freeze to @scalar's size specifically. On disk it was NOT the biggest dep — `next`, Prisma, and the Zoom SDK are all in its weight class or bigger and were in every prior build. The accurate framing: a swapless box running a 1.4 GB-graph build near the ceiling will be tipped by **any** incremental addition; @scalar correlated only because it was the new thing in that deploy. Removing it helped at the margin; the box stays vulnerable to the next addition until the build moves off-box (action item #2).* |
| **Fix** | Rebooted the instance (`aws ec2 reboot-instances`); recovered clean in ~3.5 min. **Hardened (see below): added 4 GB swap + a deploy path-filter.** |
| **Status** | **Resolved + hardened.** Site live, new code deployed, **4 GB swap added (persistent)**, and **docs-only pushes no longer trigger a deploy/build**. Remaining follow-ups (build-in-CI, mem alarm, uptime check) tracked below. |

### What the symptoms looked like
- DNS fine (resolved to the Mumbai EIP everywhere). **Not DNS.**
- EC2 instance **running**, status checks **ok** (hypervisor alive).
- TCP 443/80/22 **accepted** connections (kernel SYN-ACK works without userland).
- But **HTTP timed out** — nginx never sent a byte, not even the plain `:80`
  redirect (which doesn't touch the app). So it was **nginx-level/OS-level, not
  the app**.
- **The SSM agent couldn't even pick up a command** (stuck `Pending` 90 s+) — the
  tell that *userland itself was frozen*, not just one service.
- CloudWatch (hypervisor-side, so still readable): CPU spiked to **99% at 07:43
  UTC** then held ~50%; **CPU credits full (864)** → *not* the t3 credit trap;
  **NetworkIn 46 MB spike at 07:37** (≈100×). Memory/disk are **not** in default
  EC2 metrics, so they were invisible — the core blind spot (see prevention).

### How we found the root cause
Default EC2 metrics can't show memory, and SSM was frozen, so live inspection was
impossible **during** the outage. After the reboot, the evidence persisted:
- `journalctl -b -1` (previous boot — **journald is persistent on this box**) showed
  **BuildKit/`docker build` mounts + container network churn at 07:41–07:44 UTC**,
  then the journal **stops at 07:48:49 UTC** (box frozen). That window = a deploy
  building an image.
- `df -h` → **76% used, not full** (ruled out disk).
- `docker inspect` → **all containers `restarts=0`, `oomkilled=false`** (no crash
  loop; Docker didn't OOM-kill a container — the *host* ran out before that).
- `swapon --show` → **0 B** (no swap — the missing cushion).
- `free -m` (post-recovery steady state) → ~4.4 GB used, **~3.4 GB available** — less
  than a Next.js build needs, so the build tipped it over.
- **Git HEAD on the box = the latest commit, but the new routes 404** → the deploy
  **pulled the code but the build never finished** (the freeze killed it); the
  reboot restarted the *previous* image.

### Resolution
`aws ec2 reboot-instances --instance-ids i-0b51ab1213d084640 --region ap-south-1`.
Reboot cleared the memory pressure, killed the stuck build, and brought nginx +
Docker (restart policy) + SSM back. `/api/health` was 200 ~3.5 min later. Same
instance, same Elastic IP, same disk — no data loss (DB is external Supabase).

### Preventive measures applied (2026-06-16, same day)
1. **4 GB swap file added + persisted** — `/swapfile` (created with `dd`, not
   `fallocate` — the latter silently failed `swapon` with the sparse-extent bug),
   `swapon` active, `/etc/fstab` entry so it survives reboot, `vm.swappiness=10`.
   Verified `free -h` → `Swap: 4.0Gi`. *This is the cushion that turns a build
   memory spike from a freeze into a brief slow-down.*
2. **`deploy.yml` gained `paths-ignore`** for `**.md` / `docs/**` — **docs-only
   pushes no longer trigger a deploy/build.** Today's outage was triggered by a
   docs push kicking off an on-box build; this removes that entire class. Any
   commit touching code still deploys.

The new code (API docs + hybrid attendance) **did eventually deploy** — the
post-reboot build re-ran with fresh memory and completed; `/api/openapi.json`
returns 200.

### Action items (prevention)

| # | Action | Why | Status |
|---|---|---|---|
| 1 | **Add a 4 GB swap file** (`/swapfile`, `swapon`, `fstab`, `vm.swappiness=10`) | The single missing cushion. A swapless box has no margin — a transient memory spike = instant freeze instead of a slow-down. | ✅ **DONE (2026-06-16)** |
| 1b | **`deploy.yml` `paths-ignore` for docs** so docs pushes don't build on the box | Removes the exact trigger of INC-001 (a docs push started the build). | ✅ **DONE (2026-06-16)** |
| 2 | **Build the image in CI, not on the box** — GitHub Actions → build → push to ECR → box does `docker compose pull && up` (no on-host build) | Removes the heavy build from the prod host entirely — the actual root cause. The CLAUDE.md CI/CD section already describes this as the intended flow; the box is currently doing `docker compose build` locally instead. | **TODO (the real fix)** |
| 3 | **Ship memory + disk metrics to CloudWatch** (the agent currently ships *logs* only) + an alarm on `mem_available < 500 MB` | We were blind on memory during the incident — that's why diagnosis was slow. Metrics + alarm would have paged *before* the freeze. | TODO |
| 4 | **External uptime check on `/api/health`** (Route 53 health check or UptimeRobot) → alert when the *site* is down even though the instance "looks ok" | EC2 status checks passed throughout — they don't catch a frozen-but-running box. Only a real HTTP probe does. | TODO |
| 5 | **Cap container memory** (`mem_limit` in `docker-compose.prod.yml`) | So one container (or a build) can't consume all host RAM and take everything down. | Consider |
| 6 | If builds stay on-box: **constrain build memory** (`NODE_OPTIONS=--max-old-space-size`, lower concurrency) and `nice`/`ionice` it | Reduces the build's blast radius until #2 lands. | Consider |
| 7 | **Lighten the `/api-docs` viewer** — the 105 MB `@scalar/api-reference-react` bundle is what spiked *this* build. Serve the spec + a tiny standalone/CDN Scalar script, or Redoc, so the heavy package leaves the build graph. | Removes the specific trigger of INC-001 (build weight is otherwise permanent). | Consider |

**Quickest risk reduction:** #1 (swap) immediately, then #2 (build off-box). #1
alone would likely have turned this SEV-1 freeze into a slow deploy. #7 removes
the specific trigger if you'd rather not carry the heavy build dependency.

---

## INC-002 — Deploy blocked: box out of disk from an unpruned local image cache (2026-07-02)

| | |
|---|---|
| **Date** | 2026-07-02, ~07:56 UTC (~11:56 GST) |
| **Duration** | No outage. Deploy blocked ~30 min until the disk was freed. |
| **Severity** | SEV-3 — deploy failure only; production stayed **up** the whole time (health 200). |
| **Trigger** | A routine deploy. The ECR image pull's layer-extract hit a **full root disk** (`no space left on device`), so `deploy.sh` fell back to an **on-box build**, which *also* ran out of space and failed. |
| **Root cause** | The box's **local Docker image cache was never pruned**, so ~19 deploys' worth of tagged images accumulated: **39 `ea-sys` images** (web ~1.18 GB + worker ~2.46 GB each ≈ **26 GB**) plus ~6 GB build cache filled the 48 GB root volume. The smart prune (`scripts/docker-prune.sh`) **existed but had never run** — it was wired **only** to a weekly cron (`0 3 * * 5`, Fridays) created the day before (Jul 1), so it hadn't fired once (no `cron-docker-prune.log`). Meanwhile `deploy.sh` only ran `docker image prune -f` (**dangling-only**), which by design never reaps **tagged** `:<sha>` images. Net: images piled up ~2 deploys/day while the only cleanup was a weekly sweep that hadn't happened. |
| **Why no outage** | Blue-green: the pull/build failed **before** the nginx slot swap, so the **old slot kept serving**. `curl /api/health` returned 200 throughout — no rollback needed. |
| **Fix** | Ran `scripts/docker-prune.sh` → **reclaimed 15 GB** (36 G → 21 G used, 75% → 44%; images 39 → 10), then re-deployed. |
| **Status** | **Resolved** (disk freed, deploy unblocked). Durable fix — wire the smart prune into `deploy.sh` before every pull — **pending** (see action items). |

### What the symptoms looked like
- GitHub Actions deploy step errored with `failed to extract layer … no space left on device` on the ECR pull, then `⚠ ECR login/pull failed — falling back to on-box build`, then the on-box build failed with `write /home/…/.docker/buildx/… no space left on device` and `exited with status 1`.
- **Production was unaffected** — `/api/health` = 200 the entire time (old slot still serving; the failure was pre-swap).

### How we found the root cause
Read-only SSM (`AWS-RunShellScript`) on `i-0b51ab1213d084640`:
- `df -h /` → **48 G total, 36 G used** (and full mid-deploy; the failed build's temp freed on abort).
- `docker system df` → **Images 26.43 GB (46 total)**, Build Cache **6.01 GB**. `docker images | grep ea-sys` → 39 tagged images, one web + one worker per deploy.
- **Gotcha:** `du -sh /var/lib/docker/*` looked deceptively small (~4 G) — this Docker uses the **containerd snapshotter**, so image layers live under **`/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/`**, not `/var/lib/docker/overlay2`. (The original error path named `/var/lib/containerd/…` — the tell.)
- `crontab -l` (ubuntu) → the prune cron **is** installed (`0 3 * * 5`) but `cron-docker-prune.log` **does not exist** → **never run** (script created Jul 1; next Friday hadn't arrived).
- `grep prune scripts/deploy.sh` → only `docker image prune -f` (dangling-only) at deploy time — **never calls `docker-prune.sh`**, which is exactly why the tagged `:<sha>` images accumulated (the script's own header comment says dangling-prune can't reap them).

### Resolution
`bash scripts/docker-prune.sh` on the box — trims build cache + dangling layers + old `ea-sys:<sha>` tags beyond the newest 3 per class (keeps `latest`/`worker-latest` + 3 rollback images each; never `system prune -a`, never `--volumes`, so uploads are safe). Reclaimed 15 GB → 27 G free. Then re-deployed (ECR pull path works once there's headroom).

### Relationship to INC-001 (and to ECR)
INC-001 was a **memory** freeze from an **on-box build**; its headline fix was **build off-box** (CI → ECR → the box pulls, action item #2). That shipped (Jul 1) and is working — **but it introduced a new footgun this incident exposed:** the box now pulls + **caches a tagged image per deploy**, and nothing pruned that local cache. Two second-order notes:
- ECR is **not** at fault — *any* deploy system caches images locally; ECR actually makes the box's cache **more disposable** (old images live in ECR, re-pullable for rollback), so we can prune aggressively. We just weren't.
- The `deploy.sh` **fallback to on-box build** briefly **reintroduced the INC-001 risk** (it started a build on the box — the very thing ECR removed) — it only triggered because the disk was already full. Worth guarding (below).

### Preventive measures
1. **Immediate (applied):** ran `docker-prune.sh` → 15 GB reclaimed; deploy unblocked.
2. **Durable (pending — the real fix):** move the smart prune **into `deploy.sh`, before the pull/build**, so every deploy self-cleans (keep the weekly cron as a backstop). The script + trigger both exist; they're just wired to the wrong event (weekly cron vs. every deploy).

### Action items (prevention)

| # | Action | Why | Status |
|---|---|---|---|
| 1 | **Free the disk** — `bash scripts/docker-prune.sh` | Unblocks the deploy; reclaimed 15 GB. | ✅ **DONE (2026-07-02)** |
| 2 | **Call `docker-prune.sh` from `deploy.sh` before the pull** (replace the dangling-only `docker image prune -f`); keep the weekly cron as backstop | The core gap — a weekly cron can't keep up with multiple deploys/day, and dangling-prune never reaps the tagged per-deploy images. | **TODO (the real fix)** |
| 3 | **Guard the on-box-build fallback on free disk** (only build if ≥ ~15 GB free, else fail loudly) | Stops the fallback from silently reintroducing the INC-001 build-on-box freeze risk when disk is already tight. | Consider |
| 4 | **Ship disk (+ memory) metrics to CloudWatch + alarm on low free space** | We were blind on disk until SSM inspection — same blind spot as INC-001 #3. An alarm would page before a deploy fails. | TODO (shared with INC-001 #3) |
| 5 | **Bump the root EBS volume** (48 G → e.g. 80–100 G) | Cheap headroom margin; treats the symptom, not the cause — do #2 first. | Consider |

**Quickest risk reduction:** #2 (self-cleaning deploy) — it removes the recurrence entirely. #1 was the immediate unblock.

---

## INC-003 — CRM reads 500 in prod: an already-applied migration was edited in place (2026-07-15)

| | |
|---|---|
| **Date** | 2026-07-15, first errors ~05:24 UTC |
| **Duration** | Ongoing until the reconcile migration deploys (see below) |
| **Severity** | SEV-3 — scoped to the CRM module (brand-new, not yet in operational use); no data loss; the rest of the app unaffected |
| **Trigger** | A deploy shipped a Prisma Client expecting the *second* version of a migration whose *first* version was already applied to prod |
| **Root cause** | The CRM migration `20260714120000_add_crm_module` was **edited in place** (commit `54fba94`, the CrmContact rework) after its **first** version (commit `7b4ff6b`) had already **auto-deployed** to prod. Prisma records an applied migration **by name** in `_prisma_migrations`; `prisma migrate deploy` applies only migrations whose *name* is not yet recorded and **does not re-run one whose content changed**. So the rewritten SQL never executed on prod — prod kept the v1 shape (`CrmDeal/Task/Note.contactId`, `Contact.companyId/lifecycleStage`, no `CrmContact`) while the new client expected v2 (`CrmContact`, `CrmDealContact`, `CrmTask.crmContactId`). Every CRM list query then 500'd: *"The table `public.CrmContact` does not exist"* / *"column `CrmTask.crmContactId` does not exist"*. |
| **Contributing** | A wrong mental model: the build/commits were described as "NOT deployed", but **every code push to `main` auto-deploys** (established in the rollback drill, ROLLBACK.md §1.6). So editing the migration was a live-prod migration edit, not a pre-deploy tidy-up. |
| **Fix** | A new guarded, idempotent migration `20260715060000_crm_contact_rework_reconcile` that brings a v1-shaped DB up to the datamodel (creates `CrmContact`/`CrmDealContact`, swaps `contactId → crmContactId` on Task/Note, drops the v1 `CrmDeal.contactId` + `Contact.companyId/lifecycleStage`) and is a **no-op on a fresh DB**. Deployed via the normal path (`prisma migrate deploy` runs it as the one pending migration). |
| **Status** | Fix authored + verified; **deploys with the next release**. |

### How it was diagnosed
The Pino errors named the exact missing objects (`CrmContact`, `CrmDealContact`, `CrmTask.crmContactId`) while sibling base tables (`CrmDeal`, `CrmCompany`, `CrmTask`) resolved — the signature of "v1 tables present, v2 additions absent". Confirmed by diffing the two committed versions of the migration file in git, then reading prod's real shape read-only:
```
prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script
```
That output is the authoritative reconcile. (It also surfaced **unrelated** pre-existing drift on `CertificateIssueRun` / `IssuedCertificate` / `CertificateIssueRunItem` / `AlertState` — deliberately left out of this fix; one incident, one concern.)

### The rule and the prevention
- **An applied migration file is immutable.** Once a migration is on `main` (⇒ auto-deployed), it is frozen. To change the schema you **add a new migration**, never edit the old one. Editing in place is only safe before the first commit.
- **The trap is silent** because `migrate deploy` skips already-applied migrations by *name* and never re-checksums them — tsc/lint/build/tests all stay green while prod diverges.
- **Durable guard (action item):** wire a pre-deploy drift check into CI —
  `prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --exit-code`
  exits non-zero when the DB and the schema disagree; halt the deploy on drift. Locally, `prisma migrate status` reports "edited after applied".
- **What worked:** the reconcile's `DROP COLUMN`s tripped the existing CI guard
  `scripts/check-migration-safety.sh`, which **blocked the deploy before the box
  ran `migrate deploy`** — so the fix never partially applied. It was safe to
  proceed (columns empty; no deployed code reads them), acknowledged deliberately
  in `prisma/destructive-migrations-ack.txt` rather than by editing the migration.
  That guard catches destructive SQL; it does NOT catch the drift class above — the
  two guards are complementary.
- Full symptom→fix entry in the `ea-sys-debugging` skill (Migrations section).

---

## INC-004 — 27 speaker/attendee photos destroyed on prod by delete-time file cleanup (2026-07-24, discovered 2026-07-29)

| | |
|---|---|
| **Date** | Deleted 2026-07-24 ~12:45 UTC; noticed 2026-07-29 (organizer report: speaker photo 404 on the Benign Hematology Summit) |
| **Duration** | 5 days of 404ing photos on affected speaker/attendee/contact rows; restored 2026-07-29 ~12:50 UTC |
| **Severity** | SEV-3 — cosmetic data loss (person photos), fully recoverable from the DR mirror; no PII exposure, no downtime |
| **Trigger** | An operator bulk-deleted entities (duplicate/test import cleanup) whose rows pointed at photo files that OTHER rows still referenced |
| **Root cause** | Since March 2026 the speaker / registration / contact **DELETE routes unlink the row's photo file from disk** ("clean up photo file"). But photo **paths are deliberately shared across rows**: `syncToContact` copies the URL onto the org Contact, and every import flow (registrations→speakers, contacts→registrations, EventsAir, speaker companions) carries the same `/uploads/photos/...` string onto the rows it creates. Deleting ONE row therefore destroyed the file its **siblings** still pointed at — 26 files under `photos/2026/07` + 1 under `2026/04` vanished while surviving Speaker/Attendee/Contact rows kept the dead path. |
| **Why it took months to bite** | The unlink shipped in March, but path-sharing density exploded in June–July (companion registrations, contact sync enrichment, heavy import activity), and only July's cleanup of an import batch deleted rows whose photos had living siblings. |
| **Fix (recovery)** | `sudo aws s3 sync s3://ea-sys-dr-singapore/uploads/ /home/ubuntu/ea-sys/public/uploads/ --region ap-southeast-1 --exclude "*.gitkeep"` then `chown -R ssm-user:ssm-user` + `chmod -R u+rwX,go+rX` on the uploads tree (the tree is owned by uid 1001 — the container's write uid — so a plain `sudo -u ubuntu` sync gets `EACCES`). The DR mirror is **non-deleting**, so every destroyed file was still there. Verified: the reported photo returned `200 OK`. |
| **Fix (durable)** | [src/lib/photo-cleanup.ts](../src/lib/photo-cleanup.ts) `deletePhotoIfUnreferenced()` — all three DELETE routes now count remaining references across **Attendee + Speaker + Contact** (the three `photo` columns in the schema) and unlink only at zero. Never throws (cleanup must not fail a committed delete); a skipped unlink logs `photo-cleanup:still-referenced`. Same shape as the media library's `findMediaReferences` guard. |
| **Status** | Restored + guard shipped |

### How it was diagnosed
The file was **present in the DR mirror but absent on the box** (`aws s3 ls` vs SSM `ls`) — proving it once existed on the host and was later deleted. The folder's mtime pinned the deletion to 12:45:55 UTC July 24. Eliminated in order: manual shell activity (`last` empty, no `rm` in any history), deploys (no `git clean` anywhere; uploads gitignored + bind-mounted), the docker-prune cron (Fridays 03:00), root cron (the 12:45:01 entry was sysstat). The breakthrough was grepping for file-deletion code paths: `storage.ts` exports `deletePhoto()`, called by exactly the three entity DELETE routes — and photo paths are shared by design.

### The rule and the prevention
- **A file referenced by copied paths is shared state — deleting the row must not delete the file until the LAST reference is gone.** Any future column that stores a file path either gets its own reference-checked cleanup or no delete-time unlink at all.
- **An orphaned file is cheap; a wrongly-deleted shared file is data loss.** When the reference check itself fails, the guard skips the unlink (fail-safe direction).
- **The DR mirror being non-deleting is what made this a SEV-3 instead of permanent loss** — do not "optimize" the hourly uploads sync with `--delete`.

---

## Appendix — How to diagnose a frozen box

When the site times out but the instance is "running" (the INC-001 pattern):

1. **Rule out DNS** — `dig +short events.meetingmindsgroup.com @8.8.8.8` (should be the EIP).
2. **TCP vs HTTP** — `nc -vz <eip> 443` (TCP) vs `curl https://…/api/health`. If TCP
   connects but HTTP hangs → it's **userland**, not the network.
3. **Even `:80` redirect hangs?** → nginx itself is frozen (not the app upstream).
4. **Try SSM** — if a command sticks `Pending`, **the OS is frozen**, not one service.
5. **CloudWatch (works when the OS is frozen)** — `CPUUtilization`, **`CPUCreditBalance`**
   (t3 trap), `NetworkIn` (flood?), `StatusCheckFailed`. Memory/disk are **NOT** here.
6. **If it's frozen and unreachable → reboot** (`aws ec2 reboot-instances`); fall back to
   force stop/start (EIP stays) if the soft reboot is ignored.
7. **Post-mortem after recovery** (evidence persists): `journalctl -b -1` (previous boot),
   `df -h`, `free -m` + `swapon --show`, `docker inspect … {{.RestartCount}}/{{.State.OOMKilled}}`,
   on-disk `logs/error.log`, and **CloudWatch Logs** `ea-sys/app` (shipped before the freeze).
   ⚠ Mind the timezone — CloudWatch console shows GST(+4); `journalctl --utc` is UTC.
