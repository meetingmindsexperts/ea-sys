# Vendor summary: one-pager for Muthu

**Prepared by:** Krishna, Development Manager
**Date:** 2 September 2026
**Purpose:** Every vendor behind EA-SYS: what it does, what it costs, and what to watch at renewal. Figures confirmed against current bills, 2 September 2026.

**Headline: total spend runs about $380 USD/month** (~$370–400): infrastructure is ~$170, and the Anthropic line is ~$210–220, most of which is the engineering Claude plan (development tooling) rather than in-app AI usage. Engineering time is the dominant real cost and is not in that number. **Zoom ($450/month) is the company-wide account for all MM Group meetings and webinars**; EA-SYS rides on it at no incremental cost, so it is listed below but not counted in the EA-SYS total. There are no vendor support contracts anywhere (deliberate at this scale). A projected addition for the multi-tenant platform is in §2: forecast only, not in today's spend.

---

## 1. The vendors

| Vendor | What it does for us | Billing model | Est. monthly | Watch at renewal / ongoing |
|---|---|---|---|---|
| **AWS** | Production server (Mumbai), disaster-recovery standby + backups (Singapore), encrypted S3 document storage, email sending (SES), logs, encryption keys | Pay-as-you-go, no renewal date | ~$85–90 all-in | CPU credits on the `t3.large` before big events (upgrade path is `t3.xlarge` at ~$120/mo, only if traffic ~10x). Delete the retained unencrypted disk + snapshots from the August encryption work (small cost, open compliance item). The Elastic IP must stay attached: it is the DNS target. |
| **Supabase** | Managed PostgreSQL: the primary database (Mumbai) plus the EU marketing-contact mirror | Monthly subscription | ~$75–85 | Point-in-time-recovery upsell (~$25–50/mo) was evaluated and deferred; revisit only if a sub-hour recovery need appears. No Middle East region exists, which caps our UAE data-residency answer. |
| **Stripe** | Card payments for registrations | Per transaction (~2.9% + $0.30), no fixed fee | $0 fixed | Nothing renews. When the multi-tenant platform launches, tenants can bring their own Stripe keys, so our account does not become a bottleneck. |
| **GitHub** | Code repository + the automated build/deploy pipeline | Covered by existing organisational subscription | $0 incremental | Actions minutes usage (~19 min per deploy) is well within quota today. Deploy credentials (SSH key) live in repo secrets; rotate on any personnel change. |
| **GoDaddy** | Domains: `meetingmindsgroup.com`, `meetingmindsexperts.com` | Annual renewal, AED 50–60 per domain per year | ~$2–3 | **Auto-renew must stay on for both.** A lapsed domain takes down the platform AND all email. DNS points directly at our server's static IP (no CDN in front), so any registrar or DNS change needs coordination with engineering. |
| **Sentry** | Real-time application error tracking | Free tier | $0 | Free tier has an event quota; a sustained error spike silently drops reports. Upgrade only if volume grows. |
| **Anthropic** | AI features (staff help assistant, event AI agent) plus the engineering Claude plan | Subscription + usage-based API | ~$210–220 | **Now the largest line.** Most of this is the engineering Claude plan (development tooling); in-app API usage remains small (~$5–20). A $300/month hard cap with a $200 alert is being set on the API side. |
| **Zoom** | All MM Group meetings and webinars, including EA-SYS webinar and hybrid events | Subscription, company-wide | $450 (shared, not EA-SYS-specific) | Serves the whole company, so not attributed to EA-SYS. Large webinars need capacity add-on licences (500/1000/10k tiers): check before committing to a big virtual event. The "EA-SYS" apps in the Zoom Marketplace must never be deleted: removing one broke a live webinar in August. |
| **ipapi.co** | Approximate location of staff sign-ins (security feature) | Free tier | $0 | Can be switched off with one setting; no commitment. |

## 2. Forecast: the multi-tenant platform (projected, NOT in today's spend)

When the multi-tenant platform launches it runs as a second, separate production stack: its own server and its own Supabase database (the agreed two-silo model, so a platform incident can never touch MMG's own events). Projected addition:

| Item | Est. monthly | Note |
|---|---|---|
| Second production server (AWS) | ~$100–150 | Bigger box than today's (t3.xlarge class); cost scales with tenant count |
| Second Supabase project (platform database) | ~$70–90 | Fresh, isolated database sized like today's; scales with tenant usage |
| Backups, email, storage increments | ~$5–10 | DR mirror, email sending and document storage for the new silo |
| **Projected addition** | **~$175–250** | **Combined total roughly $560–630/month once the platform is live** |

No new GitHub, Sentry or domain cost (one codebase, one build, two deploy targets). On the platform, tenants can bring their own Stripe and AI keys, so those variable costs sit with the tenant rather than us.

## 3. Cross-cutting points

1. **Account ownership.** Every vendor account (AWS, GitHub, Stripe, Supabase, GoDaddy, Sentry) currently sits under `meetingmindsdubai.com` addresses.
2. **Access continuity.** Vivek has been given infrastructure access and acts as the secondary access on our systems, so administrative access is no longer single-person. A second developer for the platform is good to have as it grows.
3. **Cost growth signals** (none urgent): Anthropic spend (capped), S3 storage as media/certificates accumulate (~$1–3 today, maybe $10 at double the event count), and the Mumbai server size only if concurrent traffic outgrows it.
4. **What is deliberately NOT purchased:** no CDN/WAF subscription (rate limiting and IP banning are done on our own server; a Cloudflare onboarding playbook exists if ever needed), no vendor support contracts, no monitoring SaaS (alerting is built on AWS + email).