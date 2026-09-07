# Infra / Ops panel

> An **ADMIN + SUPER_ADMIN** admin page at **`/admin/infra`** that surfaces the infra
> signals that actually bite us — **deploys, email (SES) health, CloudWatch alarms, and host
> metrics** — read-only, **on-demand** (60s server cache so it can't run up AWS cost). It
> replaces SSH / AWS-console hunting for the common "is something wrong?" questions.

## What it shows

| Card | Source | Answers |
|---|---|---|
| **Deploys** | GitHub Actions API | Last 10 "Deploy to EC2" runs — status, commit title, when (with a link). *Spot a stuck/queued deploy.* |
| **Email (SES)** | SES `GetAccount` + CloudWatch `AWS/SES` | Sending enabled? sandbox? 24h quota used, max send rate, **bounce / complaint rate**, 24h send/bounce/complaint counts. *"Why didn't the email send?"* |
| **Alarms** | CloudWatch `DescribeAlarms` | Anything currently in **ALARM** — one-glance "is something on fire". |
| **Host metrics** | CloudWatch `GetMetricData` | EC2 **CPU %**, **CPU credit balance** (t3 throttle trap), memory, disk, **network in/out**, **instance status check**. All in one GetMetricData call (~free). |
| **Cron / Jobs** | our own `JobRun` table (Postgres) | Each background-worker cron (full roster): **last run + OK/FAILED**, schedule, duration, 24h OK/fail counts, worker liveness. Never-run jobs show "awaiting first run". **Zero AWS cost.** |
| **Recent errors & warnings** | our own `SystemLog` (Postgres) | Latest 15 `error`/`warn` lines (app + worker), with a link to `/logs`. **Zero AWS cost.** |
| **Email failures** | our own `EmailLog` (Postgres) | Recent `FAILED` sends (to / subject / error) — the actual failures behind the SES aggregate rates. **Zero AWS cost.** |
| **Uploads storage** (Sep 7, 2026) | S3 `ListObjectsV2` + `ListObjectVersions` on `ea-sys-uploads`, CloudWatch `AWS/S3`, six bucket `Get*` reads | Live inventory of the bucket behind `/uploads` (objects, size, newest upload, by prefix), what versioning is costing, S3's own daily size and count, **requests / GET / PUT / 4xx / 5xx / first-byte latency** once request metrics are on, six configuration checks (versioning, KMS, public-access block, Bucket Key, lifecycle, access logging) and whether access logs are still being delivered. The Singapore mirror's object count sits beside the source count: the mirror never deletes, so it must hold every source object old enough to have been synced, and fewer means the hourly copy is skipping files. The daily digest pages on a critical check regressing or on a mirror deficit, and warns on 5xx errors and on access logs that stop arriving. See §4 for the two owner-side toggles. |

Each card degrades independently: if a source fails (e.g. the IAM below isn't attached yet),
that card shows a friendly error and the rest still render.

## Prerequisites (apply these on AWS — the app can't grant its own permissions)

### 1. IAM — read-only, on the EC2 **instance role**
The app uses the instance role's credentials (same chain as SES). Attach this inline policy
to **`ea-sys-mumbai-ec2-role`** (read-only; no writes, no CloudTrail):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InfraOpsReadOnly",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:DescribeAlarms",
        "cloudwatch:GetMetricData",
        "ses:GetAccount"
      ],
      "Resource": "*"
    }
  ]
}
```
CloudWatch/SES read actions don't support resource-level scoping, so `Resource: "*"` is
standard for them. Until this is attached, the **Alarms**, **Host metrics** and **Email**
cards show *"Missing IAM permission…"* — that's expected, not a bug.

> **✅ Attached 2026-08-12** as inline policy **`EaSysInfraRead`** on
> `ea-sys-mumbai-ec2-role`. Verify with:
>
> ```bash
> aws iam get-role-policy --role-name ea-sys-mumbai-ec2-role --policy-name EaSysInfraRead
> ```
>
> **It had never been attached before that**, and the three cards worked anyway
> because `/home/ubuntu/ea-sys/.env` carried a long-lived access key for an
> IAM user holding `AdministratorAccess`, and the SDK credential chain prefers
> env over the instance role. So this section described the intended state
> while production ran on a human's admin credential. Attaching the policy was
> the precondition for removing that key; the full sequence is in
> `docs/runbook-ses.md` §"Retiring an env credential".
>
> The lesson generalises past this feature: **a permission that is documented
> but never attached is indistinguishable from one that works, for as long as
> something broader is quietly covering it.** If a doc says a role needs X,
> check the role actually has X rather than checking the feature works.

### 1b. IAM — uploads bucket reads (Sep 7, 2026)

The **Uploads storage** card needs read actions the storage policy does not carry.
`UploadsS3Storage` grants `s3:ListBucket` (so the inventory works on day one) but
none of the configuration reads, and the six checks then show *"not readable"*,
which the daily digest reports as **unverified, not as a pass**. Attach this inline
policy to `ea-sys-mumbai-ec2-role` as **`EaSysUploadsRead`**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "UploadsBucketConfigRead",
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketVersioning",
        "s3:GetEncryptionConfiguration",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetLifecycleConfiguration",
        "s3:GetBucketLogging",
        "s3:GetMetricsConfiguration",
        "s3:ListBucketVersions"
      ],
      "Resource": "arn:aws:s3:::ea-sys-uploads"
    },
    {
      "Sid": "UploadsAccessLogsList",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::ea-sys-uploads-logs"
    }
  ]
}
```

