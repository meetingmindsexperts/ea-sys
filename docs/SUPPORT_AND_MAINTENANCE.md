# EA-SYS — Support, Maintenance & Operational Requirements

**Audience:** Leadership / management review.
**Author:** Krishna Pallapolu (Development Manager, MMG)
**Last updated:** June 8, 2026
**Purpose:** Establishes what it takes to run, monitor, and maintain the in-house event platform on an ongoing basis. Provides the operational baseline and surfaces decisions that need leadership input.

---

## 1. Executive summary

EA-SYS is the in-house event platform that runs every MMG event (8th OSH, IOHNC, EIGHC, HEMNET, EHC, ICCH, etc.) end-to-end — registration, payments, speakers, abstracts, accommodation, on-site check-in, certificates, and post-event surveys. It replaces fragmented third-party tools (EventsAir, spreadsheets, manual workflows) with one platform that MMG fully owns and controls.

This document is **not** about new features. It's about **what's required to keep the platform healthy** — the people, infrastructure, recurring tasks, monitoring discipline, and vendor relationships that sit behind the scenes when an organiser opens the dashboard each morning.

**One-line summary:** EA-SYS is in a stable, well-monitored, mid-maturity state — but it depends on one engineer with no formal cover, three external vendors that could disrupt service if they fail, and a handful of recurring tasks that need protected time. Most of the operational baseline is in place; the items in §9 (Decisions Needed) are what leadership input would unblock.

---

## 2. Platform footprint — what we run, where

| Layer | What | Where | Why it matters |
|---|---|---|---|
| **Web application** | EA-SYS dashboard + public registration pages | AWS EC2, Mumbai region (ap-south-1), `t3.large` instance | This is the actual product. If it's down, organisers and registrants can't use the platform. |
| **Background worker** | Cron-driven jobs (certificate rendering, scheduled emails, webinar recording retrieval, attendance sync) | Same Mumbai EC2 box, separate Docker container | If this is down, scheduled emails don't fire, certificates don't render, webinar attendance doesn't sync. Outage isn't immediately visible to users but accumulates. |
| **Database** | PostgreSQL — all event data, registrations, speakers, payments, surveys | Supabase (managed Postgres, Mumbai region) | All operational data lives here. Daily backups to AWS Singapore (different region for disaster recovery). |
| **File storage (live)** | Photos, certificates, uploaded media, generated PDFs | Local filesystem on the Mumbai EC2 box, mounted as a Docker volume shared between the web + worker containers (`/home/ubuntu/ea-sys/public/uploads/`) | Primary copy of every uploaded file. Lives on the same instance as the application — pragmatic at current scale, but means the instance disk is part of the durability story. |
| **File storage (DR mirror)** | Hourly snapshot of all uploaded files | AWS S3 Singapore region (`ap-southeast-1`) | Secondary copy for disaster recovery. Different AWS region from the live instance, so a Mumbai-wide outage doesn't lose files. Mirror lags up to 60 minutes (the cron schedule). |
| **Email delivery** | All outgoing email (registration confirmation, payment receipt, speaker invitation, certificate delivery, admin alerts) | AWS SES (ap-south-1, Mumbai) | If email is down, registrants don't receive confirmations, certificates don't deliver, admin alerts don't fire. Single point of failure for customer communication. |
| **Payments** | Credit card processing | Stripe (US-based, global infrastructure) | Stripe handles the actual payment; we receive webhooks. Stripe rarely fails but its webhook calls into our system are a known fragility point. |
| **Video / Webinars** | Live streaming, recording, attendance | Zoom (separate org credentials per MMG entity) | Webinar events depend entirely on Zoom. Their API calls into our system on session-end to deliver recording URLs. |
| **AI features** | Help chat + AI Event Assistant | Anthropic (Claude API) | AI-driven features (natural-language event commands, help chat). If Anthropic is down, those specific features stop; everything else continues. |
| **Source code + deploys** | Code repository + CI/CD | GitHub (Mumbai EC2 deploy target) | Code change → GitHub push → CI runs → SSH-deploy to Mumbai → blue-green container swap. About 5-10 minutes per deploy. |
| **DNS + email reputation** | `events.meetingmindsgroup.com`, `meetingmindsexperts.com` | GoDaddy (registrar), AWS Route 53 (some DNS) | If DNS goes down, nothing is reachable. Email reputation lives with whoever owns the sender domain (currently `meetingmindsexperts.com`). |
| **Error monitoring** | Real-time error capture | Sentry (cloud SaaS) | Captures every error with stack trace + context. Production safety net. |

**Total infrastructure cost: roughly $200–500 USD/month at current scale.** Detailed cost breakdown in §8.

---

## 3. Personnel & skills required

### Current state

