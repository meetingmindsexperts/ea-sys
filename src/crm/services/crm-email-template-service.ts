/**
 * CRM email templates — the org's editable starting points for the sponsor blast +
 * per-deal send. SERVER ONLY.
 *
 * Org-wide shared: one set per org, edited by any CRM writer (not per-user). Seeded
 * lazily from the built-in constants on first use — the same "presence of any row =
 * the org owns its set, don't re-seed" rule as `ensurePipelineStages` (archiving all
 * of them must not resurrect the built-ins).
 *
 * These are config, not a tracked CRM record, so they audit to the core `AuditLog`
 * (entityType "CrmEmailTemplate") the same way pipeline-stage edits do — NOT the
 * entity-typed `CrmActivity` change-log (whose enum has no template kind).
 */
import { Prisma, type CrmEmailTemplate } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { CRM_EMAIL_TEMPLATES } from "@/crm/lib/crm-email-templates";

export type CrmEmailTemplateErrorCode =
  | "NAME_REQUIRED"
  | "SUBJECT_REQUIRED"
  | "BODY_REQUIRED"
  | "TEMPLATE_NOT_FOUND"
  | "UNKNOWN";

type Fail = { ok: false; code: CrmEmailTemplateErrorCode; message: string };

/** Fire-and-forget audit with a logged catch (a blip must never 500 a committed write). */
function writeAudit(entry: {
  userId: string | null;
  action: string;
  entityId: string;
  changes: Record<string, unknown>;
}) {
  return db.auditLog
    .create({
      data: {
        userId: entry.userId,
        action: entry.action,
        entityType: "CrmEmailTemplate",
        entityId: entry.entityId,
        changes: entry.changes as Prisma.InputJsonValue,
      },
    })
    .catch((err: unknown) => {
      apiLogger.error({
        msg: "crm-email-template:audit-failed",
        entityId: entry.entityId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * Seed the built-in templates the first time an org touches the CRM email surface.
 * Idempotent: seeds ONLY when the org has zero template rows (archived or not), so
 * an org that has deleted/edited its set is never overwritten.
 */
export async function ensureCrmEmailTemplates(organizationId: string): Promise<void> {
  const count = await db.crmEmailTemplate.count({ where: { organizationId } });
  if (count > 0) return;

  try {
    await db.crmEmailTemplate.createMany({
      data: CRM_EMAIL_TEMPLATES.map((t, i) => ({
        organizationId,
        name: t.label,
        subject: t.subject,
        body: t.body,
        sortOrder: i,
      })),
      // Real, not decorative: @@unique([organizationId, name]) backs this, so when
      // two concurrent first-loads both pass the count===0 fast-path the second
      // createMany skips every built-in instead of seeding a duplicate set
      // (CRM review H1 — skipDuplicates without a unique constraint skips nothing).
      skipDuplicates: true,
    });
    apiLogger.info({ msg: "crm-email-template:seeded", organizationId, count: CRM_EMAIL_TEMPLATES.length });
  } catch (err) {
    // Anything else that raced us is settled by the caller's list read.
    apiLogger.warn({
      msg: "crm-email-template:seed-race",
      organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function listCrmEmailTemplates(
  organizationId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<CrmEmailTemplate[]> {
  return db.crmEmailTemplate.findMany({
    where: { organizationId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ archivedAt: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    take: 200,
  });
}

export async function createCrmEmailTemplate(input: {
  organizationId: string;
  userId: string | null;
  name: string;
  subject: string;
  body: string;
}): Promise<{ ok: true; template: CrmEmailTemplate } | Fail> {
  const name = input.name?.trim() ?? "";
  const subject = input.subject?.trim() ?? "";
  const body = input.body?.trim() ?? "";
  if (!name) return { ok: false, code: "NAME_REQUIRED", message: "Template name is required" };
  if (!subject) return { ok: false, code: "SUBJECT_REQUIRED", message: "A subject is required" };
  if (!body) return { ok: false, code: "BODY_REQUIRED", message: "A message body is required" };

  try {
    // Next sortOrder inside a transaction so two concurrent adds can't claim the
    // same slot (the sortOrder race pattern from the certificates review).
    const template = await db.$transaction(async (tx) => {
      const agg = await tx.crmEmailTemplate.aggregate({
        where: { organizationId: input.organizationId },
        _max: { sortOrder: true },
      });
      return tx.crmEmailTemplate.create({
        data: {
          organizationId: input.organizationId,
          name,
          subject,
          body,
          sortOrder: (agg._max.sortOrder ?? -1) + 1,
          createdById: input.userId,
        },
      });
    });

    void writeAudit({ userId: input.userId, action: "CREATE", entityId: template.id, changes: { name, subject } });
    apiLogger.info({ msg: "crm-email-template:created", templateId: template.id, organizationId: input.organizationId });
    return { ok: true, template };
  } catch (err) {
    apiLogger.error({
      msg: "crm-email-template:create-failed",
      organizationId: input.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not create the template" };
  }
}

export async function updateCrmEmailTemplate(input: {
  templateId: string;
  organizationId: string;
  userId: string | null;
  name?: string;
  subject?: string;
  body?: string;
}): Promise<{ ok: true; template: CrmEmailTemplate } | Fail> {
  const data: Prisma.CrmEmailTemplateUpdateManyMutationInput = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { ok: false, code: "NAME_REQUIRED", message: "Template name cannot be empty" };
    data.name = name;
  }
  if (input.subject !== undefined) {
    const subject = input.subject.trim();
    if (!subject) return { ok: false, code: "SUBJECT_REQUIRED", message: "Subject cannot be empty" };
    data.subject = subject;
  }
  if (input.body !== undefined) {
    const body = input.body.trim();
    if (!body) return { ok: false, code: "BODY_REQUIRED", message: "Body cannot be empty" };
    data.body = body;
  }

  try {
    // Org-bound update (never trust the id alone).
    const res = await db.crmEmailTemplate.updateMany({
      where: { id: input.templateId, organizationId: input.organizationId },
      data,
    });
    if (res.count === 0) {
      apiLogger.warn({ msg: "crm-email-template:update-not-found", templateId: input.templateId, organizationId: input.organizationId });
      return { ok: false, code: "TEMPLATE_NOT_FOUND", message: "Template not found" };
    }
    const template = await db.crmEmailTemplate.findUniqueOrThrow({ where: { id: input.templateId } });
    void writeAudit({ userId: input.userId, action: "UPDATE", entityId: template.id, changes: { fields: Object.keys(data) } });
    return { ok: true, template };
  } catch (err) {
    apiLogger.error({
      msg: "crm-email-template:update-failed",
      templateId: input.templateId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not update the template" };
  }
}

export async function setCrmEmailTemplateArchived(input: {
  templateId: string;
  organizationId: string;
  userId: string | null;
  archived: boolean;
}): Promise<{ ok: true; template: CrmEmailTemplate } | Fail> {
  try {
    const res = await db.crmEmailTemplate.updateMany({
      where: { id: input.templateId, organizationId: input.organizationId },
      data: { archivedAt: input.archived ? new Date() : null },
    });
    if (res.count === 0) {
      apiLogger.warn({ msg: "crm-email-template:archive-not-found", templateId: input.templateId, organizationId: input.organizationId });
      return { ok: false, code: "TEMPLATE_NOT_FOUND", message: "Template not found" };
    }
    const template = await db.crmEmailTemplate.findUniqueOrThrow({ where: { id: input.templateId } });
    void writeAudit({ userId: input.userId, action: input.archived ? "ARCHIVE" : "RESTORE", entityId: template.id, changes: { name: template.name } });
    return { ok: true, template };
  } catch (err) {
    apiLogger.error({
      msg: "crm-email-template:archive-failed",
      templateId: input.templateId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not archive the template" };
  }
}