Every action is a read. `cloudwatch:GetMetricData` on `*` from `EaSysInfraRead`
already covers the S3 metrics, so nothing CloudWatch-side changes. Verify with:

```bash
aws iam get-role-policy --role-name ea-sys-mumbai-ec2-role --policy-name EaSysUploadsRead
```

### 2. GitHub token (optional — only the Deploys card)
Add a **fine-grained PAT** with **read-only Actions** on the repo to the app's env:
```
GITHUB_OPS_TOKEN=github_pat_...
GITHUB_OPS_REPO=meetingmindsexperts/ea-sys   # default; override if the repo moves
```
Without it, the Deploys card just says *"Set GITHUB_OPS_TOKEN…"* — everything else works.

### 3. Instance id (usually automatic)
Host metrics need the EC2 instance id. On the box it's **auto-detected via IMDSv2** — no
config. If detection ever fails, set `EC2_INSTANCE_ID=i-…` explicitly. (Memory/disk also
require the CloudWatch **agent** to publish `mem_used_percent` / `disk_used_percent`; if it
only ships logs, those two tiles show "—" and CPU still works.)

### 4. Uploads request metrics + access logs (owner, once)

Two things the card reads only after they are switched on. Both are S3-side
settings the app cannot make for itself.

**Request metrics** (requests, GET, PUT, 4xx, 5xx, first-byte latency): a
per-bucket metrics configuration, billed as CloudWatch custom metrics, about
5 dollars a month. Until it exists the card says "not enabled" rather than
"0 requests", because a series with no datapoint is not zero traffic.

```bash
aws s3api put-bucket-metrics-configuration --bucket ea-sys-uploads --region ap-south-1 \
  --id EntireBucket --metrics-configuration '{"Id":"EntireBucket"}'
```

The id is what CloudWatch calls the `FilterId` dimension. `EntireBucket` is the
default the card reads; a different id goes in `S3_UPLOADS_METRICS_FILTER_ID`.
First datapoints appear within about 15 minutes.

**Access logs** (one line per request: who fetched which object, when, from
where): S3 server access logging into a separate bucket, which then seeds the
log warehouse. Steps, all in the console unless noted:

1. Create `ea-sys-uploads-logs` in **ap-south-1** (the destination must be in the
   same region as the source), Block Public Access on, default encryption
   **SSE-S3** (access logs carry request metadata, not file bytes, and the log
   delivery service cannot be relied on to write to an SSE-KMS destination).
