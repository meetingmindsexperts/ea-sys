# In-house, open-sourceable public-page analytics

> **Status: BUILT 2026-08-20**, the same day it was planned. Live on production
> and recording. This doc is kept as the design record; what shipped is in the
> five commits `8e83845a` (core), `cb960966` (ingest + storage), `dccdcaca`
> (beacon), `34a90d58` (alarm latch) and `f2add6e1` (dashboard).
>
> **Deviations from the plan, recorded so the next reader does not think it was
> simply ignored:**
>
> 1. **Two hits per visit, not one.** §3.1 listed time-on-page and scroll depth
>    without saying how they arrive. They are a SECOND hit (`page_engagement`)
>    sent on departure, because amending the `pageview` would double the one
>    number that has to be right.
> 2. **The funnel is route-based, not event-based.** §6.1 called for named
>    conversion events on the register path. The shipped funnel is derived from
>    ordinary pageviews plus the real `Registration` count, which needs no extra
>    instrumentation and cannot under-report the final step when a beacon is lost
>    to a closed tab. The named events are accepted by the endpoint and unused;
>    they refine this later rather than replace it.
> 3. **The no-secret alarm is latched.** Not in the plan at all. Logging an error
>    per pageview while `ANALYTICS_SALT_SECRET` was unset would have buried
>    `/logs` and fed the SES alert the same sentence hourly, in a state that is
>    completely ordinary between deploying and configuring.
> 4. **A real bug was found while testing the buffer**, not by review: when a
>    flush was in flight and the buffer refilled to the threshold, the enqueue
>    path returned early without scheduling a timer, so that batch sat stranded
>    until another hit happened to arrive. Under a burst that ends abruptly it
>    would never have been written.
>
> Still deferred as planned: country (§6.2), the org-level cross-event view, and
> publication of the core as a package (§7.4).
>
> Owner decision this round: build visitor analytics **in house**, structured so
> the measurement core **could be open sourced** later, and capture as much as
> the privacy envelope allows. Google Analytics was considered and rejected;
> Plausible and Matomo were considered and rejected. The reasoning for all three
> rejections is in §2, because the next person to ask "why not just add GA?"
> deserves the answer without re-deriving it.

---

## 1. What we are trying to answer

Today EA-SYS can tell you a great deal about people who **completed** something
and nothing at all about the people who did not.

`Registration` already carries `utmSource` / `utmMedium` / `utmCampaign` and
`referrer`, captured by [register/[category]/page.tsx](../src/app/e/%5Bslug%5D/register/%5Bcategory%5D/page.tsx)
and surfaced in the detail sheet and CSV export. There is even a UTM link
builder on the tickets page. So *"which channel produced this registration"* is
answered, first-party, already.

**What is missing is the denominator.** Nobody can answer:

- 500 people opened the register page. 80 registered. Where did the other 420 go?
- Which step of the two-step form loses people?
- Is the LinkedIn campaign producing traffic that does not convert, or no traffic?
- How many people read the agenda but never reached the register page?
- Did anyone look at this event at all before we emailed them?

That is the whole scope. It is a traffic and funnel question, not an identity
question.

---

## 2. Why not GA, Plausible, or Matomo

### 2.1 Google Analytics: rejected

Three independent reasons, any one of which is sufficient.

**It would falsify a written client commitment.** §6 of
[SECURITY_AND_PRIVACY_POSTURE.md](SECURITY_AND_PRIVACY_POSTURE.md) currently
states, in a document given to **EHS, a UAE federal health authority**:

> *No advertising or behavioural analytics. There is no Google Analytics, no
> advertising pixel, no tracking cookie, and no third-party analytics of any
> kind. The only cookie is the sign-in session.*

The same section separately flags **Google Fonts** as a concern because it
"discloses visitor IP addresses to Google", offering to self-host if EHS
objects. Loading Google Analytics on those same pages, from the same company,
would contradict a position we took in writing two paragraphs earlier.

**Our URLs carry credentials and PII.** GA4's automatic pageview sends
`page_location`, which is the full URL including path and query string. Eight
public routes would hand Google something that must not leave our
infrastructure:

| Route | What would ship to Google |
|---|---|
| `/e/{slug}/confirmation?id=…&name=…` | Registrant first name + registration id ([checkout/route.ts:152](../src/app/api/public/events/%5Bslug%5D/checkout/route.ts#L152)) |
| `/e/{slug}/reset-password?token=…&email=…` | A live password-reset token and the account email |
| `/e/{slug}/reimbursement/{token}` | The token gating passport scans and bank details |
| `/e/{slug}/rsvp/{token}`, `/speaker-form/{token}` | Bearer credentials; the token *is* the identity |
| `/complete-registration?token=`, `/presenter-agreement?token=`, `/survey?token=` | Single-use access tokens |

This also breaches Google's own Terms of Service, which prohibit sending PII to
Analytics. The failure mode is not only a regulator; it is Google terminating
the property and us losing the measurement anyway.

**There is no consent mechanism.** No cookie banner, no consent component
anywhere in `src/`. GA is not "strictly necessary", so GDPR requires prior
consent and UAE PDPL (Federal Decree-Law 45/2021, cited by name in our own
speaker agreement) is consent-based. Adding GA would be non-compliant on day
one, not eventually.

### 2.2 Encryption is the wrong control, and this is worth internalising

TLS in transit and Google's at-rest encryption are both fine, and both
irrelevant. The risk is not interception. Google is the **intended recipient**.
Encryption protects data from parties who should not have it; it does nothing
about disclosure to the party you are deliberately sending it to.

**For analytics the primary control is data minimisation, not encryption.** If
the identifier is never collected there is nothing to encrypt, nothing to leak,
no subject-access request to service, and nothing to delete. Done properly, the
data is arguably not personal data at all, which removes the consent banner and
most of the compliance surface. That is the design target of everything below.

### 2.3 Plausible: good, rejected on two specifics

The official [community-edition compose.yml](https://raw.githubusercontent.com/plausible/community-edition/master/compose.yml)
(v3.2.1, verified 2026-08-20) defines three services: `postgres:16-alpine`,
`clickhouse/clickhouse-server:24.12-alpine`, and the app. The Postgres container
is replaceable via `DATABASE_URL`; **ClickHouse is not** and it is the store
holding the visitor data.

| Concern | Consequence |
|---|---|
| ClickHouse data directory lives on the **unencrypted EC2 root volume** | That is §0.2, the open gap we are actively trying to close for EHS. We would be adding data to it. Solvable with a separate encrypted EBS volume, but not free. |
| ClickHouse sits **outside the DR stream** | Our DR is hourly `pg_dump` to Singapore with KMS plus a quarterly restore drill. ClickHouse would be a fourth backup stream with no runbook and no drill. |

Plausible's privacy engineering is genuinely good and its goals feature *can*
express a conversion funnel. This is a close call, not a dismissal. If the
in-house build stalls, Plausible is the fallback, **but the encrypted volume
must be done first.**

### 2.4 Matomo: rejected

Cookies **on by default**, IP storage **on by default**, PHP plus MySQL, and a
substantial CVE history that works directly against §8 (vulnerability
management) on the same questionnaire. Its one genuine advantage is the CNIL
consent-exemption precedent when configured to their guidance. Not worth the
surface area for a client reading our third-party table sceptically.

### 2.5 What in-house buys, stated plainly

| | In-house |
|---|---|
| Encrypted at rest | **Yes.** Lands in Supabase. §3 of the posture doc already answers yes for the primary database. |
| In DR backups | **Yes.** Rides the existing hourly `pg_dump` automatically. |
| New rows in §6 third-party table | **Zero.** |
| New components to patch (§8) | **Zero.** |
| Multi-tenant isolation | Inherits `organizationId` + RLS instead of being a second isolation model to keep in sync on the platform instance. |
| Funnel joins to `Registration` | Native. Same database, same query. |

The honest cost: we write the anonymisation ourselves, and we get no free
dashboard.

---

## 3. What "track almost everything" means, and what it excludes

The owner's ask is to capture as much as possible. That is compatible with the
privacy envelope for almost everything that matters, but not for everything, and
the exclusions should be a knowing choice rather than a later surprise.

### 3.1 What we WILL capture

**Traffic**: pageviews, unique visitors (per day), sessions, entry page, exit
page, bounce rate, pages per session.

**Acquisition**: referrer host, `utm_source` / `utm_medium` / `utm_campaign`,
direct vs referred. Joins to the UTM values already on `Registration`, so
channel to revenue becomes one query.

**Context**: device type (mobile / tablet / desktop), browser family, OS family.
Country is Phase 2 (§6.2).

**Engagement**: time on page, scroll depth.

**Conversion**: named events with optional numeric value:
`register_viewed`, `register_step2`, `register_submitted`, `checkout_started`,
`payment_completed`, `agenda_viewed`, `session_viewed`, `abstract_started`,
`abstract_submitted`. Enough for a per-step funnel with drop-off.

### 3.2 What we deliberately CANNOT capture

| Not captured | Why |
|---|---|
| Cross-day individual journeys | The visitor salt rotates every 24h. This is the property that makes the data effectively anonymous, and it is the reason no consent banner is needed. |
| Cross-site or cross-device identity | No cookie, no persistent id. Not technically possible here, by design. |
| "Did Dr X visit the page?" | Deliberately impossible. If it were possible, the whole compliance argument collapses. |
| Ad-platform bid optimisation | Google Ads and Meta want *their* pixel firing a conversion to optimise bidding. First-party analytics reports attribution; it does not substitute for that. Separate decision, separate consent question. |

**If any of the first three later becomes a business requirement, this design is
the wrong design** and the conversation reopens with consent banners attached.
Say so now rather than quietly bending the salt rotation later.

---

## 4. Design

### 4.1 No client-side storage of any kind

No cookie. No `localStorage`. No `sessionStorage`. This is stricter than
strictly necessary and it is deliberate: it is the single property that makes
the §6 sentence remain true and makes the ePrivacy consent question disappear
rather than merely become arguable.

The cost is that a session is **derived**, not stored (§4.3), which produces a
small artifact at 30-minute boundaries. Worth it.

### 4.2 Visitor identity: rotating-salt hash, computed server-side

```
visitorHash = sha256( dailySalt || clientIp || userAgent || siteId )
```

- **The salt rotates every 24 hours.** This is the load-bearing line in the
  entire design. Without rotation we have built a persistent identifier and the
  compliance story is gone. It gets its own test, mutation-verified.
- **Computed server-side.** The client never sends or sees the hash, and the raw
  IP never leaves the request handler. Nothing stores the IP.
- **`siteId` is in the hash** so the same person on two tenants' events is two
  unrelated hashes.
- The previous day's salt is kept only long enough to avoid a discontinuity at
  the rotation boundary, then discarded.

### 4.3 Sessions: derived, not stored

```
sessionHash = sha256( visitorHash || floor(now / 30min) )
```

No storage, no state. Two pageviews 5 minutes apart share a session; two
pageviews straddling a 30-minute boundary split into two. That over-counts
sessions slightly. Accepted, and documented so nobody later "fixes" it by adding
`sessionStorage`.

### 4.4 Path policy: allow-list, never exclude-list

Only these route patterns are measurable:

```
/e/[slug]
/e/[slug]/agenda
/e/[slug]/register
/e/[slug]/register/[category]
/e/[slug]/session/[sessionId]
/e/[slug]/confirmation        (path only; see below)
```

Everything else, including every token route, is **unmeasurable by
construction**. A new public route added in six months is invisible by default
rather than leaking by default.

This is the same inversion applied to `/uploads` on 2026-08-19: an exclude-list
fails open, an allow-list fails closed. That lesson is one layer up here and it
is the same lesson.

**Query strings are dropped entirely except `utm_source`, `utm_medium`,
`utm_campaign`**, which are read into their own columns. This kills the `?name=`
and `?token=` exposure at source rather than depending on a filter somebody
maintains.

Both the **path** and the **route pattern** are stored: the path answers "this
event's register page", the pattern answers "register pages across all events".

### 4.5 Writes are buffered, not per-request

A single INSERT per pageview would put the public traffic path on the same
Prisma pool that serves the registration desk. We have already had a P2024
pool-exhaustion incident (2026-06-10), so this is a known failure mode, not a
hypothetical one.

**Buffer in memory, flush every 2 seconds or every 25 rows**, using
`createMany`. This is exactly the pattern
[logger.ts:100-144](../src/lib/logger.ts#L100-L144) already uses for the
`SystemLog` DB stream. Reuse the shape.

Consequences, stated so nobody is surprised:

- A container restart loses up to 2 seconds of pageviews. Acceptable; this is
  traffic measurement, not money.
- Blue-green means both containers buffer independently. Fine, they write to the
  same table.

**The beacon must never log per hit.** Pino writes `logs/app.log` and
`logs/error.log` to the EC2 root volume, which is unencrypted (§0.2 of the
posture doc). A per-hit info line would therefore put visitor hashes and paths
on the one unencrypted surface we are trying to close, and at conference traffic
it would be an absurd volume anyway. The write path logs **failures only**:
a flush error, a rejected payload, a rate-limit trip. Never a successful hit.

This is the only place the analytics design touches the EC2 disk at all.
Everything else lands in Supabase, which is already encrypted at rest.

### 4.6 Bot filtering

- The beacon is JavaScript, so simple crawlers never fire it. That is most of
  the problem solved for free.
- A known-bot user-agent list lives in `core/bots.ts` and is unit-tested.
- Hits with an absent or absurd user-agent are dropped.
- Hits where the page never became visible (`document.visibilityState`) are
  dropped.

Bot filtering is a treadmill and will never be perfect. The list is a
maintenance item, not a solved problem, and the doc says so.

### 4.7 Tenancy

`AnalyticsEvent` is born tenancy-compliant, matching the pattern used for
`RegistrationGroup`:

- `organizationId` stamped at write, resolved from the site.
- `runWithTenant` around every read.
- `prisma/rls/analyticsevent.sql` flat policy in the same PR.
- Entry in `scripts/check-tenant-als.sh`.
- A harness assertion in `tests/tenancy/`.

The public beacon has no session, so the org is resolved from the site slug via
`publicEventWhere`. That lookup is cached in memory with a TTL so it is not a
database round-trip per pageview.

---

## 5. Schema

One additive table. No changes to any existing model.

```prisma
model AnalyticsEvent {
  id             String   @id @default(cuid())

  organizationId String?          // tenancy; stamped at write
  eventId        String?          // which conference's public pages
  siteId         String           // opaque site key = event slug today

  name           String           // "pageview" | "register_submitted" | ...
  path           String           // normalised, allow-listed, query stripped
  routePattern   String           // "/e/[slug]/register/[category]"

  visitorHash    String           // rotating daily salt; never reversible
  sessionHash    String           // derived, 30-minute window

  referrerHost   String?          // host only, never the full referrer URL
  utmSource      String?
  utmMedium      String?
  utmCampaign    String?

  deviceType     String?          // "mobile" | "tablet" | "desktop"
  browser        String?
  os             String?
  country        String?          // Phase 2, self-hosted lookup

  durationMs     Int?
  scrollDepth    Int?             // 0-100
  value          Decimal?         // conversion value, e.g. ticket price

  createdAt      DateTime @default(now())

  @@index([siteId, createdAt])
  @@index([eventId, name, createdAt])
  @@index([organizationId])
  @@index([visitorHash, createdAt])
}
```

**Naming.** `AnalyticsEvent` sits beside the conference `Event` model. The
collision is real but survivable and consistent with the existing `LoginEvent`,
which coexists fine. Inside `src/analytics/core/` there is no collision because
the core does not know conferences exist (§7).

**No `ipAddress` column exists.** Not nullable, not optional. Absent. A column
that does not exist cannot be filled in by a well-meaning future PR.

**Retention: 400 days**, pruned by a worker job. 400 rather than 365 so a full
year-over-year comparison has margin. Volume is not a concern: roughly 20,000
pageviews per event across roughly 20 events per year is about 400k rows
annually, which is nothing for Postgres.

---

## 6. Scope

### 6.1 In v1

Everything in §3.1 except country. The beacon, the endpoint, the buffered
writer, the tenancy package, the prune job, the conversion events, and a Traffic
section on the existing event Analytics page including the register funnel
joined to `Registration`.

### 6.2 Deliberately NOT in v1

| Deferred | Why |
|---|---|
| **Country / geo** | Doing it without a third party needs a self-hosted MaxMind GeoLite2 database: a free account, a ~6MB file, and a refresh job. Using `ipapi.co` (already in §6 for login geo) would mean an outbound call per pageview and sending visitor IPs to a US third party, which defeats the point. Worth doing, not worth blocking v1. |
| **Org-level cross-event dashboard** | The per-event view answers the actual question. Add once there is data. |
| **Daily rollup table** | Unnecessary at this volume. Raw rows are simpler and let us answer a question we have not thought of yet. |
| **Publishing the open-source package** | §7.4. Designed for, not committed to. |
| **Ad-platform pixels** | Separate decision with its own consent question. |

---

## 7. Open-sourceable structure

### 7.1 The split

The reusable part is most of it, and it is the part with the actual content.

| Generic, ships | EA-SYS specific, stays |
|---|---|
| Rotating-salt visitor hash | `organizationId` / `eventId` |
| Path allow-list, query stripping | Prisma schema, RLS policy |
| Bot filtering | `runWithTenant`, auth guards |
| Aggregation math | Worker prune registration |
| Beacon client script | The join to `Registration` |

### 7.2 Layout

```
src/analytics/
├── core/                  # ZERO imports from EA-SYS. This is what could ship.
│   ├── visitor-hash.ts    # rotating salt identity
│   ├── path-policy.ts     # allow-list, query stripping, route patterns
│   ├── bots.ts
│   ├── aggregate.ts       # pure math over rows
│   ├── beacon.ts          # framework-free client script
│   └── types.ts           # AnalyticsHit, AnalyticsStore, Config
├── store/prisma-store.ts  # implements AnalyticsStore w/ Prisma + runWithTenant
├── buffer.ts              # the SystemLog-style batched writer
├── react/use-pageview.ts  # thin wrapper over beacon
└── README.md
```

The whole contract is one interface:

```ts
interface AnalyticsStore {
  record(hits: AnalyticsHit[]): Promise<void>;
  query(q: AnalyticsQuery): Promise<AnalyticsRow[]>;
}
```

Core defines it. EA-SYS implements it. Ports and adapters.

### 7.3 The four rules

1. **`core/` imports nothing from EA-SYS.** Not `@/lib/db`, not the logger, not
   `next/server`. Enforced by a second `no-restricted-imports` zone in
   [eslint.config.mjs](../eslint.config.mjs) beside the existing CRM boundary at
   lines 57 to 64.
2. **No EA-SYS vocabulary in core.** `siteId` not `organizationId`, `context`
   not `eventId`. Tenancy is a string passed through, not a concept the library
   understands. This rule quietly does the most work.
3. **Core tests run with no database.** Precedent:
   [event-time.ts](../src/lib/event-time.ts) and
   [abstract-theme-requirement.ts](../src/lib/abstract-theme-requirement.ts)
   have zero imports today.
4. **License hygiene from commit one.** No MMG strings, no hardcoded domains,
   MIT headers. Retrofitting IP cleanliness is painful; starting clean is free.

**The thing that could break this design:** the funnel join to `Registration` is
why in-house won, and core must not know what a registration is. Resolution:
core answers *"hits by path, site, date, name"*; `event-analytics.ts` joins that
to registration counts. The join is an EA-SYS concern and belongs outside the
reusable part. The funnel still works.

### 7.4 Publishing is a separate decision, deliberately deferred

Designing for extraction is cheap and reversible. **Publishing is a commitment**:
issues, PRs, semver, docs, and a CVE process on a library that processes visitor
IPs, owned by one engineer. A published privacy library with open security
issues and a stale last commit is a *negative* trust signal on the same
questionnaire it was meant to strengthen.

And the credibility benefit does not require publication. It comes from
**auditability**, which two much cheaper routes deliver:

- Paste the visitor-hash function into `SECURITY_AND_PRIVACY_POSTURE.md` §6 as
  an appendix. A reviewer verifies the salt rotates and no IP is retained by
  reading one screen. That is the entire claim.
- Offer source review under NDA if a client pushes further.

Revisit publication in roughly six months, once we know whether anyone outside
MM Group ever asked.

---

## 8. Build order

Five phases, each independently commitable and gated by
`npx tsc --noEmit` + `npm run lint` + full vitest + `npm run build`.

| Phase | Contents | User-visible? |
|---|---|---|
| **1** | `core/` pure module + tests. Salt rotation mutation-verified. No wiring. | No |
| **2** | Schema + migration, `prisma-store.ts`, buffered writer, `POST /api/public/track`, tenancy package (org stamp, RLS policy, gate entry, harness assertion), `analytics-prune` worker job | No, but data starts flowing |
| **3** | Client beacon, mounted on public layouts only, allow-listed. Conversion events fired on the register and checkout paths. | No |
| **4** | Traffic section on the event Analytics page + the register funnel joined to `Registration` | **Yes** |
| **5** | Docs: `SECURITY_AND_PRIVACY_POSTURE.md` §6 rewrite + hash appendix, `src/analytics/README.md`, CLAUDE.md entry, DOMAIN_MAP entry | No |

Phases 1 to 3 ship dark. That is intentional: by the time the dashboard lands in
Phase 4 there is already real data in it, so the first thing anyone sees is
populated rather than empty.

---

## 9. Test plan

The load-bearing tests, in rough order of how much they matter:

| Test | Why it matters |
|---|---|
| **Salt rotation**, mutation-verified | Freeze the salt and this test must fail. It is the entire compliance argument. |
| Same visitor, same day, same hash; **next day, different hash** | The property in both directions. |
| Different `siteId`, different hash for the same person | Tenant separation of the identifier. |
| Path allow-list: a token route is **never** measurable | Assert the negative, because that is the leak. |
| Query stripping: `?name=` and `?token=` never reach storage | Same reason. |
| **No column named `ipAddress` exists** in the model | A source-level guard, following the `session-config` precedent. |
| Buffered writer: flush on count, flush on timer, no loss within a flush window | The pool-safety mechanism. |
| Endpoint returns 204 and never throws on malformed input | A failing beacon must never affect a page. |
| Tenancy harness: cross-tenant read returns nothing, fail-closed with no store | Standard for every swept domain. |
| Prune respects the 400-day cutoff and reports if capped | Matches `login-event-prune`. |

---

## 10. Blast radius

**Additive only.** One new table, one new public endpoint, one new client
component mounted on public layouts, one new worker job. No existing model
changes, no existing route changes except mounting the beacon and firing
conversion events.

**The realistic failure modes**, and what bounds each:

| Risk | Bound |
|---|---|
| Beacon slows a public page | Fire-and-forget, `navigator.sendBeacon` where available, no render blocking |
| Traffic burst exhausts the DB pool | Buffered writes (§4.5). This is the P2024 lesson applied. |
| A future public route leaks into analytics | Allow-list, not exclude-list (§4.4) |
| Someone adds an IP column "just for debugging" | The column does not exist and a test asserts it |
| Salt rotation silently breaks | Mutation-verified test |
| Bot traffic inflates the numbers | Filtered, imperfectly; documented as a treadmill |

---

## 11. Open questions for the owner

1. **Retention: 400 days confirmed?** Longer gives multi-year trends, shorter is
   a cleaner questionnaire answer. 400 covers one full year-over-year cycle.
2. **Should the org-level cross-event view be in v1 after all?** Currently
   deferred. If the real question is *"how is MM Group's traffic doing overall"*
   rather than per-event, that reverses.
3. **Country in v1 or Phase 2?** Phase 2 as planned, unless knowing which
   countries look at a conference is worth the MaxMind refresh job now.
4. **Who sees the Traffic section?** Proposed: same audience as the existing
   event Analytics page. Confirm whether MEMBER should see traffic given it is
   not financial data.
