# EA-SYS — Support, Maintenance & Operational Requirements

**Audience:** Leadership / management review.
**Author:** Krishna Pallapolu (Development Manager, MMG)
**Last updated:** July 9, 2026
**Purpose:** Establishes what it takes to run, monitor, and maintain the in-house event platform on an ongoing basis. Provides the operational baseline and surfaces decisions that need leadership input.

---

## 1. Executive summary

EA-SYS is the in-house event platform that runs every MMG event (8th OSH, IOHNC, EIGHC, HEMNET, EHC, ICCH, etc.) end-to-end — registration, payments, speakers, abstracts, accommodation, on-site check-in, certificates, and post-event surveys. It replaces fragmented third-party tools (EventsAir, spreadsheets, manual workflows) with one platform that MMG fully owns and controls.

This document is **not** about new features. It's about **what's required to keep the platform healthy** — the people, infrastructure, recurring tasks, monitoring discipline, and vendor relationships that sit behind the scenes when an organiser opens the dashboard each morning.

**One-line summary:** EA-SYS is in a stable, well-monitored, mid-maturity state. The platform is largely self-managing — three layers of automated error detection, daily backups to a different AWS region, and a worker tier that handles cron-driven jobs without human action. What it needs to keep healthy is a budgeted ~8–14 hours/month of recurring maintenance (monitoring, dependency upgrades, DR drills) and the disciplines documented in §4. The items in §9 (Decisions Needed) are where leadership input would unblock specific improvements.

---

## 2. Platform footprint — what we run, where

| Layer | What | Where | Why it matters |
|---|---|---|---|
| **Web application** | EA-SYS dashboard + public registration pages | AWS EC2, Mumbai region (ap-south-1), `t3.large` instance | This is the actual product. If it's down, organisers and registrants can't use the platform. |
| **Background worker** | Cron-driven jobs (certificate rendering, scheduled emails, webinar recording retrieval, attendance sync) | Same Mumbai EC2 box, separate Docker container | If this is down, scheduled emails don't fire, certificates don't render, webinar attendance doesn't sync. Outage isn't immediately visible to users but accumulates. |
| **Database** | PostgreSQL — all event data, registrations, speakers, payments, surveys | Supabase (managed Postgres, Mumbai region) | All operational data lives here. Backed up to AWS Singapore (different region for DR) every 2h during Dubai daytime / 4h overnight (`pg_dump` cron, 10×/day; ≤2h/≤4h RPO). |
| **File storage (live)** | Photos, certificates, uploaded media, generated PDFs | Local filesystem on the Mumbai EC2 box, mounted as a Docker volume shared between the web + worker containers (`/home/ubuntu/ea-sys/public/uploads/`) | Primary copy of every uploaded file. Lives on the same instance as the application — pragmatic at current scale, but means the instance disk is part of the durability story. |
| **File storage (DR mirror)** | Hourly snapshot of all uploaded files | AWS S3 Singapore region (`ap-southeast-1`) | Secondary copy for disaster recovery. Different AWS region from the live instance, so a Mumbai-wide outage doesn't lose files. Mirror lags up to 60 minutes (the cron schedule). |
| **Email delivery** | All outgoing email (registration confirmation, payment receipt, speaker invitation, certificate delivery, admin alerts) | AWS SES (ap-south-1, Mumbai) | If email is down, registrants don't receive confirmations, certificates don't deliver, admin alerts don't fire. Single point of failure for customer communication. |
| **Payments** | Credit card processing | Stripe (US-based, global infrastructure) | Stripe handles the actual payment; we receive webhooks. Stripe rarely fails but its webhook calls into our system are a known fragility point. |
| **Video / Webinars** | Live streaming, recording, attendance | Zoom (separate org credentials per MMG entity) | Webinar events depend entirely on Zoom. Their API calls into our system on session-end to deliver recording URLs. |
| **AI features** | Help chat + AI Event Assistant | Anthropic (Claude API) | AI-driven features (natural-language event commands, help chat). If Anthropic is down, those specific features stop; everything else continues. |
| **Source code + deploys** | Code repository + CI/CD | GitHub (Mumbai EC2 deploy target) | Code change → GitHub push → CI runs → CI builds the image + pushes to ECR → box pulls it → blue-green container swap. The on-box step is ~1–2 min (box pulls, no longer builds). |
| **DNS + email reputation** | `events.meetingmindsgroup.com`, `meetingmindsexperts.com` | GoDaddy (registrar), AWS Route 53 (some DNS) | If DNS goes down, nothing is reachable. Email reputation lives with whoever owns the sender domain (currently `meetingmindsexperts.com`). |
| **Error monitoring** | Real-time error capture | Sentry (cloud SaaS) | Captures every error with stack trace + context. Production safety net. |

