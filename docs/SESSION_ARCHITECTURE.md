# Sessions: stateless JWT vs stateful database vs Redis

Why "who is logged in right now?" was a hard question in this codebase, what the
three options actually cost, and what EA-SYS does today.

Written July 28, 2026, when adding sign-in tracking surfaced the fact that the
system had no way to answer that question. Companion to
[LOGIN_ACTIVITY.md](LOGIN_ACTIVITY.md).

---

## 1. The one idea underneath all three

When you sign in, the server has to remember it — otherwise the next request is
just an anonymous stranger again. There are only two places that memory can live:

- **In the token the browser holds.** The server writes down nothing.
- **On the server.** The browser holds only a pointer to it.

Everything below is a consequence of that one choice. "Redis sessions" is not a
third kind of thing — it is server-side sessions with the storage swapped.

---

## 2. Stateless JWT — what EA-SYS uses today

`SESSION_CONFIG` in `src/lib/auth.config.ts`:
`{ strategy: "jwt", maxAge: 48 * 60 * 60 }`.

**48h rolling idle**, chosen Aug 17 2026: 24h re-prompts staff who use this
daily, a week is too long for accounts that move money given we cannot force a
sign-out (only `User.tokenVersion` revokes). It deliberately does **not** carry
a weekend — Friday evening to Monday morning is ~63h, so Monday is a fresh
login.

**Why it lives in `auth.config.ts` and not `auth.ts`.** There are TWO NextAuth
instances over one cookie: the Node one in `auth.ts` (the app, `/api/auth/session`)
and an Edge one in `proxy.ts` — `NextAuth(authConfig)` — for middleware RBAC.
Both re-issue the cookie, so whichever writes last sets the lifetime.

Until **Aug 17 2026** only `auth.ts` declared `maxAge`. `auth.config.ts` was
silent, and a silent config does not inherit its sibling — it opts into
NextAuth's **default of 30 days**. Middleware runs on every dashboard route, so
it re-stamped the cookie at 30 days and **the 24h idle timeout this document
described was never actually in force**: an account whose last sign-in was Aug 7
was still authenticated on Aug 17, across two weekends and a shut-down laptop.
(Found by asking why a session survived a weekend with the laptop shut down —
the answer was in `LoginEvent` vs `User.lastSeenAt`, ten days apart.)
It is one exported constant consumed by both instances now, so the two cannot
hold different numbers; `__tests__/lib/session-config.test.ts` pins that nobody
re-inlines one.

**How it works.** On a correct password the server builds a small JSON payload —
user id, role, organization id, name — and **signs** it with `NEXTAUTH_SECRET`.
That signed blob is the cookie. On every later request the server verifies the
signature, and if it verifies, believes the contents.

The critical part: **the server stores nothing.** There is no row that says
"Krishna is logged in". The proof of login is the cookie itself, in the browser.

Think of it as a **festival wristband**. The gate checks the hologram and lets
you in. Nobody keeps a list of who is inside. That is why it scales beautifully
and why nobody can tell you how many people are in the field.

**What this buys**

- Zero database reads to authenticate. Any container can verify any request with
  only the secret — no shared state, no coordination.
- Survives a database outage: people already signed in keep working.
- Trivially horizontally scalable — blue-green deploys, a second container, a
  DR box in another region all "just work".

**What it costs**

- **You cannot enumerate sessions.** Nothing to list.
- **You cannot revoke one.** No "sign out this device", no "sign out
  everywhere" — the wristband is already on the wrist. Delete a user's account
  and their cookie keeps working until it expires.
- **Changes go stale.** Demote someone from ADMIN and their token still says
  ADMIN. EA-SYS patches this specific hole with a **periodic role
  re-validation** in the JWT callback: every 5 minutes it re-reads `role` from
  the database and overwrites the token's copy, so a role change takes effect
  within 5 minutes rather than 24 hours. That is a targeted fix for the one
  field that matters, not a general solution.
- **Bigger cookie.** Every claim added ships on every request.

**A note on this codebase specifically:** `AuthSession` exists in
`prisma/schema.prisma` — the Prisma adapter defines it — and is **completely
unused**. Nothing reads or writes it under `strategy: "jwt"`. It is easy to see
that table and wrongly conclude sessions are tracked.

---

## 3. Stateful database sessions

**How it works.** On sign-in the server writes a row — `sessionToken`, `userId`,
`expires` — and the cookie holds only the opaque token. Every request looks that
token up.

The **hotel key card**. The card itself means nothing; reception has a list. That
list is why they can tell you who is in the building and deactivate a card
instantly.

