# EA-SYS — Maintenance Log

Planned production changes: what was done, when, what it cost in downtime, what
was verified afterwards, and what the job taught us. Newest first.

**This is the counterpart to [INCIDENTS.md](INCIDENTS.md), and the distinction
is the point.** An incident is something that happened to us; a maintenance
entry is something we chose to do, in a window we picked, with a rollback we
prepared first. They are separated because the useful questions differ: an
incident asks *what broke and how do we stop it recurring*, a maintenance entry
asks *did the change do what it claimed, is the rollback still open, and what
did the estimate get wrong*.

Each entry ends with **Outstanding**, because a maintenance job is usually not
finished when the window closes — a bake period and a cleanup step normally sit
behind it, and those are exactly the steps that get forgotten once the thing
appears to work.

---

## MAINT-001 — Encrypting the EC2 root volume

**Date:** 2026-08-21
**Window:** 13:06:43 → 13:14:27 UTC · **7 min 45 s** (estimate was 7–10 min)
**Runbook:** [EBS_ENCRYPTION_RUNBOOK.md](EBS_ENCRYPTION_RUNBOOK.md)
**Outcome:** ✅ succeeded, no rollback needed, no data loss

### Why

The EC2 root volume was `Encrypted: false`. That was the weakest answer on the
client security questionnaire — [SECURITY_AND_PRIVACY_POSTURE.md](SECURITY_AND_PRIVACY_POSTURE.md)
§0.2 — because **uploaded files live on that volume**, including the prefixes
that will eventually hold passport scans and bank details. It was a gap in the
*control* rather than an exposure (no such document had ever been uploaded), but
it had to close before those documents are collected.

The database is Supabase and lives off the box, so nothing transactional was at
risk in this window.

### What was done

| | |
|---|---|
| Instance | `i-0b51ab1213d084640`, `t3.large`, `ap-south-1b` |
| Old root volume | `vol-073ca563deaa8732a` — 50 GB gp3, 3000 IOPS, 125 MB/s, **unencrypted** |
| Warm-up snapshot | `snap-0bd0ad84dc2085d2e` — 12:38:51 → 13:03:25 UTC, **~25 min, zero downtime** |
| In-window snapshot | `snap-0a6e485dfeee176af` — **~35 seconds** |
| New root volume | `vol-08f22cd184c2bf880` — 50 GB gp3, 3000/125, **`Encrypted: true`**, key `alias/aws/ebs` |
| Elastic IP | `3.108.247.193` retained across stop/start — **no DNS change** |
| Executed via | AWS Console (CLI used for verification reads between steps) |

The `copy-snapshot` step was correctly skipped: account-level default EBS
encryption is on in `ap-south-1`, so `CreateVolume` from an *unencrypted*
snapshot produces an *encrypted* volume.

### Verified after

| Check | Result |
|---|---|
| Root device | encrypted volume attached at `/dev/sda1` |
| Filesystem | 48 G, 31 G used, 65 % — clean, correct size |
| Uploads | all 7 prefixes present, **516 files** |
| Containers | `ea-sys-green` healthy · `ea-sys-worker` healthy · `mediamtx` up |
| Crontab | 45 lines intact |
| App | `/health` 200 · `/worker/health` 200 · uploads 200 · **private prefix 403** · login 200 |

The private-prefix 403 is checked deliberately: the allow-list in
[upload-prefixes.ts](../src/lib/upload-prefixes.ts) is enforced by the app, and a
disk swap is exactly the kind of change that could plausibly restore an old
`public/` tree underneath it.

### What made it safe

**Nothing in the procedure modified the original volume.** A snapshot is a read;
the encrypted volume is a new object; the original was detached, not erased. So
at every step before cleanup, rollback was "reattach the disk you already have",
about five minutes — a stronger position than any backup, because the original
disk itself was sitting there intact.

### What we got wrong, and what it teaches

**1. The warm-up snapshot took 25 minutes, not the "minute or two" predicted.**
The estimate assumed a root disk that changes slowly. It does not: **this box
deploys by pulling Docker images onto the root volume**, and there had been six
deploys that day. Each one writes a fresh image layer set.

> On a box that deploys via `docker compose pull`, the root disk is one of the
> **fastest**-changing things in the system, not one of the slowest.