**Total infrastructure cost: around $100 USD/month at MMG's actual event volume.** Detailed cost breakdown in §8. The figure scales primarily with Anthropic API usage (AI Agent + Help Chat) and AWS storage, not with event count — adding events doesn't materially increase costs until traffic crosses ~10x today's volume.

---

## 3. Personnel & skills required

### Estimated engineering time required

EA-SYS is largely self-managing day-to-day. The actual time investment to maintain it splits across four categories, each with its own cadence and skill profile.

| Category | Typical time investment | What it covers |
|---|---|---|
| **Daily monitoring + triage** | ~10–20 min / day | Admin-alert inbox check, `/logs` scan for unusual patterns, scheduled-email verification, first-line response to operator-reported issues |
| **Weekly maintenance** | ~30–60 min / week | Sentry review, DR backup verification, worker health check, Dependabot triage, EC2 disk/memory spot-check |
| **Monthly upkeep** | ~2–4 hours / month | Non-critical dependency upgrades, IAM audit, key-rotation tracking, slow-query review, documentation refresh |
| **Quarterly + annual** | ~1 day / quarter + 1–2 weeks / year | DR drill, access review, security audit, vendor cost review, major version upgrades |
| **Bug fixes + feature work** | Variable | Driven by operator requests + audit findings + roadmap |

Adding these up: **roughly 8–14 hours / month of recurring maintenance** at current scale, plus whatever the active feature/bug backlog demands. None of these tasks are large individually; together they're the maintenance baseline that keeps the platform healthy.

### Skills the maintenance role requires

EA-SYS is a substantial system (~149,000 lines of code across registration, payments, speakers, abstracts, accommodation, certificates, surveys, webinar, MCP, AI Agent). The person doing this work needs:

- **TypeScript + Next.js** — the current framework, ~95% of the code
- **PostgreSQL + Prisma ORM** — schema design + migrations
- **AWS administration** — EC2, S3, SES, IAM, CloudWatch
- **Linux server administration** — Ubuntu, Docker, nginx
- **Stripe integration patterns** — payment flows + webhook handling
- **AWS SES email deliverability** — DKIM, SPF, DMARC, reputation monitoring
- **React frontend** — for UI work
- **Command-line / git / GitHub Actions** — daily ops
- **Reading + writing technical documentation** — the discipline that keeps the platform maintainable across time

A mid-to-senior engineer with 5+ years of full-stack experience can pick up the codebase in ~2–4 weeks given the existing documentation (`docs/HANDOVER.md`, `docs/ARCHITECTURE.md`, `docs/MUMBAI_SETUP.md`, `infra/dr/README.md`, `worker/README.md`).

### Documentation as the maintainability backbone

The platform's long-term maintainability is heavily front-loaded into existing documentation. The repo contains:

- **`docs/HANDOVER.md`** — full technical onboarding for a new engineer
- **`docs/ARCHITECTURE.md`** — system design, data flow, decision history
- **`docs/CLAUDE.md`** — current state + recent features in granular detail
- **`docs/MUMBAI_SETUP.md`** — EC2 server bootstrap procedure
- **`docs/EC2_HARDENING.html`** — security posture on the production instance
- **`docs/ERRORS_AND_FIXES.md`** — known bugs, fixes, and lessons learned
- **`infra/dr/README.md`** — disaster recovery procedures
- **`worker/README.md`** — background worker operator guide
- **`docs/MCP_REFERENCE.md`** — every AI tool exposed via MCP
- **`docs/ROADMAP.md`** — feature timeline + planned work + deferred items
- **In-dashboard docs viewer at `/admin/docs`** — every `.md`/`.html` browseable + searchable by ADMIN/SUPER_ADMIN roles, auto-refreshed on each deploy

This documentation is what makes the maintenance role transferable. The work isn't dependent on any one person's memory of how the system works — it's all written down.

### Existing automation that reduces manual effort

The platform invests heavily in self-monitoring + self-healing so the maintenance burden stays low:

- **Three-layer error capture** — Sentry (cloud), SES admin-alert email (~10 sec latency), `/logs` dashboard (Postgres-persisted)
- **Background worker tier** — cron jobs (scheduled emails, webinar recordings, certificate rendering, attendance sync) run automatically with Postgres advisory locks for singleton enforcement
- **Blue-green Docker deploys** — zero-downtime via `scripts/deploy.sh`, no manual coordination. **CI→ECR complete (2026-07-01):** CI builds the image + pushes to ECR, the box **pulls** it instead of building (SSH step ~8 min → ~1–2 min; the box no longer runs a memory-heavy build). Rollback = redeploy a previous image tag; runbook in `docs/AWS_OPERATIONS.md §5.x`
- **Automated DR backups** — hourly upload mirror + frequent Postgres dumps (every 2h Dubai-day / 4h overnight) to AWS Singapore, no human action required
- **Automated Docker disk reclaim** — weekly `docker-prune.sh` cron (Fri 03:00 UTC) clears build cache + dangling images **and trims old pulled `:<sha>` images** (keeps the running + newest-3 rollback images) so the box disk doesn't fill from repeated deploys
- **Health endpoints** — `/health` and `/worker/health` proxy through nginx for external uptime monitoring
- **Dependabot** — automated PRs for vulnerable npm packages
- **GitHub Actions CI** — every push runs tsc + lint + 1479 unit tests + production build; broken changes can't reach production