**What this buys**

- **A real session list**: who is signed in, on how many devices, since when.
- **Instant revocation**: delete the row and the next request is unauthenticated.
  "Sign out everywhere", "log this device out", forced sign-out on password
  change — all become a `DELETE`.
- **No staleness**: role and permissions are read fresh every request.

**What it costs**

- **A database read on every authenticated request.** That is the whole trade.
  For EA-SYS that means the shared Supabase pooler on every dashboard
  navigation, every API call, every poll.
- **The database becomes a hard dependency for reading, not just writing.** A
  pooler blip currently degrades some features; under database sessions it logs
  everybody out.
- **Cutover signs everyone out**, because existing JWT cookies name no row.
- **Write amplification**: sessions are written, refreshed and expired
  constantly, so a hot table needing its own vacuum and pruning attention.

---

## 4. Redis-backed sessions

**Same model as §3 — the lookup just doesn't hit Postgres.**

Session records live in Redis (Upstash, Vercel KV, ElastiCache): an in-memory
key-value store with native TTL, so expiry is free — set the key to live 24
hours and it deletes itself.

The hotel again, but reception's list is a **whiteboard behind the desk instead
of a filing cabinet in the basement**. Same list, same abilities, far faster
lookup — and if the building burns down you lose the whiteboard, which is fine,
because it only held today's guests.

**What this buys over database sessions**

- Sub-millisecond lookups instead of a pooled Postgres round-trip.
- TTL expiry built in — no prune job.
- Keeps session churn off the primary database entirely.

**What it costs**

- **A new piece of infrastructure to run, pay for and monitor.** Today EA-SYS has
  exactly one datastore. This adds a second, with its own failure mode: if Redis
  is down and sessions live only there, nobody can log in.
- **Durability is weaker by design.** A Redis restart without persistence signs
  everyone out. Usually acceptable for sessions, occasionally surprising.
- Same cutover cost as §3.

**Worth knowing:** EA-SYS already has a *place* Redis would slot in — the
in-memory rate limiters (`checkRateLimit`, `login-throttle`) carry a documented
"migrate to Redis for stricter SLAs" note, because per-container counters reset
on deploy. If Redis ever arrives, it likely arrives for rate limiting first, and
sessions become an easier follow-on.

---

## 5. Side by side

| | Stateless JWT *(current)* | Database sessions | Redis sessions |
|---|---|---|---|
| Server stores a session record | No | Yes (Postgres) | Yes (Redis) |
| DB/store read per request | **None** | 1 Postgres read | 1 Redis read |
| List who is signed in | ❌ | ✅ | ✅ |
| Revoke one device | ❌ | ✅ | ✅ |
| "Sign out everywhere" | ❌ | ✅ | ✅ |
| Role change takes effect | ≤5 min *(re-validation)* | Instant | Instant |
| Survives datastore outage | ✅ | ❌ | ❌ |
| Extra infrastructure | None | None | **Redis** |
| Cutover signs everyone out | — | Yes | Yes |

---

## 6. What EA-SYS actually does, and why

**Stateless JWT, with two targeted patches rather than a model change:**

1. **Periodic role re-validation** (§2) closes the staleness hole for the field
   that matters — `role` — at a cost of one indexed read per user per 5 minutes.
2. **`User.lastSeenAt`** (July 28, 2026) answers "who is logged in right now"
   *well enough*, by recording activity instead of sessions. The stamp
   piggybacks on the same 5-minute block, so an active person costs one extra
   write per 5 minutes. See [src/lib/active-users.ts](../src/lib/active-users.ts).

**Why not switch to database sessions when we wanted a presence list?** Because
the actual question was *"who is using this right now"*, and last-seen answers
that for a nullable column and one write per user per 5 minutes — versus adding
a Postgres read to **every authenticated request on a live production system**,
signing everyone out at cutover, and making the pooler a hard dependency for
reading. That is a large, risky change to buy a feature a scalar already
delivers.

**Be precise about what last-seen is not.** It shows who has been *active*, not
who holds a valid cookie. Someone who closed their laptop is still signed in for
up to 48 hours and will not appear online — which is usually what an operator
actually means by the question, but is not the same statement.

### The limitation that remained, and was closed on 2026-08-11

There used to be **no way to sign anyone out**. Deleting an account did not do
it: the JWT callback's re-validation read the row, and the only thing it acted
on was a role change.

```ts
if (dbUser) { token.role = dbUser.role; }   // no else
```