Consequence worth carrying: a warm-up is most valuable *after* a busy deploy day,
and the no-deploy rule between warm-up and window matters more than it looks —
anything pushed in between lands in the in-window snapshot and stretches the
downtime directly.

**2. EBS `Progress` is coarse and non-linear.** It reported 0 % for ten minutes,
then 36 % for five, then jumped to 54 %, then finished. Do not extrapolate from
it, and do not treat a stalled percentage as a stuck job.

**3. A second concurrent snapshot would not have helped.** Asked during the wait.
EBS increments are computed against the last **completed** snapshot, so a second
one started mid-flight inherits the same base and has the identical blocks to
upload — same work, competing for the same bandwidth.

**4. Force-stop ("skip OS shutdown") was declined, and that was load-bearing.**
The reason we stop the instance at all is to get a *filesystem-consistent*
snapshot, and that snapshot is what the new root disk is built from. A forced
stop leaves dirty buffers unwritten, which would have turned a safe, reversible
job into one that might boot into a torn filesystem. **Force-stop is a recovery
tool for an unresponsive box, never a time-saver on a healthy one.**

**5. The payoff was real and measurable.** 25 minutes of copying with the box
**up**; 35 seconds with it **down**. That ratio is the entire argument for the
warm-up step.

### Found during the window, and fixed the same day

For roughly 90 seconds while the containers came up, every visitor got a bare
`502 Bad Gateway / nginx/1.24.0 (Ubuntu)`. That reads as broken rather than
"briefly down", and it discloses the server and version.

✅ **Fixed** — [deploy/maintenance/](../deploy/maintenance/), applied to the box
the same afternoon with zero downtime (nginx reload is graceful). Verified live:

| | |
|---|---|
| Status | **503**, not 502 and not 200 |
| Headers | `Retry-After: 600`, `Cache-Control: no-store`, `Server: nginx` (version gone) |
| HTML branch | correct page, 3206 bytes, **zero external resources** |
| API branch | `Content-Type: application/json`, and it **parses** — `code=MAINTENANCE` |
| Direct request | `/maintenance.html` → 404 (`internal`), so it cannot be indexed |
| Normal traffic | unchanged throughout — health, login, uploads 200, private 403, MCP 401 |

**Two things this taught, beyond the page itself.**

*The status code is the whole design.* A `200` would have told Google the page
is genuinely that content and told Uptime Robot the site was healthy while it
was down — a maintenance page that lies to monitoring is worse than a raw 502,
because the 502 at least alarms.

*Verify an outage page without an outage.* The obvious test is to stop the app,
which is the thing the page exists to soften. Instead a throwaway `location`
pointing at port 9 (`discard`) gets its connection refused, which produces the
real 502 that triggers `error_page` — the entire chain proven on a healthy
server, then removed. **A permanent endpoint that always 503s is a trap for the
next reader**, so removing it was part of the job, not an afterthought.

And one correction worth recording: I first said the JSON branch had no
one-line probe because `/api/` is claimed by the proxy locations. That was
wrong — an **exact-match** `location = /api/__maint_test` outranks both prefix
matches. It was tested, and it was the only part that had shipped untested.

### Outstanding

- [ ] **Bake period — keep `vol-073ca563deaa8732a` for at least a week** (two if
      the calendar is clear). It is the rollback, and at 50 GB gp3 it costs about
      $4/month against that option value. **Deleting it is the only irreversible
      step in this procedure.**
- [ ] **Decide `DeleteOnTermination` deliberately.** The original root had it
      `true`; the newly attached volume defaults to `false`, which is safer
      during the bake. Do not simply inherit it.
- [ ] **Delete the unencrypted snapshots** once the bake ends. There are
      **four**, not the three the runbook anticipated — a warm-up was taken on
      Aug 20 as well as on the day:
      `snap-08e84992f929dc0b4` (April), `snap-0a2d36c0550251e81` (Aug 20
      warm-up), `snap-0bd0ad84dc2085d2e` (Aug 21 warm-up),
      `snap-0a6e485dfeee176af` (the in-window one). Each
      is a full plaintext copy of the same data, so leaving them keeps the §0.2
      finding alive in substance even though the live disk is encrypted.
- [ ] **Maintenance page** for the nginx 502 (above).