This automation is the reason "8–14 hours / month of maintenance" is realistic. Without it, the same workload would require an order of magnitude more time.

---

## 4. Operational rituals — what gets done when

The platform is largely self-monitoring (errors trigger emails, scheduled jobs auto-fire), but a number of recurring tasks need protected engineering time. None individually is large; together they form the maintenance baseline.

### Daily (~10–20 minutes / day, embedded in normal work)

- Check admin-alert email inbox for new system errors (automated alerts route here)
- Open `/logs` dashboard to scan for unusual error patterns
- Verify queued scheduled emails fired (visible in dashboard)
- Triage any customer-reported issues from event coordination teams

### Weekly (~30–60 minutes / week)

- Review Sentry dashboard for new error fingerprints
- Verify Mumbai → Singapore DR backups completed (database + uploads)
- Spot-check the worker container's health (`/worker/health` endpoint)
- Review GitHub Dependabot alerts (security updates for npm packages)
- Confirm disk + memory headroom on EC2 (no automated alarm yet — see §7)

### Monthly (~2–4 hours / month)

- Apply non-critical dependency upgrades (Next.js, Prisma, lucide-react, etc.)
- Audit IAM permissions on AWS (drift over time as new features land)
- Review and rotate any keys flagged in last quarter's review
- Skim production logs for slow-query patterns
- Document recent changes in `docs/ROADMAP.md` and `docs/HANDOVER.md`

### Quarterly (~1 full day / quarter)

- **DR drill** — restore the latest Postgres backup into a scratch environment, verify row counts on critical tables. This is the proof that disaster recovery actually works. Already scripted at `scripts/dr-restore-drill.sh`.
- **Access review** — every team member's GitHub / AWS / Stripe / Zoom / Sentry access reviewed; remove anyone who left
- **Cost review** — AWS bill itemised, anomalies investigated
- **Security check** — `npm audit` triage, review CVE list, plan remediation
- **Vendor cost review** — Anthropic API spend, SES sending volume vs reputation, Zoom seat usage

### Annually (~1–2 weeks of focused engineering time / year)

