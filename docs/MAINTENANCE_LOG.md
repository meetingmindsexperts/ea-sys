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

## MAINT-002 — Moving uploaded files from the server disk to S3

| | |
|---|---|
| **Date** | 2026-09-07, 06:20 to 06:50 UTC (Monday morning, no live event) |
| **Downtime** | None. The provider switch rode an ordinary blue-green redeploy (~22 s) |
| **What changed** | `public/uploads` (536 files, 67.5 MB) now lives in the private bucket `ea-sys-uploads` (ap-south-1), versioned, encrypted under the customer-managed key `alias/ea-sys-uploads`. The app reads and writes it through `STORAGE_PROVIDER=s3`. Stored paths in the database did not change. The disk keeps a frozen copy of the pre-move files |
| **Rollback** | `sudo aws s3 sync s3://ea-sys-uploads/ /home/ubuntu/ea-sys/public/uploads/`, then `STORAGE_PROVIDER=local` + `deploy.sh`. Still open, deliberately, for as long as the disk exists |

### What was done, in order

1. KMS key `alias/ea-sys-uploads` (symmetric, single-Region, customer-managed; the instance role granted Encrypt/Decrypt/GenerateDataKey in the key policy; rotation left off).
2. Bucket `ea-sys-uploads`: all four public-access blocks, versioning, SSE-KMS default under that key, Object Lock off, no bucket policy. Bucket Key left off by mistake; cost-only, still off.
3. Inline policy `UploadsS3Storage` on `ea-sys-mumbai-ec2-role` (object read/write/delete, bucket list, the four KMS actions on that key only).
4. Probe from the box through the role: write, read back, delete. Landed as `aws:kms` under our key without the caller asking for encryption, which is the property that makes the bucket safe: encryption is not a parameter a caller can forget.
5. `.env`: `S3_UPLOADS_BUCKET`, `S3_UPLOADS_REGION`; provider still `local`.
6. Migration from inside the worker container: dry run, `--write`, `--verify`. Then an independent check that did not trust the script: SHA-256 over the sorted path-and-size list of the disk versus the bucket, identical, 535 files + `photos/.gitkeep`, 70,755,395 bytes.
7. `STORAGE_PROVIDER=s3`, `deploy.sh`, post-deploy `--write` sweep (copied 0).
8. DR mirror cron re-pointed from the disk to the bucket (see "What the plan got wrong").

### Verified after

- Both live containers carry the three variables; the web tier logged `storage:s3-client-initialised` on the first request after the flip.
- A real photo URL: 200, `image/jpeg`, 60,731 bytes, the S3 object's exact size.
- Private prefixes (`reimbursements`, `speaker-docs`, `resident-letters`) still 403; a missing public file 404, not 500.
- `/health` and `/worker/health` 200; zero `storage` lines in the error log.
- Crontab: zero disk-sourced mirror lines, one bucket-sourced; a `--dryrun` of the new line under the role exited 0.

### What the plan got wrong, and what it teaches

- **The DR mirror.** The plan said the hourly Singapore sync "keeps working because it reads local disk". After the flip the provider writes to S3 only, so the disk freezes and the disk-sourced mirror would have re-synced a frozen folder every hour, heartbeat included, while every new upload had one copy. Caught because the owner asked "what happens to the Singapore backup once we move" before the flip. The lesson is the shape, not the line: **a monitoring signal attached to a stale source keeps reporting success**, and a plan reviewed for correctness was not stressed against the question "what does this sentence assume".
- **`docker exec` and `.env`.** A running container does not see lines added to `.env` after it started; compose injects the file at start and does not mount it. The pre-cutover script runs needed explicit `-e` flags. Recorded in the plan's Phase 3.
- **The count.** `find` said 537, the script said 536; the difference was `public/uploads/.gitkeep`. Reconciled before writing rather than assumed.

### Outstanding

- [x] **First bucket-sourced mirror run** observed at 07:00 UTC: the one-off full copy (67.9 MB, S3-to-S3 sync compares timestamps and the bucket copies are newer than the disk-sourced ones), heartbeat 06:00:07 → 07:00:40, Singapore mirror 541 → 542 objects. The 542nd is `photos/2026/09/53e12872…jpg`, uploaded through the app AFTER the flip: it exists in the bucket and not on the disk, and it reached Singapore. Under the old disk-sourced line it would have had one copy.
- [x] **Bucket Key** on `ea-sys-uploads`: enabled Sep 7, 2026 (verified: `BucketKeyEnabled: true`, same KMS key, SSE-C still blocked). Applies to objects written from now on; the 537 existing objects keep their own data keys, which costs cents and is not worth a re-copy.
- [ ] **Lifecycle for noncurrent versions** on `ea-sys-uploads`: expire noncurrent versions after N days, delete expired delete markers, abort incomplete multipart uploads after 7 days. N is an owner decision (30 / 90 / 365; 90 recommended). The card's "Lifecycle" check names it until a rule exists.
- [x] **`EaSysUploadsRead` inline policy** on `ea-sys-mumbai-ec2-role` (docs/INFRA_OPS.md §1b): attached Sep 7, 2026, 14:00 UTC; simulate-principal-policy allows all seven actions.
- [x] **Request metrics** on `ea-sys-uploads`: filter `EntireBucket` created Sep 7, 2026 (INFRA_OPS.md §4).
- [x] **Access logs**: `ea-sys-uploads-logs` created Sep 7, 2026 (ap-south-1, SSE-S3, Block Public Access, lifecycle `archive-never-delete` to Deep Archive after 90 days, no expiry) and logging enabled on the uploads bucket to `uploads-access/`, **simple prefix** (switch to date partitioning before the warehouse job; the card reads both). Note the 128 KB transition minimum: most access-log objects stay in Standard, which is the cheaper class for objects that small (INFRA_OPS.md §4).
- [ ] **A second encrypted snapshot of the root volume** next week, now that the disk holds nothing irreplaceable; then one every few weeks is plenty.
- [ ] **Platform silo:** born on its own bucket and key, with `{orgId}`-prefixed keys injected from the tenant context. Not on master.
- [ ] **UAE (`me-central-1`)** when the region recovers: new bucket, new key, same script.

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

