# Load Testing EA-SYS

Why this exists: every "it scales fine" judgment about EA-SYS so far is from **reading
code, not measuring it** — no load test has ever been run. Before a large conference
(esp. a registration-open burst or a doors-open check-in rush), one real load test
turns "looks fine" into "measured fine." These scripts + this guide are that test.

Tooling: **[k6](https://k6.io)** (Grafana k6) — a single Go binary, scripts in JS.

Scripts live in [`loadtest/k6/`](../loadtest/k6/):
- `read-burst.js` — **safe on prod** (read-only): public event detail + email preflight.
- `register-burst.js` — **write**: the public self-register burst.
- `checkin-burst.js` — **write + authed**: many desk lanes scanning at once.
- `config.js` — shared env config + the write-safety gates.

---

## ⚠️ Safety — read this first (EA-SYS prod is LIVE)

Production runs real registrations, payments, and emails. Getting this wrong can
pollute data, **send thousands of bounces that wreck SES reputation**, or create junk
Stripe sessions. Rules:

| Scenario | Safe target | Never |
|---|---|---|
| `read-burst` | **Prod (off-hours) OK** — no writes, no email, no Stripe | — |
| `register-burst` | **Staging**, or a **disposable DRAFT test event** with a **FREE ticket type** | A real prod event; a paid ticket type (→ Stripe + emails) |
| `checkin-burst` | **Staging / test event** with seeded test registrations | Checking in real attendees |

Built-in guardrails (in `config.js`):
- Write scenarios **refuse to run** unless `CONFIRM_WRITE=yes`.
- If `BASE_URL` is `events.meetingmindsgroup.com` **and** the scenario writes, it also
  requires `I_REALLY_MEAN_PROD=yes` — a deliberate second key so you can't fat-finger
  a write-burst at prod.

Why a **FREE ticket type** for `register-burst`: the confirmation email is gated on
`price > 0`, so a free registration sends **no email** (and involves **no Stripe**).
That keeps a write test from blasting bounces at `@loadtest.invalid` addresses.

**Strong recommendation:** stand up a throwaway staging box (same Docker image, a
scratch Supabase project / the cold-standby RDS — see
[infra/dr/COLD_STANDBY_RDS.md](../infra/dr/COLD_STANDBY_RDS.md)) for the write
scenarios. "No staging environment" is the real gap that makes full-path load testing
awkward; the read-burst is the safe prod-side proxy in the meantime.

---

## Install k6

```bash
brew install k6                 # macOS
# or: https://k6.io/docs/get-started/installation/
k6 version
```

---

## 1) read-burst (start here — safe on prod off-hours)

```bash
k6 run \
  -e BASE_URL=https://events.meetingmindsgroup.com \
  -e EVENT_SLUG=<an-existing-event-slug> \
  loadtest/k6/read-burst.js
```

Ramps to ~200 concurrent VUs hitting the public event-detail GET + check-email POST.
Validates request throughput, DB read latency under concurrency, and where rate
limits start returning 429.

**Single-IP caveat (important):** all traffic from your one machine shares one client
IP, so per-IP limits (check-email **200/hr**) **will** trip and you'll measure the
*limiter*, not the box. The `rate_limited_429` counter shows when. To measure raw box
capacity, do one of: run from an **allowlisted/known IP** (or the box's own network),
**temporarily raise** the limit for the test window, or use **distributed k6 / k6
cloud** (many IPs). For a quick health check, the rate-limited run is still useful — it
proves the limiter + box stay healthy under a flood.

## 2) register-burst (write — staging or disposable test event)

Create a DRAFT event with a **free** ticket type, grab its slug + ticket-type id, then:

```bash
# SMOKE FIRST — confirm a single registration returns 200/201 before ramping:
k6 run --vus 1 --duration 5s \
  -e BASE_URL=https://staging.example.com \
  -e EVENT_SLUG=loadtest-event -e TICKET_TYPE_ID=ck... \
  -e CONFIRM_WRITE=yes \
  loadtest/k6/register-burst.js

# then the full burst (default stages ramp to ~60 VUs):
k6 run \
  -e BASE_URL=https://staging.example.com \
  -e EVENT_SLUG=loadtest-event -e TICKET_TYPE_ID=ck... \
  -e CONFIRM_WRITE=yes \
  loadtest/k6/register-burst.js
```

The payload in the script must satisfy your event's current `registrationSchema`
(required fields were tightened — title/role/names/email/jobTitle/organization/city/
phone/country/specialty). If the smoke run returns **400**, the script logs the
validation body on the first iteration — fix the payload fields and re-smoke.

## 3) checkin-burst (write + authenticated)

Seed test registrations first (run register-burst, or create a few manually), collect
their `qrCode` values, and get an ONSITE/admin **session cookie** (DevTools →
Application → Cookies → `__Secure-next-auth.session-token`):

```bash
k6 run \
  -e BASE_URL=https://staging.example.com \
  -e EVENT_ID=ckEvent \
  -e SESSION_COOKIE='__Secure-next-auth.session-token=eyJ...' \
  -e QRCODES=code1,code2,code3 \
  -e CONFIRM_WRITE=yes \
  loadtest/k6/checkin-burst.js
```

Simulates ~30 concurrent desk lanes. First scan of a code = check-in (200); re-scans =
"already checked in" (400) — both are healthy round-trips for the throughput measure.

---

## What to watch DURING a run

- **k6 summary** (printed at the end): `http_req_duration` p95/p99, `http_req_failed`
  rate, and the custom counters (`rate_limited_429`, `registrations_created`,
  `validation_400`, `checkins_ok`). The run "passes" the thresholds in `config.js`
  (p95 < 1s, p99 < 2.5s, <2% failures) — tune per event.
- **App logs** at `/logs` (source = database): search `P2024` /
  `connection pool` (pool exhaustion under burst — the signal to raise
  `connection_limit`), and any `:rate-limited` warns (expected from a single IP).
- **CloudWatch** (ap-south-1): EC2 CPU + the t3 **CPU-credit balance** (a sustained
  burst can exhaust burst credits on a t3 and throttle — see
  [docs/AWS_OPERATIONS.md](AWS_OPERATIONS.md) §perf). DB connections on Supabase.
- **SES:** you should see **zero** new sends from a free-ticket register test. If sends
  appear, stop — your ticket type isn't free or another path is emailing.

## Interpreting results — targets for a ~500–2000 conference

- **Latency:** public register p95 should stay well under ~1s at your expected peak
  concurrency. Climbing p99 + rising `P2024` together = pool-bound → raise
  `connection_limit` (currently 10; see below) and/or add a container.
- **Errors:** `http_req_failed` should be ~0 excluding intentional 429s. Real 5xx under
  load = investigate before the event.
- **Throughput vs limits:** if `rate_limited_429` dominates from a single IP, that's the
  limiter, not a failure — re-test from an allowlisted IP / distributed to see the box.

### Levers if a run is unhealthy
- **DB pool:** verified at `connection_limit=10&pool_timeout=15` on the box (port 6543
  pgbouncer). For a heavy burst, bump to 15–20 in the box `.env` and **`bash
  scripts/deploy.sh`** (a `docker compose restart` won't re-read `env_file`). pgbouncer
  multiplexes, so this is low-risk.
- **Rate limits:** already raised for shared-NAT (register 100/15min, checkout 15/60s,
  check-email 200/hr). Raise further per-event if needed.
- **Box size:** single t3.large today. If CPU saturates or burst credits drain, scale
  the instance or split web/worker onto separate boxes (CLAUDE.md §Deployment).

---

## Cleanup (write scenarios)

- Delete the disposable **test event** — its registrations/attendees cascade out.
- Test registrant **User** accounts (REGISTRANT, `@loadtest.invalid`) are org-null and
  harmless; delete via Settings → Users or a scoped DB cleanup if you want them gone.
- Reset any seeded `checkedInAt` if you reuse the same test registrations.

## Roadmap

- Stand up a **staging environment** (the real unlock for routine write-path load
  testing without prod risk).
- A distributed / k6-cloud run to measure true box capacity past the per-IP limits.
- CI smoke (1-VU) on the read paths to catch latency regressions.
