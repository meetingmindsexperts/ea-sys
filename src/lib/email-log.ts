import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { EmailLogEntityType } from "@prisma/client";

/**
 * Optional context captured per sendEmail() call so we can link the log row
 * back to the registrant / speaker / contact the email belongs to. All fields
 * are optional — unknown callers get an OTHER-typed row that still records
 * the bare facts (to, subject, provider, status).
 */
export interface EmailLogContext {
  organizationId?: string | null;
  eventId?: string | null;
  entityType?: EmailLogEntityType;
  entityId?: string | null;
  templateSlug?: string | null;
  triggeredByUserId?: string | null;
  /**
   * When true, sendEmail persists the final rendered HTML body onto the
   * EmailLog row (`htmlBody`) as an audit copy of exactly what was sent.
   * Opt-in per caller — certificate deliveries set it (organizer request
   * 2026-07-10: "save the html body"); most transactional mail doesn't,
   * keeping the table lean.
   */
  storeBody?: boolean;
}

export interface EmailLogRecord {
  to: string;
  cc?: string | null;
  bcc?: string | null;
  subject: string;
  provider: string;
  providerMessageId?: string | null;
  status: "SENT" | "FAILED";
  errorMessage?: string | null;
  /** Final rendered HTML — persisted only when context.storeBody is set. */
  htmlBody?: string | null;
  context?: EmailLogContext;
}

/**
 * Persist one row to EmailLog. Never throws — a DB failure here must not
 * break the outer send flow, so errors get logged via Pino and swallowed.
 */
export async function logEmail(record: EmailLogRecord): Promise<void> {
  try {
    await db.emailLog.create({
      data: {
        organizationId: record.context?.organizationId ?? null,
        eventId: record.context?.eventId ?? null,
        entityType: record.context?.entityType ?? "OTHER",
        entityId: record.context?.entityId ?? null,
        to: record.to,
        cc: record.cc ?? null,
        bcc: record.bcc ?? null,
        subject: record.subject,
        templateSlug: record.context?.templateSlug ?? null,
        provider: record.provider,
        providerMessageId: record.providerMessageId ?? null,
        status: record.status,
        errorMessage: record.errorMessage ?? null,
        htmlBody: record.context?.storeBody ? (record.htmlBody ?? null) : null,
        triggeredByUserId: record.context?.triggeredByUserId ?? null,
      },
    });
  } catch (err) {
    apiLogger.warn({
      err,
      msg: "Failed to write EmailLog row; send itself was unaffected",
      to: record.to,
      subject: record.subject,
    });
  }
}

/**
 * Read helper — last 50 rows for a given entity, newest first. Caller is
 * responsible for RBAC scoping (org match on the entity record).
 *
 * Org-scope filter: historically required `organizationId === <caller's org>`,
 * which had a silent failure mode — many transactional callers
 * (sendRegistrationConfirmation, abstract-status notifications, cert
 * delivery, refund confirmation, payment confirmation, password reset)
 * write `logContext.organizationId = null`. Those rows were correctly
 * tagged with entityType + entityId, but the org filter excluded them,
 * so the Email History card on the registration / speaker / contact
 * detail sheet appeared empty even when the email DID go out.
 *
 * The fix: accept rows whose `organizationId` matches the caller's org
 * OR is null. The route layer already enforces ownership on the parent
 * entity (registration.event.organizationId === ctx.org for REGISTRATION,
 * etc.) so null-org rows for an owned entity belong to that org by
 * construction — they're only un-tagged because the caller forgot to
 * thread organizationId through their logContext literal.
 *
 * Backward-compatible: existing rows that DO have organizationId set
 * still match exactly; the OR just stops null-org rows from being
 * silently filtered. The 8-caller fix (commit B) sets organizationId
 * properly going forward, but A alone makes ALL historical rows
 * visible immediately.
 */
export async function getEmailLogsFor(
  entityType: EmailLogEntityType,
  entityId: string,
  organizationId?: string | null
) {
  return db.emailLog.findMany({
    where: {
      entityType,
      entityId,
      ...(organizationId
        ? { OR: [{ organizationId }, { organizationId: null }] }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      to: true,
      cc: true,
      subject: true,
      templateSlug: true,
      provider: true,
      providerMessageId: true,
      status: true,
      errorMessage: true,
      // Presence flag only — mapped to `hasBody` below and stripped so the
      // (potentially large) audit HTML never rides along in list payloads.
      htmlBody: true,
      createdAt: true,
      triggeredBy: { select: { firstName: true, lastName: true, email: true } },
    },
  }).then((rows) =>
    rows.map(({ htmlBody, ...rest }) => ({
      ...rest,
      /** True when the final rendered HTML was stored (opt-in senders —
       *  certificate deliveries). Fetch it via GET /api/email-logs/[id]/body. */
      hasBody: htmlBody != null,
    })),
  );
}
