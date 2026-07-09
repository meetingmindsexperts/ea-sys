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
| **Host metrics** | CloudWatch `GetMetricData` | EC2 **CPU %**, **CPU credit balance** (the t3 throttle trap), memory, disk. |
| **Cron / Jobs** | our own `JobRun` table (Postgres) | Each background-worker cron: **last run + OK/FAILED**, duration, 24h OK/fail counts, and worker liveness ("last seen"). **Zero AWS cost** — it's our DB. |

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
