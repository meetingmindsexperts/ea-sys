# MCP / external-agent security posture

> **The question this answers:** "Can an external AI agent talk to our system, and are we protected?"
>
> Short version: **yes it can, deliberately**, and the front door is locked. `/api/mcp` exists so
> Claude, n8n and any spec-compliant MCP client can drive EA-SYS. This document records what gates
> each door, what an audit on **2026-08-12** found, what was changed, and what is still an owner
> action.
>
> Companion docs: [MCP_REFERENCE.md](MCP_REFERENCE.md) is the tool catalogue and connection guide.
> [AWS_OPERATIONS.md §4](AWS_OPERATIONS.md) is the network-layer posture (nginx rate limiting,
> fail2ban, no CDN). This file is the **application-layer** answer.

---

## 1. The doors

| Door | Who may call it | Gate |
|---|---|---|
| `POST /api/mcp` | Anyone holding a credential | API key (`mmg_…`, SHA-256 hashed at rest) **or** OAuth Bearer. 100/hr per credential, INTERNAL tier exempt but logged. |
| `POST /api/mcp/oauth/register` | **Anyone, unauthenticated** | Nothing. This is RFC 7591 Dynamic Client Registration and is supposed to be open. 10/hr per IP. **Registering grants nothing.** |
| `GET /mcp-authorize` | A signed-in ADMIN / SUPER_ADMIN / ORGANIZER | NextAuth session + role check. This screen is the real gate. |
| `POST /api/mcp/oauth/authorize/decision` | Same, from our own page | Session + role + same-origin. Mints the authorization code. |
| `POST /api/mcp/oauth/token` | The registered client | PKCE S256 (mandatory), one-time code, 60/hr per client_id. |
| REST (`/api/events`, `/api/contacts`, `/api/registration-types`, …) | API key holders | `getOrgContext` + the route's own role predicate. |

**The load-bearing sentence:** registration is open, but a `client_id` on its own is worth nothing.
Every path to data runs through one admin approving one screen. That is why the screen matters more
than the endpoints around it.

---

## 2. What the audit confirmed was sound

Verified by reading the code and probing production read-only on 2026-08-12:

- Unauthenticated `POST /api/mcp` returns **401** with the RFC 6750 `WWW-Authenticate` challenge.
  A forged `mmg_` key returns **401**. Unauthenticated `/api/events`, `/api/contacts` and a nested
  registrations route all return **401**.
- **PKCE is S256-only** (plain is refused outright) and the verifier compare is timing-safe.
- Authorization codes are **deleted in the same transaction that mints the token**, so a code cannot
  be replayed, and they carry a 10-minute TTL.
- Access and refresh tokens are stored **SHA-256 hashed**; the raw value is never persisted and only
  a 10 to 12 character prefix is ever logged.
- The granting user's role is **re-resolved on every request**, not read from the grant. A demotion
  takes effect on the next call, and a deleted user resolves to null, which fails closed.
- An OAuth token whose granting user has since moved organizations is **refused** with a logged
  `mcp:oauth-grantee-org-mismatch`.
- `redirect_uri` is re-validated against the client's registered list on **both** the consent page
  and the decision endpoint, so there is no open redirect.

---

## 3. What the audit found, and what changed

### 3.1 The consent screen showed the forgeable field and hid the identifying one (fixed)

**The finding.** `/mcp-authorize` rendered `client_name`, which is free text typed by whoever
registered the client, and **never rendered `redirect_uri`**, which is where the authorization code
is actually delivered. Because registration is unauthenticated by RFC design, anyone could register
a client named `EA-SYS Official Sync` pointing at their own callback, send an admin the authorize
URL, and the screen would be visually indistinguishable from the real Claude integration. Approving
it hands over the org's entire MCP tool set for 30 days.

This is the canonical OAuth consent-phishing shape. The 2017 "Google Docs" worm was an application
literally named *Google Docs* requesting Gmail scope, and it spread because the consent screen showed
the name rather than the developer.

**The rule to keep:** on a consent screen, display the field the requester **cannot forge**, not the
one they typed.

