/**
 * Audit trail for bulk data movement — CSV/PDF exports and imports.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this module, audit coverage on import/export was accidental: 5 of 23
 * paths wrote an `AuditLog` row, a handful wrote a pino line, and the single
 * most-used export (the registrations list) was built in the browser and left
 * no trace at all. "Who exported our attendee list last month?" was not an
 * answerable question.
 *
 * A pino line is NOT an audit trail — `SystemLog` is operational logging, it
 * has a Clear Logs button in the UI and no retention guarantee. Bulk movement
 * of attendee PII / finance data belongs in `AuditLog`, which is durable,
 * queryable, and surfaced in the Activity timelines.
 *
 * CONTRACT
 * --------
 * 1. **Never throws.** Both helpers are fire-and-forget with a logged catch. An
 *    audit-write blip must not fail an export the caller already streamed or an
 *    import that already committed — but the gap must be visible in the logs.
 *    Callers MUST NOT `await` these (there is nothing to await).
 * 2. **Never rejects the operation.** These record what happened; they do not
 *    gate it. Authorization belongs at the route boundary.
 * 3. **One implementation.** Every import/export site calls one of these two so
 *    the recorded shape cannot drift between callers.
 *
 * ENTITY ID CONVENTION
 * --------------------
 * A bulk transfer has no single subject row, so `entityId` names the *scope*:
 * `event:<id>` for event-scoped data, else `org:<id>`. This mirrors the shape
 * the contacts export established (`org:<organizationId>`) and keeps the
 * `@@index([entityType, entityId])` lookup useful — "every export of event E".
 */

import { createHash } from "node:crypto";

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";

/**
 * JSON-safe filter/detail values. Deliberately narrow: `AuditLog.changes` is a
 * Prisma `Json` column and rejects `undefined`, so callers can't hand us a
 * partially-built object with optional keys.
 */
export type TransferDetailValue = string | number | boolean | string[] | null;

/**
 * Mutable JSON-safe shape we build before handing it to Prisma. Prisma's own
 * `InputJsonObject` has a readonly index signature, so it can't be assembled
 * conditionally — this is the writable equivalent.
 */
type TransferChanges = Record<string, TransferDetailValue | Record<string, TransferDetailValue>>;

/** Where the call came from — mirrors the services-layer `source` convention. */
export type TransferSource = "rest" | "api" | "mcp" | "cron";

interface TransferScope {
  /** Org-scoped callers (contacts, invoices, CRM). At least one of these must be set. */
  organizationId?: string | null;
  /** Event-scoped callers. Also written to `AuditLog.eventId` so event activity feeds pick it up. */
  eventId?: string | null;
  userId?: string | null;
  /** Caller's role at the time — a MEMBER export and an ADMIN export are different facts. */
  role?: string | null;
  source?: TransferSource;
}

interface ExportArgs extends TransferScope {
  /** Prisma model name of what left the building: "Registration", "Contact", … */
  entityType: string;
  /** Rows in the produced file. The number that matters after an incident. */
  rowCount: number;
  /** "csv" | "pdf" | "quickbooks" | … — one entityType can leave by several doors. */
  format?: string;
  /** Whatever narrowed the export, so a 12-row pull is distinguishable from the whole book. */
  filters?: Record<string, TransferDetailValue>;
}

interface ImportArgs extends TransferScope {
  entityType: string;
  /** Rows read from the file (not rows created — imports skip and fail rows). */
  totalProcessed: number;
  created?: number;
  updated?: number;
  skipped?: number;
  errors?: number;
  /** "csv" | "eventsair" | … */
  format?: string;
}

function scopeEntityId(scope: TransferScope): string {
  if (scope.eventId) return `event:${scope.eventId}`;
  if (scope.organizationId) return `org:${scope.organizationId}`;
  // Should be unreachable — every caller is scoped. We still record the row
  // (a future caller that forgets should leave *something* rather than nothing)
  // but this module's whole thesis is that gaps must be visible, so an
  // unscoped row is loud rather than a quiet magic string nobody notices.
  apiLogger.warn({
    msg: "audit-transfer:unscoped-row",
    hint: "recordExport/recordImport called with neither eventId nor organizationId",
  });
  return "unscoped";
}

