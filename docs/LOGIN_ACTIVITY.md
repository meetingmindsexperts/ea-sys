# Sign-in activity tracking

**Shipped July 28, 2026.** Records every sign-in attempt — successful or not — with
who, when, from which IP, and an approximate location. Adds the failed-attempt
throttle that the web login had never had.

Operator-facing walkthrough lives in the user guide (§14 Settings → *Sign-in
Activity*), which is what the in-app help chatbot reads. This document is the
developer/architecture record.

---

## 1. What existed before

Nothing. Not a database row, not even a log line for web sign-ins.

`logAuthEvent()` in [src/lib/logger.ts](../src/lib/logger.ts) — with `"login"` /
`"logout"` / `"register"` / `"failed_login"` cases — has been present since the
project began and is called from **zero** call sites. The mobile route wrote a
pino line with no IP.

Separately, and more seriously: **the NextAuth credentials path had no rate limit
at all.** Every dashboard and event-scoped login went through it, so passwords
were brute-forceable against production unthrottled. `/api/auth/mobile-login` did
have one, but it read the client IP from `x-forwarded-for.split(",")[0]` — the
*first*, client-supplied entry on a directly-exposed origin — so any attacker
could forge a header and get a fresh bucket per request. Both are fixed here.

---

## 2. Model

`LoginEvent` — one row per **attempt**. Additive + idempotent migration
`20260728100000_add_login_event` (new enums, new table, new indexes; nothing
existing altered, so it is blue-green safe and needs no backfill).

| Column | Notes |
|---|---|
| `userId?` / `organizationId?` | Both nullable, and **null carries meaning** — see §2.2 |
| `email` | The address that was *attempted*, lowercased. Present even when no user matched. |
| `outcome` | `SUCCESS` / `FAILED_PASSWORD` / `FAILED_UNKNOWN_EMAIL` / `BLOCKED_RATE_LIMIT` |
| `surface` | `DASHBOARD` / `EVENT_PAGE` / `MOBILE` — a display hint, **not** a security boundary (the web values are client-supplied) |
| `ipAddress` / `userAgent` | Captured at the attempt |
| `geoCity` / `geoCountry` / `geoResolvedAt` | Filled in **lazily** — see §4 |

