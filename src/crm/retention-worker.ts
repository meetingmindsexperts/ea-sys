/**
 * CRM data retention worker (Nov 6, 2026; CRM product review P1-9). SERVER /
 * WORKER ONLY. Applies each organisation's own periods (lib/retention-rules.ts):
 * email threads whose last message is older than the email period, with their
 * messages and attachment files, and notes older than the notes period.
 *
 * OFF unless an organisation set a period, and never for an organisation
 * without the CRM entitlement. Bounded per run (a backlog drains over several
 * nights). Each organisation's deletions and their AuditLog summary are one
 * transaction; files are removed after it commits, and a file that will not
 * delete is logged with its path.
 */
import { Prisma } from "@prisma/client";
import { dbOperator, tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { crmStorage } from "@/crm/integrations/storage";
import { readCrmRetention, retentionCutoff, retentionIsOn } from "@/crm/lib/retention-rules";

/** Per organisation, per kind, per run. */
const BATCH = 500;

export interface RetentionReport {
  organisations: number;
  emailThreads: number;
  notes: number;
  files: number;
  failures: number;
}

function attachmentPaths(value: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((a) => (a && typeof a === "object" && typeof (a as { path?: unknown }).path === "string" ? [(a as { path: string }).path] : []));
}

async function applyForOrganisation(organizationId: string, settings: unknown, now: Date) {
  const retention = readCrmRetention(settings);
  const outcome = await tenantTransaction(async (tx) => {
    let threadIds: string[] = [];
    let files: string[] = [];
    let emailCutoff: Date | null = null;
    if (retention.emailMonths !== null) {
      emailCutoff = retentionCutoff(retention.emailMonths, now);
      const threads = await tx.crmEmailThread.findMany({
        where: { organizationId, lastMessageAt: { lt: emailCutoff } },
        select: { id: true, messages: { select: { attachments: true } } },
        take: BATCH,
      });
      threadIds = threads.map((t) => t.id);
      files = threads.flatMap((t) => t.messages.flatMap((m) => attachmentPaths(m.attachments)));
      if (threadIds.length) await tx.crmEmailThread.deleteMany({ where: { id: { in: threadIds }, organizationId } });
    }
    let notes = 0;
    let notesCutoff: Date | null = null;
    if (retention.notesMonths !== null) {
      notesCutoff = retentionCutoff(retention.notesMonths, now);
      const old = await tx.crmNote.findMany({ where: { organizationId, createdAt: { lt: notesCutoff } }, select: { id: true }, take: BATCH });
      if (old.length) notes = (await tx.crmNote.deleteMany({ where: { id: { in: old.map((n) => n.id) }, organizationId } })).count;
    }
    if (threadIds.length || notes) {
      await tx.auditLog.create({
        data: {
          organizationId,
          userId: null,
          action: "CRM_RETENTION_APPLIED",
          entityType: "Organization",
          entityId: organizationId,
          changes: {
            source: "cron",
            retention,
            emailCutoff: emailCutoff?.toISOString() ?? null,
            notesCutoff: notesCutoff?.toISOString() ?? null,
            emailThreads: threadIds.length,
            notes,
            attachmentFiles: files.length,
          } as Prisma.InputJsonValue,
        },
      });
    }
    return { emailThreads: threadIds.length, notes, files };
  });
  for (const path of outcome.files) {
    await crmStorage.remove("emailAttachment", path).catch((err) =>
      apiLogger.error({ msg: "crm-retention:attachment-delete-failed", organizationId, path, err: err instanceof Error ? err.message : String(err) }),
    );
  }
  return outcome;
}

export async function runRetentionTick(now = new Date()): Promise<RetentionReport> {
  const report: RetentionReport = { organisations: 0, emailThreads: 0, notes: 0, files: 0, failures: 0 };
  // Privileged lane: finding which organisations set a period is a cross-tenant
  // question; every deletion runs inside that organisation's own lane.
  const orgs = await dbOperator.organization.findMany({
    where: { enabledModules: { has: "crm" } },
    select: { id: true, settings: true },
  });
  for (const org of orgs) {
    if (!retentionIsOn(readCrmRetention(org.settings))) continue;
    report.organisations++;
    try {
      const done = await runWithTenant(org.id, () => applyForOrganisation(org.id, org.settings, now));
      report.emailThreads += done.emailThreads;
      report.notes += done.notes;
      report.files += done.files.length;
      if (done.emailThreads || done.notes) apiLogger.info({ msg: "crm-retention:applied", organizationId: org.id, emailThreads: done.emailThreads, notes: done.notes });
    } catch (err) {
      report.failures++;
      apiLogger.error({ msg: "crm-retention:org-failed", organizationId: org.id, err: err instanceof Error ? err.message : String(err) });
    }
  }
  if (report.organisations) apiLogger.info({ msg: "crm-retention:tick", ...report });
  return report;
}
