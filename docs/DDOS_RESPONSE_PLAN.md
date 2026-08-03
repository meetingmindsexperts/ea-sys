# DDoS Response Plan — EA-SYS

> **Operator incident runbook** (Aug 3, 2026). What to do — in order — when
> events.meetingmindsgroup.com is being flooded, scraped, or abused.
> Static posture + verified inventory live in
> [AWS_OPERATIONS.md §4](AWS_OPERATIONS.md); this doc is the *during-the-incident*
> half. Post-mortems go to [INCIDENTS.md](INCIDENTS.md).

**Ground truth (don't re-litigate mid-incident):** EA-SYS is a single
directly-exposed EC2 (`i-0b51ab1213d084640`, ap-south-1, Elastic IP, nginx →
blue/green Docker). **No CDN, no AWS WAF** — by decision. Defense-in-depth is
origin-side: nginx per-IP rate limiting → fail2ban escalation → ~80 in-app
rate-limit buckets → AWS Shield Standard (automatic, L3/L4 only).
**The honest limit:** a single box cannot absorb a real volumetric flood.
For that case the plan IS the emergency Cloudflare onboarding (§6) — everything
before it handles the far more likely L7 / bot / abuse cases.

---

## 1. Know what you're looking at — the 4 scenarios

| Scenario | Signature | Response |
|---|---|---|
| **A. Organic rush** (registration opens, bulk email lands, event morning) | Traffic spike right after *our own* send/announcement; requests are well-formed, spread across pages; 429s clustered on **one venue/office IP** (shared NAT) | **NOT an attack.** §3.1 — raise limits / whitelist, don't ban |
| **B. Single or few abusive IPs** (scraper, brute force, runaway integration) | One/few IPs dominating access logs; repeating URL patterns; fail2ban may already be banning | §4 Level 1 — ban + tighten |
| **C. Distributed L7 flood / botnet** (many IPs, expensive endpoints) | Hundreds+ of distinct IPs, abnormal UA/URI patterns, CPU/conn exhaustion while per-IP counts stay under limits | §4 Level 2 → §6 if losing |
| **D. Volumetric L3/L4** (SYN/UDP flood, pipe saturation) | Box unreachable even from SSM/console-level, network in/out flatlined or maxed, nginx logs quiet (packets never reach it) | §4 Level 3 + §6 immediately |

The most expensive mistake specific to EA-SYS: **treating scenario A as an
attack during a live event** — banning the venue WiFi NAT IP takes the whole
registration desk + kiosk offline. When in doubt during an event day, check the
IP against the venue before any ban.

---

## 2. Detection — how you'll know

- **SNS pages** (topic `ea-sys-alerts`, subscribers krishna@ + vivek@):
  `ea-sys-ec2-cpu-high` (90%), `ea-sys-ec2-cpu-credits-low` (100 — the t3
  **credit-throttle trap**: a sustained flood drains credits, then the box
  crawls at baseline even after the flood stops), `ea-sys-ec2-mem-high`,
  `ea-sys-ec2-status-check-failed`.
- **Symptoms**: slow/unreachable site, health check failing
  (`curl -w '%{http_code} %{time_total}' https://events.meetingmindsgroup.com/api/health`),
  SES admin-alert emails spiking, users reporting 429/522-style errors.
- **`/logs` dashboard** (works as long as the app is up): search
  `rate-limited` — every in-app 429 bucket logs there.

## 3. Triage — 5 minutes, in this order

All box commands run via SSM (see AWS_OPERATIONS §1) — **SSM works even when
HTTP is drowning**, and doesn't depend on port 22:

```bash
aws ssm start-session --target i-0b51ab1213d084640 --region ap-south-1
```

```bash
# 1) Is the box CPU/conn-bound, and is it nginx or the app?
top -bn1 | head -20 && docker stats --no-stream

# 2) WHO is hitting us — top talkers in the last 50k requests:
sudo tail -50000 /var/log/nginx/access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head -20

# 3) WHAT are they hitting — top URIs + methods:
sudo tail -50000 /var/log/nginx/access.log | awk '{print $6" "$7}' | sort | uniq -c | sort -rn | head -20

# 4) Are the defenses already engaging?
sudo tail -200 /var/log/nginx/error.log | grep limiting | tail -20
sudo fail2ban-client status nginx-rate-limit

# 5) t3 credit state (the throttle trap):
aws cloudwatch get-metric-statistics --region ap-south-1 --namespace AWS/EC2 \
  --metric-name CPUCreditBalance --dimensions Name=InstanceId,Value=i-0b51ab1213d084640 \
  --start-time $(date -u -v-30M +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '-30 min' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) --period 300 --statistics Average
```

**Decision:** few IPs dominating → **Level 1**. Many IPs but recognizable
pattern (URI/UA) → **Level 2**. Pipe/packet-level saturation or losing at
Level 2 → **Level 3 + start §6 in parallel** (Cloudflare DNS propagation takes
time — start it early, decide later whether to flip the proxy on).

### 3.1 The false-positive path (scenario A)

Venue/office NAT tripping limits during a legitimate rush:

```bash
sudo fail2ban-client set nginx-rate-limit unbanip <VENUE_IP>
# Keep it from re-banning during the event:
#   add the IP to ignoreip in /etc/fail2ban/jail.d/nginx-rate-limit.conf, then:
sudo fail2ban-client reload nginx-rate-limit
# If nginx 429s are clipping the crowd, raise rate/limit_conn in
# /etc/nginx/sites-available/ea-sys (the BOX file, not the git copy), then:
sudo nginx -t && sudo systemctl reload nginx
```

Revert threshold changes after the event (§7).

---

## 4. Response ladder

### Level 1 — few abusive IPs (minutes)

```bash
# Immediate manual ban (30 min via the jail):
sudo fail2ban-client set nginx-rate-limit banip <IP> [<IP2> ...]

# Longer/permanent — drop at ufw (survives fail2ban restarts):
sudo ufw insert 1 deny from <IP> to any
```

If the abuser is *under* the nginx thresholds, tighten the jail
(`/etc/fail2ban/jail.d/nginx-rate-limit.conf`: `maxretry 100→30`,
`bantime 1800→7200`) and/or the nginx `rate=100r/s` — reload both. Note what
you changed; it gets reverted in §7.

### Level 2 — distributed L7 flood (tens of minutes)

Goal: cheapen each malicious request to near-zero at nginx, before Node/Prisma.
Edit `/etc/nginx/sites-available/ea-sys`, then `sudo nginx -t && sudo systemctl reload nginx`:

```nginx
# a) Block the observed pattern — the highest-value move when the flood has a
#    signature (a URI they hammer, a bogus UA):
location = /api/expensive-thing-being-hammered { return 429; }
if ($http_user_agent ~* "curl|python-requests|<observed-UA>") { return 403; }

# b) Tighten the global zones (halve, re-observe, halve again):
#    rate=100r/s -> 25r/s ; burst=200 -> 50 ; limit_conn 100 -> 25

# c) Protect what MUST keep working during a live event — carve the desk paths
#    out of the tightened limits with their own generous zone:
#    /api/events/.../registrations/_/check-in and .../registrations/badges
#    (the kiosk + scanner), keyed as today on $binary_remote_addr.
```

Also: temporarily **disable the public attack surface you don't need right
now** from the dashboard (Settings → Registration → Registration Open off
stops the whole public register flow server-side, 403 REGISTRATION_CLOSED) if
registration endpoints are the target and no legitimate campaign is running.

**Do NOT "scale up" as a first move.** Resizing the instance mid-flood means
downtime, and feeds a bigger box to the same flood. Fix the filtering first;
scale only for legitimate-traffic growth.

### Level 3 — volumetric / losing at L7

A single EC2 cannot win this. Two moves, in parallel:

1. **Start the Cloudflare onboarding (§6) NOW** — it's the only real
   mitigation for this class and its lead time is DNS propagation.
2. **Shrink the target while you wait:** if the flood targets 80/443
   indiscriminately and there's no event running, you can temporarily restrict
   the Security Group inbound 443/80 to known-needed CIDRs (office, venue) —
   full public outage for everyone else, so this is a business call, not a
   technical one. Keep 22 (GitHub Actions) and remember SSM needs no inbound.
   ```bash
   # Instruct-not-execute: SG edits are operator-run (see AWS rules).
   aws ec2 describe-security-groups --region ap-south-1 \
     --filters Name=ip-permission.from-port,Values=443 --query 'SecurityGroups[].[GroupId,GroupName]'
   ```
3. AWS **Shield Standard** is already mitigating classic SYN/UDP reflection at
   the AWS edge automatically — there is nothing to "turn on". Shield
   *Advanced* ($3k/mo) is not proportionate for EA-SYS; don't panic-buy it
   mid-incident.

**If the box itself is wedged** (credit-starved or OOM): follow
[INCIDENTS.md](INCIDENTS.md) INC-001 diagnosis appendix; worst case
stop/start the instance (new burst credits on unlimited=false is NOT granted —
consider temporarily enabling T3 Unlimited instead:
`aws ec2 modify-instance-credit-specification ... --cpu-credits unlimited`,
operator-run, small overage cost beats an outage).

---

## 5. During a live event — special rules

- **Never ban before checking the venue IP** (§3.1). Get the venue's egress IP
  on event morning (`curl ifconfig.me` from the desk laptop) and pre-add it to
  fail2ban `ignoreip`.
- The **check-in scanner, kiosk, and badge printing** are the only paths that
  MUST stay up minute-to-minute. They're staff-session APIs (not the public
  surface), so Level-2 tightening of public paths doesn't touch them — keep it
  that way (see the Level-2 carve-out).
