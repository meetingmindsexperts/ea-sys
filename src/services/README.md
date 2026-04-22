# Services

Domain-logic layer. Pure functions that encapsulate business rules,
DB writes, and side effects — no HTTP concepts (no `NextRequest`,
no sessions, no status codes). Each service is callable from any
entry point: REST route handlers, MCP agent tools, cron workers,
future external APIs, tests.

## Conventions

### Directory

- Top-level `src/services/`, sibling to `src/lib/`.
- One file per domain (`accommodation-service.ts`, `registration-service.ts`, ...).
- Exports: one `createX` / `updateX` / `deleteX` function per operation,
  plus the `CreateXInput` / `CreateXResult` / `CreateXErrorCode` types.

### Result shape — errors as values

Every service function returns a discriminated union so callers are
forced by the TypeScript compiler to narrow `result.ok` before they
can access the payload.

```typescript
type CreateAccommodationResult =
  | { ok: true; accommodation: Accommodation; nights: number }
  | { ok: false; code: CreateAccommodationErrorCode; message: string; meta?: Record<string, unknown> };
```

**Success payload key — domain-named, not `data`.** We use the entity
name (`accommodation`, `registration`, `speaker`) on the success
branch, with related derived values as sibling fields (e.g., `nights`
on `CreateAccommodationResult`). Domain-named keys flow Prisma types
through naturally and read better at call sites than `result.data`.

- **Expected domain errors** (validation, not-found, conflict, race) are
  returned as `{ ok: false, code, message }`.
- **Unexpected errors** (DB down, out-of-memory, bugs) still throw. The
  service's own `try/catch` only converts known error signals (e.g., a
  transaction `throw new Error("NO_ROOMS_AVAILABLE")` becomes
  `{ ok: false, code: "NO_ROOMS_AVAILABLE" }`).

### Input shape

Services receive **already-typed, already-validated** input:

- Dates as `Date`, not `string`. Each caller does its own Zod/manual
  parsing at its boundary.
- No optional-looking-required fields — inputs are precise.
- Always include caller identity fields: `organizationId`, `userId`,
  `source: "rest" | "mcp" | "api"`. Services use `source` for audit
  logs and structured logging.

### Side effects owned by the service

A service that writes also owns all downstream side effects for that
write:

- Audit log (`db.auditLog.create({ ...changes: { source } })`)
- Sync to derived stores (`syncToContact`, `refreshEventStats`)
- Domain notifications (`notifyEventAdmins`, `notifyAbstractStatusChange`)
- Transactional emails (`sendRegistrationConfirmation`)

This is the entire point of the layer: a caller that forgets one of
these can't exist, because there's nothing to forget — the service
wraps all of them.

### What stays in the route / tool / cron caller

- Parsing the HTTP request / MCP tool input into the service's typed
  input shape (Zod, manual `String()`, date parsing).
- Authentication (`auth()`, `validateApiKey()`, NextAuth session).
- Authorization (`denyReviewer()`, role checks, rate limiting, CSRF).
- Response shaping (HTTP status codes, JSON envelope, MCP success/error
  shape, cron job logging).
- Caller-specific flavor text in error messages ("use list_ticket_types
  to get valid IDs" is an MCP concern, not a domain concern).

### Error-code mapping

Each caller maps `result.code` to its own response format:

```typescript
// REST
const HTTP_STATUS_FOR_CODE: Record<string, number> = {
  EVENT_NOT_FOUND: 404,
  ROOM_NOT_FOUND: 404,
  NO_ROOMS_AVAILABLE: 400,
  // ...
};

// MCP
function mcpErrorFromResult(r: { ok: false; code: string; message: string }) {
  return { error: r.message, code: r.code };
}
```

The service never emits an HTTP status code or an MCP `error:` field
directly.

### Testing

- **Unit tests** live in `__tests__/services/<name>.test.ts` and mock
  `db` + external helpers. Exercise every error branch.
- **Integration tests** via the route/tool caller test if UI + API +
  service behaviour matters. Services alone are pure enough that most
  coverage should be unit-level.

### Adding a new service

1. Write the service file with the result-type pattern. Match the
   existing domain conventions.
2. Write unit tests alongside. Every error branch gets a test.
3. Migrate one caller at a time. Each migration should: delete the
   duplicated logic from the caller, replace with a service call and
   a result-to-response mapping, pass the full test suite.
4. Run an independent review-agent checkpoint after each migration.
5. Commit per-service (not per-caller). Phase 1+ migrations ship
   together for one service.
