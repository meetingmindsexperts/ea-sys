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
| **Root cause** | The Next.js production build's memory/CPU/IO, on a **t3.large (8 GB RAM) with NO swap** and the app already using ~4.4 GB, exhausted memory. With no swap cushion the kernel thrashed and **froze all of userland** (nginx, the app, *and the SSM agent*). |
| **Fix** | Rebooted the instance (`aws ec2 reboot-instances`). Came back clean. |
| **Status** | Resolved. **Follow-up required: add swap, then re-run the deploy** (the new image never built — see below). |

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

### ⚠ Open item — the new image never deployed
The box is healthy but running the **pre-deploy image**. **Adding swap MUST come
before the next deploy**, or `docker compose build` will starve and freeze the box
again identically.

### Action items (prevention)

| # | Action | Why | Status |
|---|---|---|---|
| 1 | **Add a 4 GB swap file** (`/swapfile`, `swapon`, `fstab`, `vm.swappiness=10`) | The single missing cushion. A swapless box has no margin — a transient memory spike = instant freeze instead of a slow-down. | **TODO — do before any re-deploy** |
| 2 | **Build the image in CI, not on the box** — GitHub Actions → build → push to ECR → box does `docker compose pull && up` (no on-host build) | Removes the heavy build from the prod host entirely — the actual root cause. The CLAUDE.md CI/CD section already describes this as the intended flow; the box is currently doing `docker compose build` locally instead. | TODO |
| 3 | **Ship memory + disk metrics to CloudWatch** (the agent currently ships *logs* only) + an alarm on `mem_available < 500 MB` | We were blind on memory during the incident — that's why diagnosis was slow. Metrics + alarm would have paged *before* the freeze. | TODO |
| 4 | **External uptime check on `/api/health`** (Route 53 health check or UptimeRobot) → alert when the *site* is down even though the instance "looks ok" | EC2 status checks passed throughout — they don't catch a frozen-but-running box. Only a real HTTP probe does. | TODO |
| 5 | **Cap container memory** (`mem_limit` in `docker-compose.prod.yml`) | So one container (or a build) can't consume all host RAM and take everything down. | Consider |
| 6 | If builds stay on-box: **constrain build memory** (`NODE_OPTIONS=--max-old-space-size`, lower concurrency) and `nice`/`ionice` it | Reduces the build's blast radius until #2 lands. | Consider |

**Quickest risk reduction:** #1 (swap) immediately, then #2 (build off-box). #1
alone would likely have turned this SEV-1 freeze into a slow deploy.

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