/**
 * Record a bulk read leaving the system (CSV/PDF/export-of-any-kind).
 *
 * Fire-and-forget by contract — do NOT await.
 */
export function recordExport(req: Request | null, args: ExportArgs): void {
  const changes: TransferChanges = {
    source: args.source ?? "rest",
    format: args.format ?? "csv",
    rowCount: args.rowCount,
    role: args.role ?? null,
    organizationId: args.organizationId ?? null,
    ip: req ? getClientIp(req) : null,
  };
  if (args.filters && Object.keys(args.filters).length > 0) {
    changes.filters = args.filters;
  }

  db.auditLog
    .create({
      data: {
        // Event-scoped exports also land on the event's activity feed.
        eventId: args.eventId ?? null,
        userId: args.userId ?? null,
        action: "EXPORT",
        entityType: args.entityType,
        entityId: scopeEntityId(args),
        changes,
      },
    })
    .catch((err) =>
      apiLogger.error({
        err,
        msg: "audit-export:write-failed",
        entityType: args.entityType,
        eventId: args.eventId ?? null,
        organizationId: args.organizationId ?? null,
      }),
    );
}

/**
 * Record a bulk write entering the system (CSV/EventsAir/any import).
 *
 * Fire-and-forget by contract — do NOT await.
 *
 * NOTE: this is deliberately separate from the per-row `CREATE` audits some
 * import paths already write (speakers, sessions, CRM). Those answer "which
 * rows exist and who made them"; this answers "who ran an import, when, and
 * how much of it landed" — including the skipped and failed rows, which leave
 * no per-row trace at all.
 */
export function recordImport(req: Request | null, args: ImportArgs): void {
  const changes: TransferChanges = {
    source: args.source ?? "rest",
    format: args.format ?? "csv",
    totalProcessed: args.totalProcessed,
    role: args.role ?? null,
    organizationId: args.organizationId ?? null,
    ip: req ? getClientIp(req) : null,
  };
  if (args.created !== undefined) changes.created = args.created;
  if (args.updated !== undefined) changes.updated = args.updated;
  if (args.skipped !== undefined) changes.skipped = args.skipped;
  if (args.errors !== undefined) changes.errors = args.errors;

  db.auditLog
    .create({
      data: {
        eventId: args.eventId ?? null,
        userId: args.userId ?? null,
        action: "IMPORT",
        entityType: args.entityType,
        entityId: scopeEntityId(args),
        changes,
      },
    })
    .catch((err) =>
      apiLogger.error({
        err,
        msg: "audit-import:write-failed",
        entityType: args.entityType,
        eventId: args.eventId ?? null,
        organizationId: args.organizationId ?? null,
      }),
    );
}

/**
 * A stable, non-reversible fingerprint of a free-text search term, for audit
 * rows.
 *
 * WHY NOT STORE THE TERM: operators search full names and email addresses, so
 * `changes.filters.q` would accumulate attendee identifiers indefinitely.
 * `AuditLog` has no prune job (unlike `EmailLog.htmlBody`, which got a 180-day
 * pruner for exactly this reason) and its rows survive the subject's
 * `Registration`/`Attendee`/`Contact` being deleted — so a subject-erasure
 * request could not reach it. Storing a digest keeps the two things the audit
 * actually needs (was this pull targeted, and were repeated pulls the same
 * search?) without persisting the identifier.
 *
 * Truncated to 12 hex chars: enough to correlate, far too short to attack.
 * Not a security boundary — it is data minimization.
 */
export function fingerprintSearchTerm(term: string): string {
  return createHash("sha256").update(term.trim().toLowerCase()).digest("hex").slice(0, 12);
}