### Aftermath (Aug 24, 2026)

A `create-snapshot` from the runbook was re-run by accident against
`vol-073ca563deaa8732a`, the retained rollback volume. No impact: that volume
has been detached and unchanged since the swap, so the incremental was empty
and completed instantly, and cost was nil. It was deleted the same day
(`snap-010f28b5bb57a228e`), leaving the four originals.

The lesson is not "be careful with the CLI". It is that **an as-executed record
reads as a recipe**: the whole value of writing down exactly what was run is
that it can be run again, which is also the hazard. §5 of
[EBS_ENCRYPTION_RUNBOOK.md](EBS_ENCRYPTION_RUNBOOK.md) now opens with a warning
that its ids are historical and which volume is which.

### Closed (Sep 4, 2026)

The rollback copies were deleted, in the safe order, and the account now holds
**zero unencrypted volumes and zero unencrypted snapshots** (verified read-only
with `describe-volumes` / `describe-snapshots` filtered on `encrypted=false`).

What was done, in order:

1. **An encrypted snapshot of the LIVE root was taken first**:
   `snap-0a5692889cd3243d4` from `vol-08f22cd184c2bf880`, started 10:56 UTC,
   completed in ~25 minutes, `Encrypted=true`. This step was not in the
   Outstanding list and it mattered: the encrypted volume had **no snapshot at
   all** for the two weeks since the swap, so the four plaintext snapshots and
   the detached volume were, by accident, the only disk-level restore points.
   Deleting them first would have left none.
2. `vol-073ca563deaa8732a` (the original plaintext root, detached since Aug 21,
   frozen at that day's contents) deleted.
3. The four plaintext snapshots deleted: `snap-08e84992f929dc0b4` (April),
   `snap-0a2d36c0550251e81`, `snap-0bd0ad84dc2085d2e`, `snap-0a6e485dfeee176af`.
   The last one was briefly kept "as a spare"; it went once it was clear it
   held a strict subset of the encrypted snapshot (the encrypted volume was
   built FROM it and then took two weeks of writes) and was the one remaining
   copy keeping the §0.2 finding open.

Cost, from Cost Explorer for August: snapshots $3.76, gp3 volumes $6.10 (the
detached volume billed the same as the attached one). Expected after cleanup:
roughly $6/month, the live disk plus one ~30 GB-of-blocks snapshot.

`DeleteOnTermination` on the live root reads `false` (checked Sep 4). Left that
way deliberately: a terminated instance keeping its disk is the safer default
for a box rebuilt from a runbook rather than from an image.

The lesson to carry: **a bake period needs an expiry AND a replacement.** The
week-long rollback window was right; what was missing was "and on the day it
ends, snapshot the new volume before deleting the old one", so the cleanup
stalled for a week past the date because nobody wanted to delete the only copy.

### Outstanding

- [x] **Bake period — keep `vol-073ca563deaa8732a` for at least a week** (two if
      the calendar is clear). It is the rollback, and at 50 GB gp3 it costs about
      $4/month against that option value. **Deleting it is the only irreversible
      step in this procedure.**
- [x] **Decide `DeleteOnTermination` deliberately.** (kept `false`, see Closed) The original root had it
      `true`; the newly attached volume defaults to `false`, which is safer
      during the bake. Do not simply inherit it.
- [x] **Delete the unencrypted snapshots** once the bake ends. (done Sep 4) There are
      **four**, not the three the runbook anticipated — a warm-up was taken on
      Aug 20 as well as on the day:
      `snap-08e84992f929dc0b4` (April), `snap-0a2d36c0550251e81` (Aug 20
      warm-up), `snap-0bd0ad84dc2085d2e` (Aug 21 warm-up),
      `snap-0a6e485dfeee176af` (the in-window one). Each
      is a full plaintext copy of the same data, so leaving them keeps the §0.2
      finding alive in substance even though the live disk is encrypted.
- [ ] **Maintenance page** for the nginx 502 (above).