- Major dependency updates (Next.js major-version bump, Node major-version bump, Postgres major-version upgrade)
- Comprehensive security audit (currently done by independent code-review process per change; an annual full sweep is recommended)
- Infrastructure cost optimisation review (right-sizing EC2, reviewing S3 lifecycle policies, etc.)
- Update of all documentation to reflect the year's changes
- Renew SSL certificates (auto-renewed by Let's Encrypt + AWS but the renewal should be verified)
- Domain registration renewal (GoDaddy)

---

## 5. What's monitored automatically vs what needs human eyes

### Automated — fires without human action

| What | How | Who is notified |
|---|---|---|
| **System errors in production** | Four-layer pipeline: Sentry capture (~30 sec), SES admin-alert email (~10 sec), persisted to dashboard log viewer, and CloudWatch Logs (cross-region durability + Insights queries — see `infra/cloudwatch/README.md`) | Krishna's inbox (`krishna@meetingmindsdubai.com`) |
| **Email send failures** | Per-failure email with full context (recipient, sender, AWS error code) | Krishna's inbox |
| **Disaster recovery backups** | Postgres `pg_dump` to AWS Singapore every 2h (Dubai day) / 4h (overnight), hourly upload-folder mirror | Failure triggers SES email; success is silent |
| **Worker health** | `/worker/health` endpoint, Docker health check every 30 seconds | Internal — Docker restarts unhealthy container automatically |
| **Stripe webhook signature failures** | Logged at error level → admin alert | Krishna's inbox |
| **Deploy success / failure** | GitHub Actions workflow result | Email + GitHub UI |

### Needs human eyes (no automated alarm yet)

| What | Why it matters | Current cadence |
|---|---|---|
| **EC2 disk space** | Disk fills → can't write logs → service degradation | Weekly `docker-prune.sh` cron reclaims build cache + dangling images (the main creep); still a weekly spot-check (not paged) — a mem/disk CloudWatch alarm is the durable fix (§7) |
| **EC2 memory / CPU** | Memory pressure → swap → slow responses | Weekly spot-check (not paged) |
| **SES reputation score** | Reputation drop → emails go to spam → registrants don't receive confirmations | Monthly review (no automated alert) |
| **Stripe webhook delivery rate** | Some webhooks failing silently → payment statuses out of sync | Spot-check via Stripe dashboard |
| **Anthropic API quota** | Quota exhaustion → AI Agent + Help Chat down | Monthly review (no alert) |
| **DNS / domain expiration** | Domain lapses → everything breaks | Manual renewal calendar |
| **SSL certificate expiration** | Cert expires → users see security warnings, can't access site | Auto-renewed but should be verified annually |

The items in this second list represent **gaps in the monitoring story** — they should be paged (auto-alerted) rather than relying on human discipline to check them. Several are tracked in [docs/ROADMAP.md](ROADMAP.md) under the observability backlog. The CloudWatch agent is now in place ([infra/cloudwatch/README.md](../infra/cloudwatch/README.md)) shipping all Pino logs to AWS — turning the alarm pipeline on top of that (metric filter on `{ $.level >= 50 }` → CloudWatch alarm → SNS → email) is a 15-minute follow-up documented in §3 of that runbook.

---

## 6. Vendor dependencies — what could break us

EA-SYS depends on external vendors. None of them are perfectly reliable; the question is what happens if each one fails.

| Vendor | Service | Blast radius if they're down | Mitigation |
|---|---|---|---|
| **AWS** (Mumbai region) | EC2 + S3 + SES + DNS (Route 53 for some) | Total outage — the platform is unreachable | DR backups to AWS Singapore region; documented playbook to spin up in Singapore (~4 hours RTO). Real-world: AWS Mumbai had ~2 outages in last 5 years, none > 4 hours. |
| **Supabase** | PostgreSQL database | Total outage — no data access | Frequent backups (every 2h Dubai-day / 4h overnight) stored independently in AWS Singapore S3. Restorable to any vanilla Postgres 17 in ~30 min via the two cold-standby runbooks (RDS or fresh Supabase) in `infra/dr/`. |
| **Stripe** | Payment processing | Payment flow down; rest of platform continues | No realistic mitigation — Stripe is the de facto standard. Manual payment recording via dashboard is available as fallback for offline collection. |
| **AWS SES** | Email sending | Email-dependent flows down (confirmations, alerts, password reset) | Could swap providers (Brevo / SendGrid / Postmark) in ~4 hours of engineering work — the code already has provider-abstraction in place (commented-out blocks from previous setup). |
| **Anthropic** | AI Agent + Help Chat | Two specific features down; rest unaffected | None — these are best-effort features. Help Chat is a "nice to have" not "must have". |
| **Zoom** | Webinar events only | Webinar events can't run; in-person events unaffected | None — Zoom is the platform standard. |
| **GoDaddy** | Domain registration only | If lapses, domain expires and everything breaks | Auto-renewal enabled; calendar reminder for manual confirmation annually |
| **Sentry** | Error tracking | Errors still logged locally + admin-emailed; just lose the central UI | None needed — local logging continues |
| **GitHub** | Source code + CI/CD | Can't deploy new code; existing production unaffected | Existing GitHub outages have rarely exceeded 2 hours. Production keeps running. |

**Key insight:** the platform is more resilient than the headline list suggests because the major dependencies (AWS, Supabase, Stripe, SES) have documented failover paths or independent restoration procedures. The places where "the platform stops" (DNS, AWS Mumbai total outage) have historically been < 4-hour incidents.

---

## 7. Known risks & current posture

Honest list of where the platform is exposed. Each row notes whether it's already mitigated, planned to be mitigated, or unmitigated.

| Risk | Current state | Severity | Plan |
|---|---|---|---|
| **Maintenance time allocation** | Implicit in current role assignment | Medium | The 8–14 hr/month of recurring upkeep needs protected calendar time. Best mitigated by treating it as a budgeted commitment, not a "if there's time" fill-in. |
| **AWS IAM key in `.env` (overrides instance role)** | Identified, scheduled for removal | Medium | One-line change + redeploy; key rotation handled by AWS |
| **No staging environment** | Intentional design choice (prod-only UAT) | Low–Medium | Documented; works at current scale but limits some kinds of testing |
| **DR drill not auto-run** | Manual quarterly process | Medium | Script exists (`scripts/dr-restore-drill.sh`); could be CI-scheduled |
| **Sentry alert rule not configured in Sentry web UI** | Sentry captures errors but doesn't email | Medium | One-time 5-min setup pending |
| **CloudWatch metric-filter alarm not yet enabled** | Logs are flowing to CloudWatch (June 8, 2026) — the alarm + SNS topic on `{ $.level >= 50 }` would add a sixth notification path for error-rate spikes specifically | Low | Setup scripted in `infra/cloudwatch/README.md` §3 |
| **SES sender `meetingmindsexperts.com` only verified — `meetingmindsgroup.com` not** | Causes occasional rejections when an event uses `@meetingmindsgroup.com` from-address | Low | Documented workaround (use `meetingmindsexperts.com` from-address); domain verification is an alternative |
| **L3/L4 volumetric DDoS** | **Unmitigated by design** — single directly-exposed EC2, no CDN/proxy (Cloudflare explicitly not used). AWS Shield Standard (free, automatic) is the only absorption. | Medium | A real volumetric flood would take the box down. Mitigation = front it with a CDN/edge — full "add Cloudflare later" playbook in [AWS_OPERATIONS.md §4.2](AWS_OPERATIONS.md). Not pursued today by decision. |
| **L7 bot / abuse (floods, scraping, fake signups)** | **Mitigated** — nginx per-IP `limit_req`/`limit_conn` (live, runs before Node, survives restarts) + fail2ban (`sshd` jail; **nginx jail added**) + in-app `checkRateLimit` (~80 IP/userId/org/key buckets). | Low–Medium | No CAPTCHA/proof-of-human yet (Turnstile on public forms is the next increment). The in-app limiter is in-memory + per-container (resets on deploy) — durable fix is a Redis/Upstash store; nginx limiting covers the gap. |
| **No WAF (AWS or host)** | **Confirmed by audit** (June 10, 2026) — no AWS WAF in the account (nothing to attach to without an ALB/CDN), no host ModSecurity. Prior "WAF on EC2" belief was a mix-up with fail2ban/ufw. | Low | AWS WAF requires an ALB/CDN; deferred with the no-CDN decision. nginx rate limiting + fail2ban cover crude L7 abuse. Revisit if a CDN is adopted (Cloudflare WAF comes free). |
| **Automated security scanning (ZAP / Snyk / dependabot beyond default)** | Default Dependabot + GitHub secret scanning active; deeper scanning intentionally deferred | Low | Backlog item — adopt when team size > 2 or external regulator/customer asks |
| **No formal SOC 2 / ISO 27001 / HITRUST attestation** | Not pursued | Low (for now) | Worth revisiting if MMG sells events to customers who require it |

The "Severity" column reflects current real-world impact, not theoretical risk. Items rated "Low" today could move up if circumstances change (e.g., new customer with compliance requirements would push the SOC 2 row to High overnight).

---

## 8. Operating costs — actual

These are the recurring infrastructure costs only. Engineering time (the largest cost) is separate. **Figures reflect actual current MMG event volume — not a generic SaaS-at-this-LOC projection.**

| Category | Monthly cost (USD) | Annual (USD) | Notes |
|---|---|---|---|
| AWS EC2 Mumbai (`t3.large`, production) | ~$60 | ~$720 | Single instance, both web + worker containers running 24/7 on a Reserved-Instance-equivalent rate. The dominant single line item. |
| AWS EC2 Singapore (DR standby) | ~$3–5 | ~$36–60 | Instance is provisioned but typically **stopped** when not in DR drill mode — only EBS storage accrues. The full ~$60/mo cost only applies during a live failover (rare). |
| AWS S3 Singapore (DR mirror only — live files on Mumbai instance disk) | ~$1–3 | ~$12–36 | Small at current upload volume; scales linearly with media-upload growth. |
| AWS SES | ~$1–2 | ~$12–24 | $0.10 per 1,000 emails. Current event volume = a few thousand emails per event = pennies per send. |
| Supabase (Postgres managed) | ~$25 | ~$300 | Pro tier — includes the managed Postgres + connection pooling + the headroom needed for production workload. Exact figure to be confirmed against current invoice. |
| Anthropic (Claude API) | ~$5–20 | ~$60–240 | Help Chat + AI Agent usage at current volume. Cost scales primarily with operator queries to AI Agent — could rise to $50+/mo if usage grows. |
| Sentry | $0 | $0 | Free tier covers current error volume comfortably. |
| Domain (GoDaddy) | ~$1 | ~$12–20 | `meetingmindsgroup.com` + `meetingmindsexperts.com` |
| GitHub (private repos + Actions) | $0 (incremental) | $0 | Already paid via organisational subscription. |
| Stripe | Per-transaction fee | — | ~2.9% + $0.30 per successful transaction — not a fixed cost. |
| **Total infrastructure** | **~$95–115** | **~$1,140–1,400** | **Currently around $100/month at MMG's actual event volume.** |

**What's not in this number:** engineering time (the dominant cost), one-time setup fees, vendor support contracts (none currently). At MMG's current event volume, this infrastructure stack supports an order of magnitude more events without significant scaling cost — the largest line item (Mumbai EC2) stays flat regardless of registrations until traffic crosses ~10x today's volume.

**Cost growth signals to watch — none urgent today:**
- **Anthropic spend** — single-most-variable line. If AI Agent / Help Chat usage spikes 10x, this becomes the largest line. Decision §9.6 (monthly cap) addresses this.
- **Supabase** — when row counts pass the free-tier ceiling (~500MB database / 2GB egress), the Pro tier (~$25/mo) becomes necessary. Today's scale is well within free.
- **S3** — media uploads accumulate. The $1–3/mo today could reach $10/mo if event count doubles and certificates are issued for every attendee.
- **Mumbai EC2** — a `t3.large` is comfortable up to ~50 concurrent registrants on the public form. If concurrent traffic outpaces that, step up to `t3.xlarge` (~$120/mo) before adding a second instance.

---

## 9. Decisions needed from leadership

These are the specific items where leadership input would unblock or accelerate the support model. None are blocking immediate operation — but each represents a meaningful improvement to the platform's resilience or capacity.

### 1. Maintenance time as a recurring budget

**The ask:** Treat the 8–14 hours/month of recurring upkeep (daily monitoring + weekly maintenance + monthly upkeep + quarterly DR drills, per §3) as a budgeted commitment rather than work that fits between feature requests.

**Why it matters:** The platform's stability today is the result of the recurring maintenance work being done consistently. When that work gets squeezed by feature deadlines, the symptoms (slow-query buildup, dependency drift, stale dashboards) show up months later as harder-to-diagnose issues. Protecting the time prevents the future fire-fighting.

**Decision required:** Whether to formalise the maintenance hours as a recurring allocation (a standing ~3 hr/week on the calendar), or continue as best-effort with the understanding that feature work will sometimes displace it.

### 2. AWS key rotation + lockdown

**The ask:** Approval to rotate the current `AWS_ACCESS_KEY_ID` (which currently overrides the EC2 instance role) and move all credentials to instance roles. Standard AWS hardening practice.

**Why it matters:** A long-lived static IAM key is the single highest-impact credential in the system. Rotating quarterly (or removing entirely in favour of instance role) is industry-standard. Currently the platform works fine, but the IAM user's keys haven't been rotated — that's a risk.

**Decision required:** Approval to execute (5 minutes of work; no service interruption).

### 3. Compliance posture

**The ask:** Decide whether MMG wants to pursue formal compliance attestations (SOC 2 / ISO 27001 / HITRUST / PDPL formal certification).

**Why it matters:** Today, the platform is built to be SOC-2-style internally (audit logs, access controls, encryption, separation of duties) but has no formal attestation. If MMG ever wins a customer that requires this (large pharma, regulator-adjacent, government), it's a 6–12 month project starting from where we are. **Better to know now than to discover it the day a customer asks.**

**Decision required:** Direction on whether this is a near-term priority, "if it comes up" reactive, or out of scope.

### 4. Disaster recovery RTO/RPO targets

**The ask:** Confirmation that the current disaster recovery posture is acceptable: 24-hour data loss (RPO) and 4-hour recovery time (RTO) for full platform restore.

**Why it matters:** Current backups are once-daily. If MMG runs a high-value event and loses 23 hours of registrations, that's a real loss but a recoverable one. Tightening this (e.g., hourly backups → RPO < 1 hour) is possible but adds cost ($25–50/month) and operational complexity.

**Decision required:** Confirm current targets are acceptable, or set tighter ones.

### 5. Vendor contract reviews

**The ask:** Annual review of vendor terms — particularly Anthropic, Stripe, and Supabase — to lock in pricing and surface any data-handling clauses that may need amendment.

**Why it matters:** Pricing and terms drift. Anthropic in particular has had multiple pricing changes in the last year. Locking in or at least understanding the risk surface is a quarterly task that hasn't been formalised.

**Decision required:** Whether finance/legal can take this on, or if it stays with engineering.

### 6. Help-chat / AI Agent budget cap

**The ask:** Set a monthly Anthropic API spend cap. Today there's no hard cap — a runaway loop or popular feature could spike the bill.

**Why it matters:** Anthropic billing is metered. A misuse case or unexpected volume could push monthly spend from ~$100 to ~$1,000 before anyone notices.

**Decision required:** What monthly cap is acceptable. Recommended: $300/month with email alert at $200.

---

## 10. KPIs — what "good support" looks like

These are the measurable indicators that the platform is being maintained well. None are currently tracked formally; this section establishes the targets.

| KPI | Target | Why |
|---|---|---|
| **Uptime** | ≥ 99.5% (acknowledges single-region risk) | Customer-facing reliability |
| **Time to first response on customer-reported issues** | < 4 hours during business hours | Operator confidence |
| **Time to deploy emergency fix** | < 30 minutes from problem identified to fix live | Blue-green deploy + worker tier supports this |
| **DR drill pass rate** | 100% (one drill per quarter, all pass) | Backups actually work |
| **Critical CVE remediation time** | < 7 days from disclosure to patched | Security hygiene |
| **Dependabot PR merge cadence** | Monthly review, no PR older than 60 days | Avoid stale-dep buildup |
| **Documentation freshness** | Every major feature has an entry in `ROADMAP.md` within 1 week of ship | New engineers can pick up the codebase from docs alone |

---

## 11. References

These existing documents in the repository provide deeper context:

- [`docs/HANDOVER.md`](HANDOVER.md) — full technical handover for a new engineer taking over the codebase
- [`docs/AWS_OPERATIONS.md`](AWS_OPERATIONS.md) — master AWS CLI runbook (daily ops, perf troubleshooting, **§4 security / DDoS-bot posture + add-Cloudflare-later playbook**, disaster recovery)
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — system architecture, component interactions
- [`docs/ROADMAP.md`](ROADMAP.md) — feature timeline, completed work, current release notes, deferred items
- [`docs/MUMBAI_SETUP.md`](MUMBAI_SETUP.md) — Mumbai EC2 server setup procedure
- [`docs/EC2_HARDENING.html`](EC2_HARDENING.html) — security posture on the EC2 box
- [`docs/CORE_STABILITY.md`](CORE_STABILITY.md) — the foundational reliability work
- [`infra/dr/README.md`](../infra/dr/README.md) — disaster recovery procedures + runbooks
- [`worker/README.md`](../worker/README.md) — background worker operator guide

---

## 12. Glossary (for non-technical readers)

| Term | Plain meaning |
|---|---|
| **EC2** | Amazon's rented servers. We rent two — one in Mumbai (production), one in Singapore (disaster recovery standby). |
| **S3** | Amazon's file storage. We use it for DR backup copies of uploaded files and the database. (The live copy of uploaded files sits on the Mumbai server's own disk; S3 holds the safety net.) |
| **SES** | Amazon's email-sending service. The pipe that delivers every email we send. |
| **PostgreSQL / Postgres** | The database. Where all event data lives (registrations, speakers, payments, etc.). |
| **Supabase** | The hosted Postgres service. We don't run the database ourselves; they do. |
| **Docker** | A way to package the application so it runs the same on the developer's laptop and on the server. |
| **Blue-green deploy** | A way to ship a new version with zero downtime — run the new version alongside the old one, switch traffic once it's healthy. |
| **DR (Disaster Recovery)** | The plan for what we do if Mumbai goes offline. Backups + a documented playbook to spin up in Singapore. |
| **RPO / RTO** | Recovery Point Objective (how much data you can afford to lose — for us, 24 hours) and Recovery Time Objective (how long to be back online — for us, ~4 hours). |
| **Sentry** | A service that captures every error in the application with full context, so we can find and fix bugs faster. |
| **Stripe webhook** | When Stripe receives a payment, they "call back" our system to tell us — that callback is a webhook. If it fails, we don't know the payment happened. |
| **CVE** | Common Vulnerabilities and Exposures — the global database of known security flaws. We monitor it for any flaw that affects software we use. |
| **CI/CD** | Continuous Integration / Continuous Deployment. The automation that runs every code change through tests + deploys it to production if they pass. |
| **IAM** | AWS's permission system — who/what can do what in our AWS account. |
| **SOC 2 / ISO 27001 / HITRUST** | Different formal security certifications. Customers in regulated industries often require these. We don't have any yet. |
| **PDPL** | The UAE's personal data protection law. We're built to be compliant (data residency in Mumbai, no PII crossing borders unnecessarily) but don't have a formal certification. |

