# EA-SYS MCP Server Reference

EA-SYS exposes event management capabilities via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Any MCP-compatible client (Claude Desktop, Cursor, Claude.ai web, n8n, custom agents) can connect and drive an end-to-end event lifecycle.

**Last updated:** April 22, 2026 — post services-refactor Phase 0. **65 tools** across 10 domains.

### April 22, 2026 — Semantic parity update

An audit of MCP write tools against their REST admin-create counterparts found silent drift where MCP skipped side effects that REST fires. The Phase 0 fix patched these in place (Phase 1 extracted accommodation into a proper service — see `src/services/README.md`). Impact for callers:

- **`create_registration`** now sends the confirmation email + quote PDF for paid tickets with outstanding payment (`paymentStatus ∈ {UNASSIGNED, UNPAID, PENDING}`). Before the fix, paying registrants created via MCP silently received no email. Defaults now match the dashboard: `UNASSIGNED` for paid tickets, `COMPLIMENTARY` for free. The atomic `soldCount` increment guard now runs inside the transaction — MCP-created registrations properly count against ticket sell-through and sold-out is enforced. `qrCode` is now generated, so MCP-created registrations are visible to the on-site check-in scanner. New optional inputs: `phone`, `city`, `country`, `paymentStatus` (backward compatible; existing required fields unchanged).
- **`create_speaker`** now syncs to the org-wide Contact store with the full payload (phone/city/country/photo/bio/registrationType) and fires the admin notification. Before the fix, MCP-created speakers didn't appear in the Contact store. New optional inputs: `phone`, `city`, `country`, `photo`, `registrationType`.
- **`create_registrations_bulk` / `create_speakers_bulk`** send one batched admin notification per bulk call (not per row). Bulk registrations now generate `qrCode` per row and atomically increment `soldCount`.
- **`create_accommodation`** is now service-backed — REST route and MCP tool both call `src/services/accommodation-service.ts`. Response shape unchanged for MCP callers; error codes now use a typed union (`MISSING_ASSIGNEE`, `INVALID_DATES`, `EVENT_NOT_FOUND`, `REGISTRATION_NOT_FOUND`, `SPEAKER_NOT_FOUND`, `REGISTRATION_HAS_ACCOMMODATION`, `SPEAKER_HAS_ACCOMMODATION`, `ROOM_NOT_FOUND`, `GUEST_COUNT_EXCEEDS_CAPACITY`, `NO_ROOMS_AVAILABLE`, `UNKNOWN`).

If your n8n flows / Claude prompts were working around the missing email send by firing a separate `send_bulk_email` after `create_registration`, you can now drop that step for paid registrations — the quote PDF arrives automatically.

---

## Connection Options

There are three ways to connect, matching the three MCP transports:

### 1. Claude.ai web — OAuth 2.1 (Custom Connector)

The browser-based client. Uses the MCP spec's OAuth flow — no manual API keys.

1. Open claude.ai → **Settings → Integrations → Add Custom Connector**
2. URL: `https://events.meetingmindsgroup.com/api/mcp`
3. Sign in to EA-SYS when the consent popup appears
4. Approve the requested access (requires ADMIN / SUPER_ADMIN / ORGANIZER role)

Claude.ai handles Dynamic Client Registration, PKCE S256, and token refresh automatically. See `docs/MCP_OAUTH.html` for architectural detail.

### 2. Claude Desktop — via `mcp-remote` + API key

Claude Desktop can't speak Streamable HTTP directly, so use the `mcp-remote` bridge package. Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "ea-sys": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "https://events.meetingmindsgroup.com/api/mcp",
        "--header",
        "x-api-key:mmg_your_api_key_here"
      ]
    }
  }
}
```

Config file location:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

After editing, fully quit and relaunch Claude Desktop (Cmd+Q / Alt+F4 — reloading the window isn't enough).

**Note**: the correct npm package is `mcp-remote` (unscoped). `@anthropic-ai/mcp-remote` does not exist.

### 3. Direct HTTP — for n8n, Python SDK, Cursor, custom clients

Any MCP client that speaks Streamable HTTP directly:

```
POST https://events.meetingmindsgroup.com/api/mcp
Headers:
  Content-Type: application/json
  Accept: application/json, text/event-stream
  x-api-key: mmg_your_api_key_here