**The fix.**
- New [`src/lib/mcp-client-trust.ts`](../src/lib/mcp-client-trust.ts) `describeRedirectTarget()`
  parses the registered `redirect_uri` and reports its origin, whether the host is one we ship an
  integration for, and whether it is plain http on a non-loopback host.
- The consent screen now leads with **"Access will be sent to `https://…`"** as the most prominent
  block on the page, with the client name demoted to a claim ("a client calling itself …").
- An unrecognised destination renders a red panel naming the consequence, and the **safe action
  becomes the primary button**: Deny is the filled button, Approve becomes a red outline reading
  "Approve anyway, I recognise `evil.example`". A screen that makes Approve the inviting default
  regardless of who is asking is doing the attacker's layout work.
- Unrecognised is **advisory, never a block**. A self-hosted client (n8n, a customer's own agent) is
  a legitimate use case and the admin is the one who knows. It changes what the screen says, not what
  it allows.
- Both showing the screen and approving are logged with the destination host. An approval to an
  unrecognised host logs at **warn**, so it surfaces in `/logs` without anyone going looking.

**Why the allow-list is its own list and not the CORS one.** `mcp-cors.ts` holds the same hostnames
today, but it answers "may this browser origin call our API", while this answers "should a human be
reassured about this destination". Sharing the list would mean adding an origin for a future CORS
reason silently marks it trusted on the consent screen. Same reasoning as the finance, barcode and
contact visibility predicates deliberately disagreeing: reaching for a close-enough predicate is the
signal to write a new one.

### 3.2 CSRF on the grant endpoint was inherited, not written (fixed)

**The finding.** `/api/mcp/oauth/authorize/decision` is a cookie-authenticated, state-changing POST
that mints a credential, and [`src/proxy.ts`](../src/proxy.ts) **explicitly skips its Origin/Host
check for the whole `/api/mcp` prefix** so browser-based MCP clients are not blocked by the
mobile-only CORS allow-list. That exclusion is correct for the transport endpoint, which
authenticates by Bearer token and is therefore not CSRF-able. It was wrong for this route.

The route was safe, but only because Auth.js defaults the session cookie to `SameSite=Lax`, which
browsers do not attach to a cross-site POST. That is a real protection. It is also one
`sameSite: "none"` away from vanishing (to embed the dashboard, to support a webview), and nothing in
the repo would have failed.

**The rule to keep:** a guarantee you did not write is a guarantee you cannot test.

**The fix.** New `isSameOriginRequest()` in [`src/lib/security.ts`](../src/lib/security.ts) checks
`Origin` against `Host`, falls back to `Referer`, treats an opaque `Origin: null` as a refusal rather
than falling through to a `Referer` the same attacker controls, and refuses when neither header is
present (the same posture the proxy takes for an origin-less mutation with no API key). The decision
route runs it **before the session is read**, so a forged request cannot depend on who happens to be
logged in.

### 3.3 Standing credentials (owner action, not fixed in code)

Read-only from production on 2026-08-12:

- **4 active API keys, none with an expiry set** (`expiresAt` is null on all four).
- `Internal` is **INTERNAL tier**, which bypasses the 100/hr ceiling entirely, and has **never been
  used** (`lastUsedAt` null).
- `N8N Automation` has also never been used.
- `n8ntest` was last used 2026-07-09.
- **7 `McpOAuthClient` rows**, all legitimately Claude pointing at `https://claude.ai/api/mcp/auth_callback`,
  accumulated from reconnecting the integration over time. Only **1 live token** exists.

See §5 for the runbook.

### 3.4 Smaller notes (accepted, not fixed)

- `verifyPkce` calls `timingSafeEqual` without a length guard, so a stored challenge of unusual
  length throws rather than returning false. It is caught by the token route's try/catch and **fails
  closed** (a throw is not a pass), so it is a 500 rather than a bypass.
- The rate limiter is **in-memory per container**. Blue/green means roughly double the nominal
  ceiling while both are up, and a redeploy resets every window. Migrating to a shared store is
  tracked with the other rate-limit work.
- The OAuth cleanup worker prunes expired **codes and tokens**, never **clients**, so DCR
  registrations are immortal. Low risk (a `client_id` grants nothing without an approval) but it is
  unbounded growth and it makes the client list harder to read.

---

## 4. Design rules to preserve

1. **Show the unforgeable field on any consent screen.** Destination over display name, every time.
2. **Never let the safe action be the less inviting button** when the request looks unusual.
3. **Cookie-authenticated state changes need an explicit same-origin check**, even under a prefix the
   proxy skips. Do not rely on `SameSite`.
4. **Unrecognised is a warning, not a block.** Blocking self-hosted clients would push people to
   disable the check entirely, which is worse than a warning they read.
5. **Log the destination, not just the client id.** After an incident the question is "where did it
   go", and a client id alone cannot answer it once the row is gone.
6. **Keep the trust list separate from the CORS list.** They coincide today and answer different
   questions.

---

## 5. Operator runbook

### Who currently has access?

```bash
# Read-only production session. Writes error.
npm run prod:psql -- -c '
  SELECT name, prefix, "rateLimitTier", "expiresAt"::date, "lastUsedAt"::date
  FROM "ApiKey" WHERE "isActive" ORDER BY "createdAt";'

npm run prod:psql -- -c '
  SELECT "clientName", "redirectUris", "createdAt"::date
  FROM "McpOAuthClient" ORDER BY "createdAt";'

# Live grants (unrevoked, unexpired):
npm run prod:psql -- -c '
  SELECT t."createdAt"::date, t."lastUsedAt"::date, c."clientName", u.email
  FROM "McpOAuthAccessToken" t
  JOIN "McpOAuthClient" c ON c.id = t."clientId"
  JOIN "User" u ON u.id = t."userId"
  WHERE t."revokedAt" IS NULL AND t."expiresAt" > now();'
```

**What to look for:** any `redirectUris` entry that is not `claude.ai` or `anthropic.com`, any
INTERNAL-tier key you cannot account for, and any key with a `lastUsedAt` older than the integration
it was minted for.

### Revoking

- **API key:** Settings → API Keys → deactivate. Takes effect on the next request (`validateApiKey`
  checks `isActive` on every call).
- **OAuth grant:** Settings → API Keys → OAuth clients, or the client's own disconnect flow.
  `validateOAuthAccessToken` honours `revokedAt` immediately.
- **Suspected phishing:** revoke the token first, then look for
  `mcp-oauth:authorize-approved-unrecognized-destination` in `/logs` to find which admin approved
  what, and when.

### Log lines worth knowing

| Line | Level | Meaning |
|---|---|---|
| `mcp-oauth:client-registered` | info | Someone registered a DCR client. Open by design, expect noise. |
| `mcp-oauth:consent-shown` | info | An admin was shown the approve screen, with the destination host. |
| `mcp-oauth:authorize-approved` | info | A grant to a recognised destination. |
| `mcp-oauth:authorize-approved-unrecognized-destination` | **warn** | A grant to somewhere we do not ship an integration for. Investigate unless you know it. |
| `mcp-oauth:decision-cross-origin-refused` | **warn** | A CSRF-shaped POST at the grant endpoint. |
| `mcp-oauth:redirect-uri-mismatch` | warn | A client tried a callback it never registered. |
| `mcp:oauth-grantee-org-mismatch` | warn | A token whose user has changed organizations. |
| `mcp:internal-key-used` | info | Rate-limit-exempt key in use. |

---

## 6. Outstanding

| Item | Owner | Note |
|---|---|---|
| Revoke or justify the unused INTERNAL key | Owner | Rate-limit-exempt, never used. |
| Retire `n8ntest` | Owner | Last used 2026-07-09. |
| Set expiries on the API keys that need to persist | Owner | All four are currently non-expiring. |
| Prune orphan `McpOAuthClient` rows | Dev | Cleanup worker touches codes and tokens only. |
| Shared-store rate limiter | Dev | In-memory per container; blue/green doubles the ceiling. |
| Length guard in `verifyPkce` | Dev | Fails closed today; a 500 rather than a clean `invalid_grant`. |

---

*Audit and fixes: 2026-08-12. Re-run §5 quarterly, and after any change to `src/proxy.ts`'s
`/api/mcp` pass-through or to the Auth.js cookie configuration.*