---

## Appendix A — Recent feature additions (rolling log, June 24 – July 9, 2026)

A support-facing digest of what shipped in the last ~15 days. This section is **not** the changelog (the full per-commit history lives in git + `CLAUDE.md`); it exists so support/maintenance staff know what changed on the **operational surface** — new capabilities to support, new background jobs, new failure modes, and the prod migrations already applied. Items that add an ongoing operational consideration are flagged **⚙️ Ops**.

**Finance & invoicing (the biggest area — July 1–8).**
- Org-level **Invoices & Quotes hub** with per-event and org-wide **CSV + QuickBooks export** (bulk-download all matching PDFs as a ZIP; CSV formula-injection neutralised).
- Post-payment email now sends **both a receipt and an invoice**; **⚙️ Ops:** every invoice / receipt / credit-note email is **BCC'd to the accounting inbox(es)** — if accounting reports missing copies, check the BCC config, not the send path.
- **Gated partial refunds + partial credit notes** with a running "refunded so far" total; refunds now require a credit note first; **manual/offline refunds** (cash/bank) supported alongside Stripe.
- **Cancel-a-registration-with-refund** flow (auto credit-note + refund, then cancel; refund failure aborts the cancel). Refund/credit-note/cancel logic consolidated into a new **payment-service**.
- **Stripe receipt** is now snapshotted to our own storage as a durable copy (**⚙️ Ops:** rides the existing hourly uploads → Singapore DR sync, no cron change).
- Organizer can **re-tier an unpaid registration** (courtesy Early-Bird price) and **apply/remove promo codes on existing registrations**; a tier-priced/virtual reg no longer mislabels as "Free". Manual payment defaults to the **tax-inclusive** total.