Indexed on `[organizationId, createdAt]` (the admin view's default query),
`[userId, createdAt]`, `[email, createdAt]` (works for unknown addresses, which
have no userId), `[ipAddress, createdAt]` (the brute-force pivot) and
`[createdAt]` (the retention sweep).

### 2.1 Why not `AuditLog` rows

`AuditLog` already has the right columns (`userId` / `ipAddress` / `userAgent` /
`createdAt`) and reusing it would have been free. Three things ruled it out:

1. **Failed attempts are an unauthenticated, attacker-controllable write path.**
   `AuditLog` is the business audit trail that `GET /api/activity` reads; letting
   an anonymous brute-forcer append thousands of rows would drown the record of
   what staff actually did.
2. **`AuditLog` has no prune job**, and its rows survive a subject-erasure
   request. Sign-in IP + location is personal data that needs a bounded window.
3. **`entityType` / `entityId` are required** and mean nothing for a failed
   attempt on an address that resolves to no user.

### 2.2 Why `FAILED_UNKNOWN_EMAIL` is separate from `FAILED_PASSWORD`

Together they answer different questions. A run of `FAILED_PASSWORD` against one
person means *that account is being targeted*. A run of `FAILED_UNKNOWN_EMAIL`
means *someone is spraying addresses* — reconnaissance, usually background
internet noise. Collapsing them into one `FAILED` value would lose exactly the
distinction an admin needs to decide whether to act.

An unknown-email attempt has no user and therefore no org, so it is **invisible
in the org-scoped admin view by construction**. That is intended, not an
oversight — see §7 for the trade-off.

---

## 3. The single writer

[src/lib/login-audit.ts](../src/lib/login-audit.ts) `recordLoginEvent()` is the
**only** thing that writes `LoginEvent`. There are four doors into the product:

| Door | Path |
|---|---|
| Dashboard login | `src/app/(auth)/login/page.tsx` → `authorize()` |
| Event-scoped login | `src/app/e/[slug]/login/page.tsx` → `authorize()` |
| Auto-sign-in after abstract registration | `src/app/e/[slug]/abstract/register/page.tsx` → `authorize()` |
| Mobile app | `src/app/api/auth/mobile-login/route.ts` (own bcrypt path) |

All four funnel through the one writer, per the project's
no-cross-caller-duplication rule.

**Contract: never throws, never blocks.** Recording a sign-in must not be able to
prevent one — the worst a database blip can do is lose a row, never lock a user
out. Callers fire it without awaiting.

### 3.1 Lookup-before-throttle ordering

In both `authorize()` and the mobile route the **user lookup runs first**, before
the throttle check. This is deliberate: a blocked attack on a real account must
be attributed to its organization, or it would be recorded org-null and be
invisible in precisely the view an admin needs. It costs one indexed lookup; the
expensive step (bcrypt) still sits behind the throttle.

---

## 4. Location

[src/lib/login-geo.ts](../src/lib/login-geo.ts). Resolved **lazily**, when an
admin opens the view — never during login. An outbound HTTP call between the
password check and session creation makes signing in feel broken, and a provider
that throws would fail the login outright.

- Each distinct address costs **one lookup, ever**. The answer is written back
  keyed on the IP, so every row sharing it is filled at once.
- A **failed** lookup writes nothing, leaving `geoResolvedAt` null so it retries
  next view. `ok: true` with null fields means "resolved, genuinely no location"
  (a private address) and *is* stamped, so it is never retried.
- Private / unroutable / malformed addresses resolve to no-location **without
  any outbound call**.
- IPs are **shape-validated before being interpolated into the outbound URL**.
  Leading-zero octets are rejected — `0177.0.0.1` is octal for `127.0.0.1` in
  some resolvers, so a non-canonical octet is a way to smuggle one address past
  a check that reads it as another.
- Bounded: max 25 lookups per request, concurrency 5.

### 4.1 Environment variables

⚠️ `.env.example` is **gitignored** in this repo (`.gitignore` line 44's `.env*`
pattern catches it), so it is not the durable home for these. They are recorded
here:

| Var | Default | Meaning |
|---|---|---|
| `LOGIN_GEO_ENABLED` | unset (= enabled) | Set to `"false"` and **no IP ever leaves the box**. The view degrades to raw IPs and says so. |
| `LOGIN_GEO_TOKEN` | unset | Optional ipapi.co key. Without one the free tier allows ~1000 lookups/day, which is ample because each address is resolved once. |

### 4.2 Privacy note

This sends a user's IP address — personal data — to **ipapi.co, outside the
region**. That is a cross-border transfer, and it sits awkwardly against the
data-residency posture elsewhere in the platform. It defaults **on** because
city + country was the requested feature, and it is behind the single switch
above. Revisit if the PDPL stance tightens.

Accuracy caveat, surfaced in the UI: IP geolocation resolves to the **network**,
not the person. Country is usually right; city is frequently the ISP's exchange.
A VPN or mobile connection can be far off. It is a "does this look wrong?"
signal, never evidence.

---

## 5. The throttle

[src/lib/login-throttle.ts](../src/lib/login-throttle.ts).

**Why not `checkRateLimit`.** The shared helper consumes a token on every call,
which is right for "N requests per window" and wrong for a login throttle twice
over:

1. It would count **successes**. At a conference hundreds of attendees sign in
   from one venue-NAT address; burning budget on people who typed their password
   correctly would lock out the room.
2. It has **no reset**. Two typos followed by a success should leave a clean
   slate, not two failures closer to a lockout.

Rather than add a flag to a helper used at ~105 call sites to serve one caller,
this is its own primitive with the semantics the problem actually has: **peek
before the attempt, charge only on failure, clear on success.**

| Bucket | Limit | Rationale |
|---|---|---|
| Per **email** | 10 / 15 min | The real protection. A person does not fail ten times in a quarter hour; an attacker guessing one account does nothing else. Also catches the distributed case (many IPs, one address). |
| Per **IP** | 100 / 15 min | Deliberately loose. Its only job is stopping a single host spraying — *not* policing a shared address. |

A success clears the **email** bucket only. Clearing the IP bucket too would let
an attacker who holds one valid account reset the spray counter at will.

The email bucket is charged for **unknown addresses too**, so being told you are
throttled reveals nothing about whether an account exists — no oracle.

Throttled web attempts `throw` a `CredentialsSignin` subclass with
`code: "RateLimited"`, so the login page says "wait a few minutes" instead of
telling a locked-out admin their correct password is wrong. All three web pages
fall back to the generic message if the code is absent.

**Store is in-memory, per container** — same as `checkRateLimit`. Counters reset
on deploy and two containers keep separate tallies. Accepted for the same reason
it is accepted there: it raises the cost of brute force by orders of magnitude
without a Redis dependency. See §7.

---

## 6. Visibility

[src/lib/login-visibility.ts](../src/lib/login-visibility.ts) —
`canViewLoginActivity()` / `denyLoginActivity()`. **SUPER_ADMIN + ADMIN only.
No API-key path.**

This is its own predicate, not a borrowed one. Every close-enough guard was wrong
in a different direction:

- `denyReviewer` is a **write** guard and permits ORGANIZER.
- `canViewFinance` includes MEMBER **and** ONSITE.
- `canExportRegistrations` excludes MEMBER correctly but includes ONSITE, and
  answers "may you take the delegate book away".

Sign-in records are security data about colleagues: IP address, approximate
location, and the hours a named person was at their desk. An organizer running
one conference has no business reading it. There is no API-key path because a key
leaking into an automation log would expose staff movements rather than business
records — if a genuine integration need appears it should be an explicit grant,
not inherited.

---

## 7. What this does **not** do

Recorded honestly so nobody assumes coverage that isn't there.

### Not built

- **No per-user "your recent sign-ins" view.** The offered option was
  admin-only for v1. Standard account-security practice is to also show a person
  their own history so they can spot a session they don't recognise — that is
  the part that catches a compromised password early, and it is not here.
- **No alerting.** Nothing emails or notifies anyone about a burst of failures,
  a login from a new country, or a lockout. An admin only sees it if they open
  the tab. Everything is warn-logged (`auth:login-throttled`,
  `auth:login-bad-password`, `auth:login-unknown-email`), so it reaches `/logs`,
  CloudWatch and Sentry — but nothing is *pushed*.
- **No CSV export.** Deliberate: export is a separate, narrower boundary in this
  codebase (see `denyContactExport` / `denyRegistrationExport`), and adding one
  would mean an audited export path via `recordExport`. Not asked for.
- **No session/device list, and no remote sign-out.** This records *attempts*,
  not live sessions. Sessions are stateless JWTs with a 24h rolling window
  (`AuthSession` exists from the Prisma adapter but is unused under
  `strategy: "jwt"`), so there is no server-side session to enumerate or revoke.
  "Sign out everywhere" would need a token-version column on `User` checked in
  the JWT callback — a separate piece of work. Full reasoning, and the
  stateless/database/Redis trade-off, in
  [SESSION_ARCHITECTURE.md](SESSION_ARCHITECTURE.md).

  **Partially addressed July 28, 2026:** "who is logged in right now" is now
  answered by `User.lastSeenAt` presence tracking (Settings → Sign-in Activity →
  *Active Now*). That shows who is **active**, which is usually what the question
  means — but it is not a session list, and revocation remains impossible.
- **No logout / session-expiry records.** Only sign-in attempts. `logAuthEvent`'s
  `"logout"` case remains uncalled.
- **No password-reset or invitation-acceptance records.** Those routes exist
  (`/api/auth/reset-password`, `/accept-invitation`) and are untouched — they do
  not write `LoginEvent`. An account takeover via password reset leaves no trace
  in this view.
- **No mobile-refresh records.** `/api/auth/mobile-refresh` mints a new access
  token without a `LoginEvent` row, so a long-lived mobile session shows one
  sign-in and then nothing.
- **No MCP / API-key / OAuth access records.** Those are separate auth surfaces
  with their own `lastUsedAt` tracking; they are not sign-ins and are not here.

### Known limitations

- **Unknown-email attempts are invisible in the UI.** They are *recorded* (org
  null) but the org-scoped view cannot show them. So "someone is hammering our
  login page with made-up addresses" is not visible to an admin — only to
  someone reading the table or the logs directly. Deliberate for v1 (see §2.2);
  revisit if spray volume becomes a question people ask.
- **The throttle store is in-memory and per container.** Counters reset on every
  deploy, and a blue-green swap mid-attack hands the attacker a clean slate.
  Two containers each keep their own tally, so effective limits are roughly
  doubled. This is the same known limitation `checkRateLimit` carries; migrating
  both to a shared store is one piece of work, not two.
- **Surface is client-supplied** on the three web doors. A crafted request can
  claim any surface. It is a display label only — nothing keys off it.
- **Timing oracle on account existence (pre-existing, not introduced).** bcrypt
  only runs for addresses that resolve to a user, so response time differs
  between existing and non-existing accounts. Closing it needs a dummy compare
  on the miss path.
- **`geoResolvedAt` is only ever set by an admin opening the view.** Rows nobody
  looks at are pruned at 180 days having never been resolved — which is fine,
  but means location coverage is a function of who browsed what.
- **No `organizationId` on `AuditLog`** remains an open multi-tenancy gap
  elsewhere; `LoginEvent` was given a real FK from the start, so it does not add
  to that debt.

### Deployment prerequisites

1. **Migration has not been applied to production.** `scripts/deploy.sh` runs
   `prisma migrate deploy`, so a normal deploy applies it. Additive + idempotent.
2. **The worker needs a redeploy** for `login-event-prune` (JOB_ID 1013, 04:15
   UTC daily) to start. Harmless if delayed — nothing is 180 days old yet.

---

## 8. Retention

`login-event-prune` — [src/lib/login-event-prune-worker.ts](../src/lib/login-event-prune-worker.ts)
+ [worker/jobs/login-event-prune.ts](../worker/jobs/login-event-prune.ts). Daily
at 04:15 UTC, offset from `email-log-prune` (03:45) so the two sweeps don't
contend.

**Deletes** rows past `LOGIN_EVENT_RETENTION_DAYS = 180` — unlike the email prune
it does not keep a husk, because a sign-in record stripped of address, location
and user carries nothing worth storing, and this is personal data that must not
become a permanent movement log of the team. 180 matches
`EMAIL_BODY_RETENTION_DAYS` so the product has one retention number.

Batched (1000/statement, 20 batches/tick) and **reports `capped: true`** rather
than silently truncating a backlog.

---

## 9. Files

| File | Role |
|---|---|
| `prisma/migrations/20260728100000_add_login_event/` | Additive migration |
| `src/lib/login-audit.ts` | The ONE writer; never throws |
| `src/lib/login-throttle.ts` | Failures-only throttle |
| `src/lib/login-geo.ts` | Lazy IP → location, SSRF-guarded |
| `src/lib/login-visibility.ts` | ADMIN+ read boundary |
| `src/lib/login-event-prune-worker.ts` | 180-day retention sweep |
| `src/app/api/organization/login-activity/route.ts` | Admin read + lazy geo fill |
| `src/components/settings/login-activity-card.tsx` | Settings → Sign-in Activity |
| `worker/jobs/login-event-prune.ts` | Cron shim |

Tests: `__tests__/lib/login-{throttle,geo,audit,event-prune}.test.ts` +
`__tests__/api/login-activity-route.test.ts` (109 cases).
