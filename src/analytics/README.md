# Analytics module

Counts visits to public event pages. Answers the one question the rest of
EA-SYS cannot: **how many people looked and did not register.**

Design record and the reasoning behind every decision here:
[docs/ANALYTICS_PLAN.md](../../docs/ANALYTICS_PLAN.md). The client-facing
description, including the appendix a reviewer can check, is §6 of
[docs/SECURITY_AND_PRIVACY_POSTURE.md](../../docs/SECURITY_AND_PRIVACY_POSTURE.md).

---

## The five invariants

Break any of these and the feature stops being defensible. They are not style
preferences and each is pinned by a test.

**1. `core/` imports nothing from EA-SYS.** Not `@/lib/db`, not the logger, not
`next/server`. Node built-ins are fine. Enforced by an eslint zone. The adapter
lives in `store/` and may import anything; if `core/` seems to need something
from the app, pass it in as a parameter.

**2. The salt rotates by construction, not on a schedule.** The visitor
identifier is an HMAC under a salt derived from the UTC date, so tomorrow's is
unavoidably different from today's. There is no cron that could stop and no
state that could stick. This is the entire privacy argument; freezing the salt
fails four tests.

**3. Nothing is stored on the visitor's device.** No cookie, no localStorage, no
sessionStorage. Sessions are *derived* from the visitor hash and a 30-minute
window. That produces a small artifact at window boundaries, which is accepted
and documented, and must NOT be "fixed" by adding client storage.

**4. Measurable paths are an ALLOW-list.** An exclude-list fails open: add a
public route in six months and it is measured by default. Eight EA-SYS public
routes carry bearer tokens or a person's name in their URL. The browser checks
before sending and the server checks again on receipt.

**5. There is no `ipAddress` column, and there must never be one.** The address
is consumed at the request boundary to derive the hash and discarded. A column
that does not exist cannot be filled in by a well-meaning change.

---

## Layout

```
core/            ZERO imports from EA-SYS. Could be lifted out as a package.
  types.ts         AnalyticsHit, the writer/reader contracts
  visitor-hash.ts  rotating-salt identity          (SERVER ONLY: node:crypto)
  path-policy.ts   allow-list, query stripping, referrer host
  bots.ts          bot + link-preview detection
  user-agent.ts    coarse device / browser / OS
  beacon.ts        the browser half
  funnel.ts        funnel arithmetic
  aggregate.ts     dashboard rollups
store/           The adapter. Knows Prisma, tenancy, Registration.
  prisma-store.ts  batched writer, one createMany per organisation
  site-resolver.ts slug -> { organizationId, eventId }, cached
  event-traffic.ts the dashboard read
react/
  page-analytics.tsx  mounted once on src/app/e/[slug]/layout.tsx
buffer.ts        in-memory batching, so pageviews never compete for the pool
```

`core/` has **no `index.ts` barrel**, deliberately. `visitor-hash.ts` imports
`node:crypto`; re-exporting it beside the client-safe modules would bundle
`node:crypto` into the browser build as `undefined`, which fails silently and
surfaces as a click that does nothing.

---

## Flow

```
browser  PageAnalytics -> core/beacon.track()      allow-list checked HERE first
            |                                       (nothing sent from a token route)
            v  POST /api/public/track
server   route: rate limit -> bot filter -> allow-list AGAIN -> resolve site
            |                                       IP + UA consumed and discarded
            v  enqueueHit()
         buffer: 25 hits or 2s
            v
         prisma-store: group by org -> runWithTenant -> createMany
```

The endpoint **always answers 204**. Not on success: always. A visitor is on a
registration page, and a beacon that errors is an error in their console.

---

## Adding something

**A new measurable page.** Add its pattern to `MEASURABLE_ROUTES` in
`core/path-policy.ts`. Nothing else. If it is not there it is invisible, which
is the intended default.

**A new conversion event.** Add the name to `EVENT_NAMES` in the track route,
then call `track(site, name, location, { value })`. The list is an allow-list
because the name is attacker-supplied and ends up grouped in a dashboard.

**A new figure on the dashboard.** Put the arithmetic in `core/aggregate.ts` as
a pure function over `AnalyticsHit[]` and test it there. Aggregation is
in-process over one slim query, following `src/lib/event-analytics.ts`. Do not
reach for `$queryRaw`: it sits outside the tenant lane in this codebase and
would fail closed to empty results under RLS on the platform instance.

---

## Operations

`ANALYTICS_SALT_SECRET` must be set or **nothing is recorded**. The route
refuses rather than falling back to a constant, and says so once per container.
Treat the value as permanent: changing it makes every returning visitor look new
from that day.

`analytics-prune` (worker, 03:15 UTC daily) deletes hits older than 400 days.
Longer than the 180-day sweeps because the valuable comparison is this September
against last September. Affordable only because these rows are not personal
data; if that ever changes, the number comes down with it.