**Certificates (June 24 – July 9).**
- **Survey-gated auto-issue (Phase 2)** — completing the event survey auto-issues + emails the matching certificate. **⚙️ Ops:** a new **worker sweep** runs inside the cert-issue job (every 3 min) with retry/backoff; an **Auto-issue analytics card** on the Certificates page shows pending/retrying/resolved/failed. A template must carry a **tag** to match anyone.
- **Multi-role certificates** — one person can now hold several role-specific certs (Speaker + Moderator + Committee); per-template `{{cmeHours}}` / `{{role}}` tokens.
- **On-demand delivery** — single Issue, **Resend latest version** (re-renders from the *current* template, so template fixes propagate), **Resend all** for a person, and (July 9) a per-template **"Resend to everyone (N)"** bulk button on the Certificates → Issue tab.
- Deferred **survey thank-you email** that carries the certificate as an attachment (15-min fallback).

**Abstracts overhaul (July 2).** Submitter details landing page + editable per-event guidelines; **co-authors**; presentation types (Oral/Poster · Video · Workshop) now **mandatory to submit**; **300-word body cap**; authors locked out of editing after submission; organizers gained full abstract management; **Presenter Agreement** emailed as a PDF with tokenized acceptance. Reviewer side: **conflict-of-interest enforced** on review submission, plus assignment / pool-add / resend-invite notifications.