| Role | Who | Coverage status |
|---|---|---|
| **Lead engineer / development manager** | Krishna Pallapolu | **Single point of failure.** No formal backup if Krishna is unavailable (vacation, illness, departure). |
| **Junior developer** | Allocated but not currently engaged on EA-SYS | Available for assistance; not yet integrated into the daily flow |
| **Customer-facing support** | Event coordination teams within MMG | Currently absorbs first-line issues by working with Krishna directly. Works because volume is low. |

### Skills the lead engineer role requires

This is **not a "junior dev" role**. EA-SYS is a substantial system (149,000+ lines of code, see [docs/SUPPORT_AND_MAINTENANCE.md](SUPPORT_AND_MAINTENANCE.md) / [docs/HANDOVER.md](HANDOVER.md)). The person doing this work needs:

- TypeScript + Next.js (current framework, ~95% of the code)
- PostgreSQL + Prisma ORM (database)
- AWS administration (EC2, S3, SES, IAM)
- Linux server administration (Ubuntu, Docker, nginx)
- Stripe integration patterns
- AWS SES email deliverability (DKIM, SPF, DMARC)
- Familiarity with React frontend
- Comfort with command-line, git, GitHub Actions
- Reading + writing technical documentation

A mid-to-senior engineer with 5+ years of full-stack experience can pick up the codebase in ~2–4 weeks given the documentation that exists (`docs/HANDOVER.md`, `docs/ARCHITECTURE.md`, `docs/MUMBAI_SETUP.md`).

### What's at risk with single-person bus factor

If Krishna is unavailable for an extended period:

| Timeframe | Without backup engineer |
|---|---|
| **1–3 days** | Platform continues running (it's largely self-managing). Routine issues queue up. |
| **1–2 weeks** | Recurring maintenance tasks (dependency upgrades, log review) drift. New issues surfaced via Sentry don't get triaged. |
| **3–4 weeks** | Security patches not applied. Vendor SDK changes could break integrations. Customer-reported issues accumulate. |
| **1+ months** | Real risk of customer-impacting outages from neglected updates. Documentation may not be enough to bring a new engineer up to speed without help. |

**The mitigation is documentation, not a backup engineer** — the existing `docs/HANDOVER.md` is comprehensive enough that a competent senior engineer could take over in a crisis. But that's a backup plan, not the desired operating model.

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
| **System errors in production** | Three-layer pipeline: Sentry capture (~30 sec), SES admin-alert email (~10 sec), persisted to dashboard log viewer | Krishna's inbox (`krishna@meetingmindsdubai.com`) |
| **Email send failures** | Per-failure email with full context (recipient, sender, AWS error code) | Krishna's inbox |
| **Disaster recovery backups** | Daily Postgres `pg_dump` to AWS Singapore, hourly upload-folder mirror | Failure triggers SES email; success is silent |
| **Worker health** | `/worker/health` endpoint, Docker health check every 30 seconds | Internal — Docker restarts unhealthy container automatically |
| **Stripe webhook signature failures** | Logged at error level → admin alert | Krishna's inbox |
| **Deploy success / failure** | GitHub Actions workflow result | Email + GitHub UI |

### Needs human eyes (no automated alarm yet)

| What | Why it matters | Current cadence |
|---|---|---|
| **EC2 disk space** | Disk fills → can't write logs → service degradation | Weekly spot-check (not paged) |
| **EC2 memory / CPU** | Memory pressure → swap → slow responses | Weekly spot-check (not paged) |
| **SES reputation score** | Reputation drop → emails go to spam → registrants don't receive confirmations | Monthly review (no automated alert) |
| **Stripe webhook delivery rate** | Some webhooks failing silently → payment statuses out of sync | Spot-check via Stripe dashboard |
| **Anthropic API quota** | Quota exhaustion → AI Agent + Help Chat down | Monthly review (no alert) |
| **DNS / domain expiration** | Domain lapses → everything breaks | Manual renewal calendar |
| **SSL certificate expiration** | Cert expires → users see security warnings, can't access site | Auto-renewed but should be verified annually |

The items in this second list represent **gaps in the monitoring story** — they should be paged (auto-alerted) rather than relying on human discipline to check them. Several are tracked in [docs/ROADMAP.md](ROADMAP.md) under the observability backlog; some are still pending leadership decision on whether to invest in the alerting infrastructure (Sentry alert rules + CloudWatch agent).

---

## 6. Vendor dependencies — what could break us

EA-SYS depends on external vendors. None of them are perfectly reliable; the question is what happens if each one fails.

| Vendor | Service | Blast radius if they're down | Mitigation |
|---|---|---|---|
| **AWS** (Mumbai region) | EC2 + S3 + SES + DNS (Route 53 for some) | Total outage — the platform is unreachable | DR backups to AWS Singapore region; documented playbook to spin up in Singapore (~4 hours RTO). Real-world: AWS Mumbai had ~2 outages in last 5 years, none > 4 hours. |
| **Supabase** | PostgreSQL database | Total outage — no data access | Daily backups stored independently in AWS Singapore S3. Restorable to any vanilla Postgres 17 in ~30 min if Supabase is permanently down. |
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
| **Single engineer (bus factor)** | Unmitigated | High | Documented in `HANDOVER.md`; would survive a crisis but not gracefully |
| **AWS IAM key in `.env` (overrides instance role)** | Identified, scheduled for removal | Medium | One-line change + redeploy; key rotation handled by AWS |
| **No staging environment** | Intentional design choice (prod-only UAT) | Low–Medium | Documented; works at current scale but limits some kinds of testing |
| **DR drill not auto-run** | Manual quarterly process | Medium | Script exists (`scripts/dr-restore-drill.sh`); could be CI-scheduled |
| **Sentry alert rule not configured in Sentry web UI** | Sentry captures errors but doesn't email | Medium | One-time 5-min setup pending |
| **No CloudWatch metric-filter alarm for production stdout** | Optional third notification path | Low | Pending infrastructure setup |
| **SES sender `meetingmindsexperts.com` only verified — `meetingmindsgroup.com` not** | Causes occasional rejections when an event uses `@meetingmindsgroup.com` from-address | Low | Documented workaround (use `meetingmindsexperts.com` from-address); domain verification is an alternative |
| **Automated security scanning (ZAP / Snyk / dependabot beyond default)** | Default Dependabot + GitHub secret scanning active; deeper scanning intentionally deferred | Low | Backlog item — adopt when team size > 2 or external regulator/customer asks |
| **No formal SOC 2 / ISO 27001 / HITRUST attestation** | Not pursued | Low (for now) | Worth revisiting if MMG sells events to customers who require it |

The "Severity" column reflects current real-world impact, not theoretical risk. Items rated "Low" today could move up if circumstances change (e.g., new customer with compliance requirements would push the SOC 2 row to High overnight).

---

## 8. Annual operating costs — rough ranges

These are the recurring infrastructure costs only. Engineering time (the largest cost) is separate.

| Category | Monthly cost (USD, approximate) | Annual (USD) | Notes |
|---|---|---|---|
| AWS EC2 Mumbai (`t3.large`, production) | $60–80 | $720–960 | Single instance, both web + worker containers |
| AWS EC2 Singapore (DR standby) | $60–80 | $720–960 | Could be turned off when not in drill mode to save ~$700/yr (trade-off: warm vs cold standby) |
| AWS S3 Singapore (DR mirror only — live files are on the Mumbai instance disk) | $3–15 | $36–180 | Scales with media-upload volume and DR retention policy |
| AWS SES | $1–10 | $12–120 | $0.10 per 1,000 emails. Even at 100,000 emails/month, ~$10 |
| Supabase (Postgres managed) | $25–50 | $300–600 | Current plan tier |
| Anthropic (Claude API) | $50–200 | $600–2,400 | Highly variable based on AI Agent + Help Chat usage |
| Sentry | $0–26 | $0–312 | Free tier covers current volume; paid tier if usage grows |
| Domain (GoDaddy) | ~$1 | $12–20 | `meetingmindsgroup.com` + `meetingmindsexperts.com` |
| GitHub (private repos + Actions) | Included in MMG GitHub plan | — | Already paid via organisational subscription |
| Stripe | Per-transaction fee | — | Standard ~2.9% + $0.30 per successful transaction; not a fixed cost |
| **Total infrastructure** | **~$200–500** | **~$2,400–6,000** | At current scale |

**What's not in this number:** engineering time (the dominant cost), one-time setup fees, vendor support contracts (none currently). At MMG's current event volume, this infrastructure stack supports an order of magnitude more events without significant scaling cost.

**Cost optimisation opportunities (not urgent):**
- Singapore EC2 could be a cold standby instead of always-on (~$700/yr saving)
- S3 lifecycle policies could move old uploads to Glacier (~$10–30/yr saving)
- Anthropic spend could be capped if usage spikes unexpectedly

---

## 9. Decisions needed from leadership

These are the specific items where leadership input would unblock or accelerate the support model. None are blocking immediate operation — but each represents a meaningful improvement to the platform's resilience or capacity.

### 1. Backup engineering capacity

**The ask:** Even a part-time second engineer with platform context would significantly reduce the bus-factor risk. Options range from formal hire to having the junior developer spend 1 day/week on EA-SYS familiarisation.

**Why it matters:** A 2–4 week absence of the lead engineer would have meaningful impact on platform health. A 1-day-a-week understudy halves that risk for less than a full hire.

**Decision required:** Whether to allocate time from the junior developer; or hire a second mid-level engineer; or accept the current risk.

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

*Document prepared by Krishna Pallapolu. For corrections or questions, contact via the usual channels. Last updated June 8, 2026.*