2. Lifecycle rule on that bucket: transition to Glacier Deep Archive after 90
   days, **no expiry**. Logs are archived, never deleted. One thing to know
   about that rule: S3 applies a default minimum object size of 128 KB to
   transitions, and an access-log object is usually a few KB, so the rule
   leaves most log files in Standard. That is the cheaper outcome anyway. The
   Glacier classes bill about 40 KB of index overhead per object, so archiving
   a 3 KB file costs roughly three times what keeping it in Standard does. The
   warehouse job should compact a day's logs into one gzipped object, which is
   then large enough to archive for real.
3. On `ea-sys-uploads` → Properties → Server access logging → Enable: destination
   `s3://ea-sys-uploads-logs/uploads-access/`, log object key format
   **date-based partitioning, event time**. The console adds the bucket policy
   that lets `logging.s3.amazonaws.com` write; enabling it from the CLI does not.
   As configured on Sep 7, 2026 the key format is the **simple prefix**
   (`uploads-access/2026-09-07-10-15-00-<id>`). The card reads both formats.
   Switch to date partitioning from the same screen before the warehouse job is
   built; partitioned keys (`.../2026/09/07/...`) are what Athena wants.
4. Attach the `EaSysUploadsRead` policy above (its second statement lists the log
   bucket).

All four steps were completed on Sep 7, 2026 (verified read-only: logging on,
destination in ap-south-1, SSE-S3, Block Public Access on, delivery policy
present, lifecycle rule enabled). Delivery is best-effort with a lag of up to a few hours. The card reads only
today's and yesterday's folders, so a bucket that keeps logs forever never makes
the page slower. The digest warns when a day passes with requests served and no
log delivered.

## Cron / Jobs — how it's sourced

The worker's `withJobLock` (the single choke point every cron tick passes through) writes
**one `JobRun` row per tick** — `job`, `startedAt`/`finishedAt`, `status` (OK/FAILED),
`durationMs`, `error`. **Why a table and not logs:** healthy ticks log at `debug`, which the
SystemLog writer skips, so logs can show *failures* but not a reliable *"last good run"* — the
`JobRun` table is the durable record. Skips (lock held elsewhere) are **not** recorded (they're
logged, not runs). Rows are pruned to **14 days** by the hourly `mcp-oauth-cleanup` job
(piggybacked, no extra schedule). Volume is ~2.5k rows/day across all jobs — trivial.
Covers: cert-issue, scheduled-emails, webinar-recordings, webinar-attendance,
mcp-oauth-cleanup, invoice-reconciliation. Files:
[src/lib/job-run.ts](../src/lib/job-run.ts) (record + prune),
[worker/lib/advisory-lock.ts](../worker/lib/advisory-lock.ts) (records inside the lock).
Migration `20260709120000_add_job_run` (additive). **No IAM / AWS needed for this card.**

## Cost & safety
- **On-demand only** (a Refresh button), never polled, and a **60s server cache** means even
  a hammered refresh hits AWS at most once per minute. Per-user rate limit 60/hr as a backstop.
- **Read-only** end to end; ADMIN/SUPER_ADMIN gated at the API and the page; every guard logs.
- Region: `AWS_CLOUDWATCH_REGION || AWS_REGION` (default `ap-south-1`).

## Where it lives
- Lib: [src/lib/infra/aws-ops.ts](../src/lib/infra/aws-ops.ts) (snapshot + cache + per-source isolation + IMDS)
- API: [src/app/api/admin/infra/route.ts](../src/app/api/admin/infra/route.ts) (`GET`, `?refresh=1` to force)
- Page: [src/app/(dashboard)/admin/infra/page.tsx](../src/app/%28dashboard%29/admin/infra/page.tsx) + sidebar "Infra / Ops" (adminOnly)

## Deliberately out of scope (v1)
CloudTrail (who-did-what — more sensitive/setup), raw CloudWatch **log browsing** (use the
`/logs` dashboard for app logs, or deep-link to the Logs Insights queries in
[AWS_OPERATIONS.md](AWS_OPERATIONS.md)), and billing/cost. Add later if wanted.
