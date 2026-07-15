# EA-SYS — Incident Log & Outage Post-Mortems

Production incidents, what caused them, how we diagnosed and fixed them, and the
action items to prevent recurrence. Newest first. **This is the first one.**

When prod is down, the fast triage order is in
[docs/AWS_OPERATIONS.md](AWS_OPERATIONS.md) §1.2 (health) and §3 (CPU/mem/disk).
The general method that worked for INC-001 is captured in
["How to diagnose a frozen box"](#appendix--how-to-diagnose-a-frozen-box) below.

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
- Full symptom→fix entry in the `ea-sys-debugging` skill (Migrations section).

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