A deleted user produced `dbUser === null`, the `if` did nothing, and the request
continued **with the cached role**. A deleted ADMIN stayed an ADMIN. And because
the window is a ROLLING idle timeout, an actively-used session never expired at
all, so "up to a day" was the optimistic reading rather than a bound. (Worse
than anyone realised at the time: the Edge config's silent 30-day default meant
the real bound was a month — see §2.)

Closed by shipping §7 (`tokenVersion`) together with the missing `else`. The
decision now lives in a pure `decideSessionValidity` so the truth table is unit
testable without standing up NextAuth, and the callback is a thin caller.

Three properties worth keeping in mind:

1. **A deleted user is not the same as a database error.** The `catch` around
   the re-read deliberately keeps the cached role, because a pooler blip must
   not sign the company out. A confirmed `null` is an answer; a thrown error is
   the absence of one, and they get opposite treatment.
2. **An ordinary role change does not sign anyone out.** The same cycle rewrites
   the role in place, and bumping the counter would not make it any faster
   (both are bounded by the same 5-minute check). Promoting a colleague should
   not eject them.
3. **Latency is up to 5 minutes**, the re-validation interval, not instant.

**Still open: the mobile token path.** [mobile-jwt.ts](../src/lib/mobile-jwt.ts)
is a separate token system, not NextAuth, with a 24h access token and a **30-day
refresh token**. `mobile-refresh` does re-read the user, so a *deleted* account
is refused there, but it does not check `tokenVersion`, so an explicit
revocation (password reset) does not reach a mobile session. Entirely
theoretical today: prod has **0 device tokens and 0 mobile logins, ever**. The
fix is the same three lines in `mobile-refresh` plus the claim in the payload.

---

## 7. Revocation: the middle path (SHIPPED 2026-08-11)

The cheapest fix that gets "sign out everywhere" **without** changing the
session model:

Add `User.tokenVersion Int @default(0)`. Stamp the current value into the JWT at
sign-in. In the JWT callback's existing 5-minute re-validation block — which
already re-reads the user — compare the token's copy against the row's. If they
differ, reject the token.

"Sign out everywhere" then becomes `tokenVersion++`, and password change bumps
it automatically.

**Cost:** one integer column and a few lines in a block that already runs.
**Limitation:** revocation takes effect within the re-validation interval (≤5
min), not instantly, because that is how often the token is checked. Shorten the
interval to trade reads for immediacy.

For the actual threat — a compromised account discovered by a human — five
minutes is not the weak link. Full database sessions buy instant revocation, and
that difference is rarely worth the cost above.

---

## 7a. Deactivating an internal user (2026-08-11)

`User.deactivatedAt`, a nullable timestamp. Null means active.

**A flag, not a `DEACTIVATED` role value.** A role answers "what may you do";
this answers "may you be here at all". Collapsing the two axes causes three
problems, and all three are avoided by keeping them separate:

1. It **overwrites the real role**, so reactivating means guessing what they
   were.
2. It must be handled in **every** role predicate (`canViewFinance`,
   `denyReviewer`, `isTeamRole`, `buildEventAccessWhere`, `canViewContacts`,
   the CRM set). One missed predicate leaves that capability intact, so the
   failure mode is fail-OPEN.
3. It breaks every exhaustive `Record<UserRole, ...>`.

As a flag it is checked in exactly one place, `decideSessionValidity`, **before
the role is read at all**, so no path exists on which a deactivated user's role
is consulted. A test pins that ordering.

Deactivating also **preserves ownership on purpose**: CRM deals, sent-email
attribution, audit rows, group coordinator and document uploader all keep
pointing at them until someone reassigns. Deleting would `SetNull` most of
those and silently orphan the work, which is the second reason to prefer
deactivation over deletion for a leaver.

### Instant for staff, 5 minutes for everyone else

The re-validation normally runs on a 5-minute clock. Deactivation is expected to
be instant, and instant means a database read per request, which is the
stateless trade-off arriving again.

The split: **internal staff are re-validated on every request; everyone else
keeps the periodic cycle.** `isTeamRole(token.role)` reads the token, so
choosing costs nothing.

That works because the two populations are nothing alike. Staff are tens of
people, so a primary-key lookup of three small columns per request is noise.
Registrants and attendees are thousands (the webinar presence heartbeat alone is
~140 req/s at 5,000 attendees), and they are not a population anyone
"deactivates". **Applying one auth policy to both is what would have made this
expensive.**

Two details that are easy to get wrong:

