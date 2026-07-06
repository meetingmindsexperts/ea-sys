# Production Readiness — backlog & status

> EA-SYS runs live events with real registrations, payments, and onsite check-in
> on a single Mumbai EC2 box + Supabase Postgres. This is the honest maturity
> gap list beyond "it works." Ordered by **what actually bites you**, not by
> theoretical completeness. Started 2026-07-06.

## ✅ Done / solid

- **Deploys**: blue-green on the box + a hard gate (tsc / lint / vitest / build)
  + adversarial review on substantial work. Rollback = keep last 3 ECR tags.
- **Error alerting** (seconds–1 min): Sentry + SES email on every `error` log +
  CloudWatch Logs (`ea-sys/app`, `ea-sys/error`) + the in-app `/logs` viewer.
- **Outage detection** (~1.5–2 min): Uptime Robot (external) **and** Route 53
  health check → `ea-sys-health-down` (us-east-1) → SNS email. Two vantage points.
- **Box health alarms** (2026-07-06): `ec2-status-check-failed`, **`ec2-auto-recover`**
  (auto-recovers a hardware-dead box, same id/EIP/EBS), `ec2-cpu-high`,
  `ec2-cpu-credits-low` (t3 burst trap), `ec2-disk-high` (the INC-002 catch),
  `ec2-mem-high`. Two alert recipients (krishna@, vivek@meetingmindsdubai.com).
- **DR backups**: `pg_dump` → Singapore S3 every 2h (RPO ≤2h day / ≤4h night),
  uploads hourly, `.env` daily; **quarterly restore drill** validates the dump
  restores clean. Runbooks in `infra/dr/README.md`.
- **Security hardening**: nginx per-IP rate limiting + fail2ban, `npm audit` in
  CI, audit-driven IDOR/race fixes, SSM-only access (no open SSH reliance).

## 🔴 Open — ranked by risk

| # | Gap | Risk if unaddressed | Effort | Notes / first step |
|---|-----|---------------------|--------|--------------------|
| 1 | **DR failover never drilled** | RTO is a ~30min–2h *manual* runbook, unrehearsed — a full box loss mid-event is a scramble | Med | Schedule a low-traffic-window drill: spin the Singapore box (terraform), restore the latest dump, repoint DNS, **time it**. Converts RTO from guess → known. `ec2-auto-recover` already covers the *hardware* case automatically. |
| 2 | **Capacity never load-tested** | A 500–2000 check-in rush or 5k webinar could tip the single `t3.large` over — during a live event | Med | k6/artillery against `/register`, checkout, check-in, and `/health` at expected concurrency, on a clone or a quiet window. |
| 3 | **Onsite check-in has no offline fallback** | Box/network blip at the badge desk = check-in dead | Med | Local-cache/queue the scan flow, or a documented paper/CSV fallback + reconcile. |
| 4 | **"Up" ≠ "working" — no synthetic canary** | Health checks pass while register/pay is silently broken (bad deploy, Stripe/DB edge) | Low–Med | Uptime Robot keyword check on a known-good page, or a scheduled Lambda that runs a real register→confirm against a test event. |
| 5 | **RPO 2–4h on paid registrations** | Losing up to 4h of *event-day* registrations + payments to a `pg_dump` gap | Low ($) | Enable Supabase PITR (near-zero RPO, ~$25–50/mo) — deferred purely on cost. Revisit before the next large paid event. |
| 6 | **DB-backup freshness unmonitored** | If `dr-pg-dump.sh` silently stops (or box down), no page | Low | Heartbeat metric on success + a 3h `LessThanThreshold`/breaching alarm (details in `docs/AWS_OPERATIONS.md` §1.7). |
| 7 | **No staging environment** | Every deploy incl. migrations lands on prod; nowhere to rehearse a risky change vs prod-like data | Med | A cheap staging stack (separate Supabase branch + a small box or Vercel preview). |
| 8 | **Secrets live on the box** (`.env`, plaintext `CRON_SECRET`) | A box compromise leaks everything at once | Med | Move to AWS Secrets Manager / SSM Parameter Store (documented target, not yet reality). |
| 9 | **No incident-response process** | Alerts fire to two inboxes, but no on-call/escalation or per-scenario playbook | Low (process) | A one-page "when X fires, do Y" runbook + who-responds; link the DR runbook. |
| 10 | **No metric/latency SLOs or business dashboards** | No signal on p95 latency, DB pool saturation, slow queries, or registration/payment success rate | Med | CloudWatch dashboard + a couple of latency/error-rate alarms; or an APM if it earns its keep. |

## Notes
- Items 1–3 are the ones most likely to hurt during an actual event; 5 is the
  cheapest big risk-reduction (just money). 4 and 6 close "silent" failure modes.
- Related deep docs: `infra/dr/README.md` (DR), `docs/AWS_OPERATIONS.md` (ops +
  monitoring §1.7), `docs/INCIDENTS.md` (post-mortems), `docs/MULTI_TENANCY_IMPACT.md`
  (if white-label lands, it reshapes several of these).