- Closing public registration (Settings toggle) is cheap and reversible —
  during a flood on event day, on-site registration continues via the desk's
  admin Add Registration regardless.

## 6. Emergency Cloudflare onboarding (the volumetric answer)

The complete, ordering-critical playbook is **[AWS_OPERATIONS.md §4.3](AWS_OPERATIONS.md)**
— follow it exactly; the one-page version:

1. Add the domain to Cloudflare → migrate nameservers → **preserve MX +
   SPF/DKIM/DMARC records or org email dies mid-incident**.
2. `events` A record → Proxied (orange cloud), SSL **Full (strict)**; verify
   `curl -I` shows `cf-ray`.
3. **Only after** CF is serving: lock SG 443/80 to Cloudflare CIDRs (else the
   attacker keeps hitting the EIP directly and nothing improved).
4. nginx: `set_real_ip_from <CF CIDRs>` + `real_ip_header CF-Connecting-IP`
   — **zero app-code changes**; all rate limiting keeps working on real IPs.
5. Turn on the free edge defenses: Bot Fight Mode, WAF managed rules, edge
   rate limiting ("Under Attack" mode if actively flooded).

Time budget: ~15–60 min for DNS cutover under low TTLs; registrar NS changes
can take hours — which is why Level 3 says *start early*. If an incident ever
forces this, **it stays on afterwards** (revisit the "no CDN" decision in the
post-mortem rather than churning DNS twice).