**Dinner RSVP (July 8 — new module).** Invite people to an event's dinners with one personalized link covering all nights; organizer console (manage dinners, import invitees from Registrations/Speakers, roster + per-night headcounts + CSV, email invitations + remind-pending). **⚙️ Ops:** new migration (3 tables); the invitation is a first-class email template; MCP `list_dinner_rsvps`. No auto-reminder cron (manual "remind pending").

**Speakers as attendees (June 25–26).** A speaker now gets a **companion registration** so they receive a badge, entry + DTCM barcode, check-in, survey, and certificates like any attendee. **⚙️ Ops:** faculty are **excluded from delegate-focused counts/revenue** (a hidden "Faculty" ticket type); new migration + a one-time backfill script (operator-run).

**On-site desk staff, now per-event (July 6–7).** ONSITE (registration-desk) accounts are **scoped to assigned events**, not the whole org — managed from Settings → Onsite Staff. **⚙️ Ops / security:** closed a cross-event isolation gap where a desk worker could act on any event in the org (incl. payment data + badge barcodes).

**Roles & identity (July 2).** Attendee **Role** (profession category) is captured + shown across registrations, speakers, contacts, and abstracts. New operator runbook `docs/IDENTITY_AND_ROLES.md` ("one person, many hats") + `docs/COMMITTEE_MEMBERS.md` (committee = a tag, not a ticket type).