- `lastSeenAt` stays on the 5-minute clock even for staff. It is what drives
  "who is online now", and one write per user per 5 min is the entire reason it
  was cheap enough to live on the `User` row.
- `roleCheckedAt` is only moved by the periodic pass. If a staff per-request
  check refreshed it, `dueForPeriodicCheck` would never come true for staff and
  they would silently stop being stamped as online.

If the pool ever objects, the lever is a short in-process cache on that lookup
(the `lobby-status` 3s micro-cache pattern), **not** reverting to the periodic
check.

Sign-in is blocked too, checked **after** the password so the response cannot be
used to probe which addresses are deactivated. Recorded as its own
`BLOCKED_DEACTIVATED` outcome rather than `FAILED_PASSWORD`, because an admin
reading a run of failures needs to tell "we switched them off" apart from
"someone is guessing passwords".

---

## 7b. Counting the compensations

Worth recording, because no single change here was wrong and the accumulation
still is. Three columns exist to compensate for **one** design decision:

| Column | Exists because |
|---|---|
| `roleCheckedAt` | The token carries a stale role |
| `lastSeenAt` | There is no session table to enumerate |
| `tokenVersion` | There is no session row to delete |

Each adds a database touch to the auth path, which is the cost stateless
sessions exist to avoid. If you already re-read the row every 5 minutes, you
have paid most of the price of database sessions while collecting none of their
benefits.

A useful heuristic, and it generalises well past auth: **count the
compensations for a single design decision. One is normal. Two is a trade-off
you accepted. Three means re-examine. Four means you are paying for both
designs.**

Three is why this section exists. The call was to finish the third properly
rather than migrate, for the sequencing reason in the decision record. **If a
fourth appears, that is the signal.**

Framed correctly, the current design is not "stateless JWT" at all. It is a
**hybrid**: a short re-validation cycle against the source of truth, with cheap
requests in between. That is the same shape as the industry's short-lived
access token plus stateful refresh check, arrived at without naming it. §7 was
the missing half.

---

## 8. Decision record

| Date | Decision | Rationale |
|---|---|---|
| (original) | Stateless JWT, 24h rolling | No per-request DB read; trivially horizontally scalable |
| 2026-08-17 | 48h rolling, declared ONCE in `auth.config.ts` and shared | The 24h was never in force — the Edge instance's silent config defaulted to 30 days. One constant for both instances so they cannot disagree; 48h balances daily staff use against an account that moves money and cannot be force-signed-out |
| (original) | 5-min periodic role re-validation | Closes the one staleness hole that matters without abandoning stateless |
| 2026-07-28 | `User.lastSeenAt` over database sessions for presence | Answers "who is active now" for a nullable column + one write per user per 5 min, vs a DB read on every request and signing everyone out at cutover |
| 2026-07-28 | **Open:** no session revocation | Recorded as a real gap. Preferred fix is `tokenVersion` (§7), not a model change |
| 2026-08-11 | Shipped `tokenVersion` + the missing `else` | Closed the gap above. Rides the query the 5-min block already runs, so marginal cost is one column in an existing `select`. Additive migration, and a missing claim reads as 0, so the deploy signs nobody out |
| 2026-08-11 | `deactivatedAt` as a flag, not a `DEACTIVATED` role | A role would overwrite the real one, would have to be handled in ~10 predicates where a miss fails OPEN, and would break every exhaustive role map. As a flag it is one check, ahead of role, and cannot fail open |
| 2026-08-11 | Deactivation is per-request for staff, periodic for everyone else | Instant where it is expected, free where the volume is. One policy for both populations is what would have made it expensive |
| 2026-08-11 | **Stay hybrid; do not migrate to database sessions yet** | On a clean build I would pick stateful for a monolith with one database: it deletes `roleCheckedAt`, `lastSeenAt` and `tokenVersion` outright. Deferred on SEQUENCING, not merit: PLATFORM_DECISIONS item 6 (identity model, "email unique per tenant") reopens auth anyway, and migrating first means doing it twice, the second time under a constraint not yet chosen. **Revisit trigger: when the identity decision lands.** |

## 9. See also

- [LOGIN_ACTIVITY.md](LOGIN_ACTIVITY.md) — sign-in attempt history; §7 lists what
  is deliberately not built, including the session list
- [src/lib/auth.ts](../src/lib/auth.ts) — strategy, role re-validation, presence stamp
- [src/lib/active-users.ts](../src/lib/active-users.ts) — the presence model
- `docs/HANDOVER.md` §4 "Session lifetime" — the 24h rolling window explained
