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

`src/lib/auth.ts`: `session: { strategy: "jwt", maxAge: 24 * 60 * 60 }`.

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
up to 24 hours and will not appear online — which is usually what an operator
actually means by the question, but is not the same statement.

### The honest limitation that remains

There is still **no way to sign someone out**. If an account is compromised
today, the options are: change the password (which does *not* invalidate the
existing token) or delete the account (whose cookie keeps working until it
expires — up to 24 hours).

That is a real security gap, and it is the strongest argument for revisiting
this. It does **not** require full database sessions to fix — see §7.

---

## 7. If we need revocation later: the middle path

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

## 8. Decision record

| Date | Decision | Rationale |
|---|---|---|
| (original) | Stateless JWT, 24h rolling | No per-request DB read; trivially horizontally scalable |
| (original) | 5-min periodic role re-validation | Closes the one staleness hole that matters without abandoning stateless |
| 2026-07-28 | `User.lastSeenAt` over database sessions for presence | Answers "who is active now" for a nullable column + one write per user per 5 min, vs a DB read on every request and signing everyone out at cutover |
| 2026-07-28 | **Open:** no session revocation | Recorded as a real gap. Preferred fix is `tokenVersion` (§7), not a model change |

## 9. See also

- [LOGIN_ACTIVITY.md](LOGIN_ACTIVITY.md) — sign-in attempt history; §7 lists what
  is deliberately not built, including the session list
- [src/lib/auth.ts](../src/lib/auth.ts) — strategy, role re-validation, presence stamp
- [src/lib/active-users.ts](../src/lib/active-users.ts) — the presence model
- `docs/HANDOVER.md` §4 "Session lifetime" — the 24h rolling window explained