**Communications (June 29 – July 2).** Bulk-email **audience filters** (multi-select payment status / registration type / badge / tags, plus **exclude faculty/speakers**) as the single filter surface; scheduled-email **statistics + failed-recipient drill-down**.

**Registration & public UX (July 6–7).** Registration detail sheet is **Edit → Save** (no more per-field auto-save) and loads full financials on open; VAT line always shown; **responsive mobile banner** on public pages; event time-of-day removed from public cards; confirmation-page polish + per-event SEO metadata.

**Infrastructure & data integrity.**
- **⚙️ Ops:** **Monthly SystemLog archival** to compressed files keeps the DB bounded while retaining everything — a new recurring job; if the DB grows unexpectedly, confirm this is running.
- **⚙️ Ops:** CloudWatch now collects **disk + memory** metrics (for future alarms); deploy self-cleans the Docker cache before every pull (INC-002).
- **⚙️ Ops:** a nightly + ~37-min incremental **mirror of EA-SYS contacts to an external Supabase `contacts_centralv1`** store (provenance-flagged) — a new outbound data flow to be aware of.
- Correctness fixes: `PricingTier.soldCount` double-leak, atomic `Event.settings` merge (concurrent saves to different keys can't clobber), oversell guards on bulk-type/import, contact-sync made **enrich-only** (a sparse re-registration can't wipe richer contact data).

---

*Document prepared by Krishna Pallapolu. For corrections or questions, contact via the usual channels. Last updated July 9, 2026.*