## 7. Stand-down + post-incident

1. Revert emergency nginx/fail2ban tightening on the **box** file
   (`nginx -t` + reload); unban any false-positived IPs; remove temporary ufw
   denies (`sudo ufw status numbered` → `sudo ufw delete <n>`).
2. Re-run the §3 triage commands to confirm normal baselines; check
   `ea-sys-ec2-cpu-credits-low` recovered.
3. Verify the app: prod health 200, a test login, a test scan on the desk if
   during an event.
4. Write the post-mortem in [INCIDENTS.md](INCIDENTS.md) (timeline, signature,
   what worked, thresholds changed) and file follow-ups in ROADMAP — likely
   candidates already known: Redis-backed shared `checkRateLimit` (today's
   in-memory buckets reset on every deploy and aren't shared across
   blue/green), Turnstile on public forms, and the standing Cloudflare
   decision.

---

## Appendix — quick reference

| Thing | Value |
|---|---|
| Box / region | `i-0b51ab1213d084640`, ap-south-1 (Mumbai), t3.large |
| DR box | `i-075c400567ed002e6`, ap-southeast-1 (Singapore) — [infra/dr/README.md](../infra/dr/README.md) |
| nginx limits (live) | `rate=100r/s burst=200` on `/`, `burst=50` on `/api/mcp`, `limit_conn 100`; static + `/stream/` unlimited; box file `/etc/nginx/sites-available/ea-sys` is source of truth |
| fail2ban jail | `nginx-rate-limit`: 100 rejects / 120 s → 30-min ban; `sshd` jail separate; config `infra/fail2ban/` |
| In-app limits | ~80 `checkRateLimit` buckets (table in CLAUDE.md §Rate Limits) — in-memory, per-container |
| Alarms | `ea-sys-ec2-{cpu-high,mem-high,disk-high,cpu-credits-low,status-check-failed,auto-recover}` → SNS `ea-sys-alerts` — never upsert `auto-recover` by hand (carries the EC2 recover action) |
| Access | SSM (no inbound needed): `aws ssm start-session --target i-0b51ab1213d084640 --region ap-south-1` |
| Health | `https://events.meetingmindsgroup.com/api/health` (alias `/health`), worker `/worker/health` |