Body:
  {"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"my-client","version":"1.0.0"}},"id":1}
```

Response includes `Mcp-Session-Id` header — echo it back on subsequent requests for stateful sessions (30-min TTL).

## Authentication

Two authentication methods are supported on `/api/mcp`, checked in order:

1. **API key** (`x-api-key: mmg_...` or `Authorization: Bearer mmg_...`) — for Claude Desktop, n8n, scripts. Managed in EA-SYS at **Settings → API Keys**. Format `mmg_` + 64 hex. Optional expiry. Scoped to one organization.
2. **OAuth Bearer token** (`Authorization: Bearer mcp_at_...`) — minted by the OAuth flow for claude.ai web. 30-day TTL, refreshable.

Both return the same `{ organizationId }` context, so downstream tools don't care which method authenticated the request. Tools are automatically scoped to the authenticated org.

## Tools (70 total)

### Organization-level (3)

| Tool | Description |
|---|---|
| `list_events` | All events with status, dates, registration/speaker/session counts |
| `create_event` | Create a new event — slug auto-generated, WEBINAR type auto-provisions Zoom |
| `list_contacts` | Search org-wide contact store by name, email, or tag |
| `create_contact` | Add a contact to the org store |

### Event info + dashboards (4)

| Tool | Description |
|---|---|
| `get_event_info` | Event details: name, dates, venue, status, counts |
| `get_event_stats` | Basic dashboard: registration/payment/speaker/abstract status counts |
| `get_event_dashboard` | Rich aggregate: counts + upcoming sessions + live now + recent registrations + agreement signed/unsigned. **Replaces 5-call sequences.** |
| `search_event` | Cross-domain substring search across registrations, speakers, abstracts, contacts |

### Registrations & tickets (8)

| Tool | Description |
|---|---|
| `list_registrations` | Filter by status, paymentStatus, ticketTypeId |
| `create_registration` | Register an attendee; returns `existingRegistrationId` on duplicate |
| `update_registration` | Status, paymentStatus, ticketTypeId, attendee details (auto-adjusts `soldCount`) |
| `bulk_update_registration_status` | Update status + paymentStatus on up to 200 registrations in one transaction |
| `check_in_registration` | Mark registration as CHECKED_IN |
| `list_unpaid_registrations` | `paymentStatus IN (UNPAID, PENDING, FAILED)`, optional `daysPending` cutoff |
| `list_ticket_types` | Registration types with pricing |
| `create_ticket_type` | Auto-generates Early Bird / Standard / Onsite tiers |

### Speakers (4)

| Tool | Description |
|---|---|
| `list_speakers` | Filter by status (INVITED/CONFIRMED/DECLINED/CANCELLED) |
| `create_speaker` | Add speaker; returns `existingId` on duplicate email |
| `update_speaker` | Status + title/bio/org/jobTitle/phone/city/country/specialty/tags; post-update `syncToContact` |
| `list_speaker_agreements` | `filter: signed / unsigned / all`. Reads `Speaker.agreementAcceptedAt` |

### Schedule (5)

| Tool | Description |
|---|---|
| `list_sessions` | Filter by track |
| `create_session` | Includes topics + per-session roles; validates times fall within event dates (Asia/Dubai-aware) |
| `update_session` | Name/description/times/location/capacity/trackId/status with same tz-aware date validation |
| `add_topic_to_session` | Append a topic with speaker assignments |
| `list_live_sessions_now` | Currently running sessions + optional lookahead window |

### Tracks (2)

| Tool | Description |
|---|---|
| `list_tracks` | All tracks with session counts |
| `create_track` | Name + color + description |

### Abstracts & reviews (7)

| Tool | Description |
|---|---|
| `list_abstracts` | Filter by status, themeId |
| `update_abstract_status` | ACCEPT/REJECT/REVISE with notes. Fires speaker email + audit log. Structured errors for WITHDRAWN / notification-failed cases |
| `list_abstract_themes` | Categories |
| `create_abstract_theme` | Create a category |
| `list_review_criteria` | Scoring criteria with weights |
| `create_review_criterion` | Create a criterion (weight 1-10) |
| `list_reviewers` | Users assigned via `event.settings.reviewerUserIds` |

### Accommodation (6)

| Tool | Description |
|---|---|
| `list_hotels` | All event hotels |
| `create_hotel` | Name, address, stars, contact email/phone |
| `list_room_types` | Rooms with capacity, price, availability (totalRooms - bookedRooms) |
| `list_accommodations` | Room bookings (filter by status) |
| `create_accommodation` | Book a room for a registrant or speaker — atomic overbooking guard |
| `update_accommodation_status` | PENDING/CONFIRMED/CHECKED_IN/CHECKED_OUT/CANCELLED (releases room on cancel) |

### Webinar (3, WEBINAR-type events only)

| Tool | Description |
|---|---|
| `get_webinar_info` | `settings.webinar` + anchor session + linked ZoomMeeting (join URL, passcode, recording status) |
| `list_webinar_attendance` | KPIs (registered/attended/rate/avg watch time) + top-N attendee rows |
| `list_webinar_engagement` | Polls with per-question data + Q&A list |

### Sponsors (2)

| Tool | Description |
|---|---|
| `list_sponsors` | `Event.settings.sponsors` grouped by tier |
| `upsert_sponsors` | Replace-all semantics; URL scheme whitelist rejects `javascript:`/`data:` |

### Promo codes (4)

| Tool | Description |
|---|---|
| `list_promo_codes` | Code, discountType/Value, usage counts, validity window |
| `create_promo_code` | PERCENTAGE (1-100) or FIXED_AMOUNT, optional ticketTypeIds restriction |
| `update_promo_code` | Edit description/discount/validity/isActive |
| `delete_promo_code` | **Soft delete** via `isActive: false` — usage history preserved |

### Invoices (4)

| Tool | Description |
|---|---|
| `list_invoices` | Filter by type (INVOICE/RECEIPT/CREDIT_NOTE) and status |
| `create_invoice` | Generate invoice PDF for a registration; uses event's invoice counter |
| `send_invoice` | Email the PDF to the attendee; flips DRAFT → SENT |
| `update_invoice_status` | DRAFT/SENT/PAID/OVERDUE/CANCELLED/REFUNDED. **REFUNDED is DB-only — does NOT call Stripe** |

### Email templates + communications (5)

| Tool | Description |
|---|---|
| `list_email_templates` | Pre-built + event-level overrides |
| `update_email_template` | Edit subject/htmlContent/textContent per event (creates override from default if missing) |
| `reset_email_template` | Delete event-level override — system default used on next send |
| `send_bulk_email` | Send to speakers or registrations with per-template variable interpolation; supports status + ticketType filters |
| `get_speaker_agreement_template` | Returns the uploaded `.docx` template pointer (upload stays dashboard-only — file uploads don't fit MCP transport) |

### Scheduled emails (2)

| Tool | Description |
|---|---|
| `list_scheduled_emails` | PENDING/PROCESSING/SENT/FAILED/CANCELLED with send stats |
| `cancel_scheduled_email` | PENDING → CANCELLED |

### Zoom (2)

| Tool | Description |
|---|---|
| `list_zoom_meetings` | Sessions with linked Zoom meetings |
| `create_zoom_meeting` | Attach Zoom (MEETING / WEBINAR / WEBINAR_SERIES) to a session |

### Media + misc (1)

| Tool | Description |
|---|---|
| `list_media` | Org media library (upload stays dashboard-only) |

### Certificates (5)

v3 multi-template-per-category model (2026-06-02). See [`docs/CERTIFICATES.md`](CERTIFICATES.md) for the full architecture + the operator-facing guide at [user-guide.html §18](../public/user-guide.html#s18).

| Tool | Description |
|---|---|
| `list_certificate_templates` | All templates per category (ATTENDANCE / APPRECIATION) + event-level CME hours + accreditations. Each template carries `backgroundPdfUrl`, `textBoxes[]` (positioned overlays with `{{tokens}}`), and optional `emailSubject`/`emailBody` cover-email defaults. |
| `create_certificate_template` | New template — `name`, `category`, optional `backgroundPdfUrl` (upload via POST `/api/upload/pdf` first to get a `/uploads/...` URL), optional `textBoxes[]`, optional `emailSubject` + `emailBody` cover-email defaults. PNG/JPG uploads server-convert to single-page PDFs. |
| `update_certificate_template` | Patch by `templateId` — change name / backgroundPdfUrl / textBoxes / sortOrder / cover-email defaults. Pass `null` on `emailSubject`/`emailBody` to clear back to the system default. Category is immutable post-create. |
| `delete_certificate_template` | Delete by `templateId`. Blocked with 409 if any `IssuedCertificate` or `CertificateIssueRun` references the template (audit-trail integrity). |
| `update_cme_settings` | Event-level CME hours + accrediting bodies. Read by the `{{cmeHours}}` / `{{accreditationBody}}` / `{{accreditationReference}}` tokens on either category. |

**Not exposed via MCP** — the Issue flow itself (creates a `CertificateIssueRun` and fans out PDFs + emails). Operator-only via the dashboard because the cover-email confirmation step is interactive. Once the operator confirms in the dialog, the run executes via the existing cron worker.

**Eligibility model** — tag-driven manual selection. ATTENDANCE template + tag X → registrations where `Attendee.tags` includes X. APPRECIATION template + tag X → speakers where `Speaker.tags` includes X. No auto-eligibility based on check-in / payment / session-role / poster-accepted. The one-cert-per-recipient-per-category invariant is enforced by `IssuedCertificate`'s dual `@@unique` constraints.

## Resources (6)

Read-only snapshots that MCP clients can discover without tool calls.

| Resource URI | Description |
|---|---|
| `ea-sys://events` | All events in the org |
| `ea-sys://events/{eventId}/info` | Event details + counts |
| `ea-sys://events/{eventId}/registrations/summary` | Registration counts by status and payment |
| `ea-sys://events/{eventId}/speakers` | All speakers with status |
| `ea-sys://events/{eventId}/agenda` | Full session agenda with tracks + speakers |
| `ea-sys://events/{eventId}/abstracts/summary` | Abstract counts by status and theme |

## Prompts (7)

Pre-built workflow templates that guide clients through common tasks.

| Prompt | Arguments | Description |
|---|---|---|
| `setup-event` | eventId | Set up tracks, registration types, and sessions |
| `registration-report` | eventId | Comprehensive registration + payment report |
| `speaker-management` | eventId | List, invite, track speaker confirmations |
| `agenda-builder` | eventId | Build agenda with tracks, sessions, speakers |
| `abstract-review` | eventId | Review workflow: scores + status updates |
| `event-communications` | eventId | Draft and send emails |
| `pre-event-checklist` | eventId | Readiness check across all event areas |

## Rate Limits

EA-SYS applies rate limits at two layers: a **global MCP request quota** (all tool calls share one counter), and **per-tool buckets** for operations that are expensive or abuse-prone (outbound scraping, bulk email, file upload). Wave 2 teams should treat these as hard limits and serialise writes accordingly — concurrent calls that share a bucket are the easiest way to burn through a quota.

### Global

| Scope | Limit | Bucket key |
|---|---|---|
| MCP tool calls per API key / OAuth token | **100 / hour** | `mcp-<keyPrefix>` |

The MCP HTTP endpoint returns a **spec-compliant 429** with:
- `Retry-After: <seconds>` header
- JSON body `{ error, code: "RATE_LIMITED", retryAfterSeconds, limit, windowSeconds }`

Back off for `retryAfterSeconds` before retrying. No jitter needed — the bucket is a sliding window.

### Per-tool buckets

These fire **before** the global bucket counts the call, so a rate-limited tool call does not consume global quota.

| Tool | Limit | Window | Bucket key | Rationale |
|---|---|---|---|---|
| `send_bulk_email` | **10 / hour** | 1 hour | `agent-email-<eventId>` | Per-event so one event's campaign doesn't starve another |
| `research_sponsor` | **30 / hour** | 1 hour | `research-sponsor:<userId>:<eventId>` | Outbound web scrape — separate bucket so abuse can't piggyback on global budget |
| `upload_speaker_agreement_template` | **10 / hour** | 1 hour | `agreement-template-upload:<userId>` | Matches dashboard upload quota — can't be bypassed via MCP |

Every per-tool rejection returns a structured MCP response (not HTTP 429) with the same fields:

```json
{
  "error": "Rate limit exceeded: <n> <operation> per <scope>. Retry after <s>s.",
  "code": "RATE_LIMITED",
  "retryAfterSeconds": 1234,
  "limit": 10,
  "windowSeconds": 3600
}
```

### OAuth flows (separate surface)

| Scope | Limit |
|---|---|
| OAuth client registration (DCR) | 10 / hour / IP |
| OAuth authorize | 30 / hour / IP |
| OAuth token exchange | 60 / hour / client_id |
| OAuth revocation | 30 / hour / IP |

### Recommendations for agent implementations

1. **Serialise writes.** Firing 3–4 concurrent `create_*` / `update_*` calls will trigger the global bucket's write-detection — prefer batch endpoints (`create_registrations_bulk`, `create_speakers_bulk`, `bulk_update_registration_status`) when the dataset allows.
2. **Pre-check with `list_*` tools.** Reads do count against the 100/hr global quota, but `list_ticket_types` + `list_registrations` before a write is still cheaper than a write that races into a 429 mid-batch.
3. **Respect `Retry-After`.** Both the global 429 and per-tool responses include explicit retry windows. Agents that sleep-retry without reading the header will compound the problem.
4. **Observe the split.** If a `send_bulk_email` call gets `RATE_LIMITED` with a per-event window, switching to a different event restores capacity. If the global MCP bucket is hit, all tools are blocked until the window slides.

## Architecture

```
 Browser (claude.ai)        Claude Desktop / n8n         Custom MCP client
         │                           │                           │
    OAuth 2.1                   x-api-key                   x-api-key
         │                           │                           │
         └───────────┬───────────────┴───────────────────────────┘
                     │
             HTTPS + CORS
                     │
        ┌────────────▼──────────────────┐
        │  /api/mcp (Streamable HTTP)   │
        │  - auth: API key OR OAuth     │
        │  - 100 req/hr rate limit      │
        │  - 30-min session TTL         │
        └────────────┬──────────────────┘
                     │
        ┌────────────▼──────────────────┐
        │  buildMcpServer(orgId)         │
        │  src/lib/agent/                │
        │    mcp-server-builder.ts       │
        └────────────┬──────────────────┘
                     │
        ┌────────────▼──────────────────┐
        │  TOOL_EXECUTOR_MAP             │
        │  65 executors, org-scoped      │
        │  src/lib/agent/event-tools.ts │
        └────────────┬──────────────────┘
                     │
        ┌────────────▼──────────────────┐
        │  PostgreSQL via Prisma         │
        └───────────────────────────────┘
```

Every tool:
- Resolves the target entity via `findFirst({ where: { id, event: { organizationId } } })` or equivalent cross-tenant safety
- Writes `AuditLog` rows with `changes.source: "mcp"` so agent-initiated changes are traceable

## Examples

### Claude.ai — end-to-end event creation

```
User: "Create a cardiology summit for June 1-3 in Dubai"
→ create_event { name: "Cardiology Summit 2026", startDate: "2026-06-01T00:00:00Z", endDate: "2026-06-03T23:59:59Z", city: "Dubai", country: "United Arab Emirates" }

User: "Add Early Bird Physician and Student ticket types"
→ create_ticket_type { eventId, name: "Early Bird Physician" }
→ create_ticket_type { eventId, name: "Student" }

User: "Dr. Sarah Mitchell from Dubai Health Authority is speaking"
→ create_speaker { eventId, email: "sarah.mitchell@dha.ae", firstName: "Sarah", lastName: "Mitchell", title: "DR", organization: "Dubai Health Authority" }

User: "Who hasn't paid yet?"
→ list_unpaid_registrations { eventId }

User: "What's the state of the event?"
→ get_event_dashboard { eventId }
```

### Python MCP client

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async with streamablehttp_client(
    "https://events.meetingmindsgroup.com/api/mcp",
    headers={"x-api-key": "mmg_your_key"}
) as (read, write, _):
    async with ClientSession(read, write) as session:
        await session.initialize()
        tools = await session.list_tools()
        result = await session.call_tool("get_event_dashboard", {"eventId": "cmn..."})
        print(result)
```

### Raw curl (for testing / debugging)

```bash
# List events
curl -s -X POST https://events.meetingmindsgroup.com/api/mcp \
  -H 'x-api-key: mmg_your_key' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_events","arguments":{}},"id":1}'

# Note: you must initialize the session first — see "Direct HTTP" section above
```

## Safety rails

- **No hard deletes** via MCP. Everything destructive is soft-delete (e.g., `delete_promo_code` flips `isActive: false`) or requires dashboard interaction.
- **No financial movement**. `update_invoice_status: REFUNDED` is DB-only — Stripe refunds stay dashboard-only.
- **File uploads (.docx templates, media) stay dashboard-only** — JSON-RPC transport isn't a good fit for binary blobs.
- **Cross-org isolation enforced**. Every tool scopes by `organizationId` from the auth context. A key from org A literally cannot touch org B's data.

## Deferred / not yet implemented

- **Reviewer assignment + abstract scoring** — needs new `AbstractReviewer` + `AbstractScore` schema tables (Sprint B).
- **Bulk creates** (`create_speakers_bulk`, `create_registrations_bulk`) — useful for CSV-style imports via Claude, not yet wrapped.
- **Hard deletes** — intentionally deferred as safety rail.
- **Webhooks / real-time events** — separate architectural lift.

See `docs/MCP_AUDIT_RESPONSE.html` for the full post-audit status and Sprint B planning.

## Further reading

- **`docs/MCP_OAUTH.html`** — OAuth 2.1 architecture + claude.ai connection flow (local-only, not in git)
- **`docs/MCP_AUDIT_RESPONSE.html`** — Structured response to external audit + Sprint B roadmap
- **`CLAUDE.md`** — Full feature index + recent changes
- **MCP spec** — [modelcontextprotocol.io](https://modelcontextprotocol.io)
