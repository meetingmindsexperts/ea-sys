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
      ...(organizationId ? { organizationId } : {}),
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
      createdAt: true,
      triggeredBy: { select: { firstName: true, lastName: true, email: true } },
    },
  });
}
