/**
 * CRM purge service — PERMANENT deletion of ARCHIVED records. SERVER ONLY.
 *
 * This is the ONE deliberate exception to the module's no-hard-delete rule
 * (owner request, July 20 2026): a SUPER_ADMIN may permanently delete archived
 * deals, companies and CRM contacts — singly, or "everything in the archive".
 *
 * The rules that keep it safe:
 *
 *  1. ARCHIVED ONLY. An active record can never be purged — archive is the
 *     staging area, so destruction is always a two-step, reversible-until-the-
 *     last-moment act. NOT_ARCHIVED otherwise.
 *  2. SUPER_ADMIN SESSIONS ONLY — enforced at the route boundary
 *     (requireCrmPurge; API keys refused). The service still takes userId for
 *     the audit trail.
 *  3. THE AUDIT ROW IS THE ONLY SURVIVING RECORD. Every purge snapshots the row
 *     into a core AuditLog entry (the pipeline deleteStage precedent: after the
 *     delete, the audit entry IS the only record it existed). The entity's
 *     CrmActivity history is deleted with it — those rows are unreachable once
 *     the record is gone, and the snapshot preserves the fact of deletion.
 *  4. FK REALITY. Deleting a deal cascades its people links, line items, notes
 *     and tasks (all Cascade). A company is Restrict-protected by its deals —
 *     purging one still referenced by ANY deal is refused (COMPANY_HAS_DEALS);
 *     the bulk purge therefore runs deals → companies → contacts so a company
 *     whose only deals were archived becomes deletable in the same pass.
 *     Deleting a contact cascades its deal links — it disappears from any deal
 *     it was attached to (the confirm copy says so).
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

export type CrmPurgeErrorCode =
  | "DEAL_NOT_FOUND"
  | "COMPANY_NOT_FOUND"
  | "CONTACT_NOT_FOUND"
  | "NOT_ARCHIVED"
  | "COMPANY_HAS_DEALS"
  | "UNKNOWN";

type Fail = { ok: false; code: CrmPurgeErrorCode; message: string; meta?: Record<string, unknown> };

function reject(code: CrmPurgeErrorCode, message: string, ctx: Record<string, unknown>): Fail {
  apiLogger.warn({ msg: `crm-purge:${code.toLowerCase()}`, ...ctx });
  return { ok: false, code, message };
}

/** Fire-and-forget with a logged catch — the delete already committed. */
function writeAudit(entry: {
  userId: string | null;
  entityType: "CrmDeal" | "CrmCompany" | "CrmContact";
  entityId: string;
  changes: Record<string, unknown>;
}) {
  return db.auditLog
    .create({
      data: {
        userId: entry.userId,
        action: "CRM_PURGE",
        entityType: entry.entityType,
        entityId: entry.entityId,
        changes: entry.changes as Prisma.InputJsonValue,
      },
    })
    .catch((err: unknown) => {
      apiLogger.error({
        msg: "crm-purge:audit-failed",
        entityId: entry.entityId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
}

interface PurgeCtx {
  organizationId: string;
  userId: string | null;
}

// ── Single-record purges ─────────────────────────────────────────────────────

export async function purgeDeal(input: PurgeCtx & { dealId: string }): Promise<{ ok: true } | Fail> {
  const deal = await db.crmDeal.findFirst({
    where: { id: input.dealId, organizationId: input.organizationId },
    include: { _count: { select: { contacts: true, products: true, notes: true, tasks: true } } },
  });
  if (!deal) return reject("DEAL_NOT_FOUND", "Deal not found", { organizationId: input.organizationId, dealId: input.dealId });
  if (!deal.archivedAt) {
    return reject("NOT_ARCHIVED", "Only archived deals can be permanently deleted — archive it first", { dealId: input.dealId });
  }

  try {
    await db.$transaction([
      // The record's History is unreachable once the record is gone; the audit
      // snapshot below is the durable trace.
      db.crmActivity.deleteMany({ where: { organizationId: input.organizationId, entityType: "DEAL", entityId: deal.id } }),
      // Cascades: CrmDealContact, CrmDealProduct, CrmNote.dealId, CrmTask.dealId.
      db.crmDeal.delete({ where: { id: deal.id } }),
    ]);
  } catch (err) {
    apiLogger.error({ msg: "crm-purge:deal-failed", dealId: deal.id, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "UNKNOWN", message: "Could not delete the deal" };
  }

  void writeAudit({
    userId: input.userId,
    entityType: "CrmDeal",
    entityId: deal.id,
    changes: {
      name: deal.name,
      status: deal.status,
      dealValue: deal.dealValue ? Number(deal.dealValue) : null,
      currency: deal.currency,
      eventId: deal.eventId,
      companyId: deal.companyId,
      ownerId: deal.ownerId,
      archivedAt: deal.archivedAt.toISOString(),
      cascaded: deal._count, // people links / line items / notes / tasks deleted with it
    },
  });
  apiLogger.info({ msg: "crm-purge:deal-purged", dealId: deal.id, organizationId: input.organizationId, userId: input.userId });
  return { ok: true };
}

export async function purgeCompany(input: PurgeCtx & { companyId: string }): Promise<{ ok: true } | Fail> {
  const company = await db.crmCompany.findFirst({
    where: { id: input.companyId, organizationId: input.organizationId },
    include: { _count: { select: { deals: true, contacts: true, notes_: true, tasks: true } } },
  });
  if (!company) return reject("COMPANY_NOT_FOUND", "Company not found", { organizationId: input.organizationId, companyId: input.companyId });
  if (!company.archivedAt) {
    return reject("NOT_ARCHIVED", "Only archived companies can be permanently deleted — archive it first", { companyId: input.companyId });
  }
  // The FK is Restrict — a friendly refusal instead of a raw P2003. Counts ALL
  // deals (active or archived): a deal is revenue history and pins its account.
  if (company._count.deals > 0) {
    return {
      ...reject(
        "COMPANY_HAS_DEALS",
        `${company._count.deals} deal(s) still reference this company — purge (or re-point) them first`,
        { companyId: input.companyId, dealCount: company._count.deals },
      ),
      meta: { dealCount: company._count.deals },
    };
  }

  try {
    await db.$transaction([
      db.crmActivity.deleteMany({ where: { organizationId: input.organizationId, entityType: "COMPANY", entityId: company.id } }),
      // Cascades notes + tasks; CrmContact.companyId is SetNull (contacts survive).
      db.crmCompany.delete({ where: { id: company.id } }),
    ]);
  } catch (err) {
    // A deal re-pointed here between the count and the delete → Restrict P2003.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      return reject("COMPANY_HAS_DEALS", "A deal was linked to this company — reload and try again", { companyId: company.id });
    }
    apiLogger.error({ msg: "crm-purge:company-failed", companyId: company.id, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "UNKNOWN", message: "Could not delete the company" };
  }

  void writeAudit({
    userId: input.userId,
    entityType: "CrmCompany",
    entityId: company.id,
    changes: {
      name: company.name,
      industry: company.industry,
      website: company.website,
      country: company.country,
      city: company.city,
      archivedAt: company.archivedAt.toISOString(),
      cascaded: { notes: company._count.notes_, tasks: company._count.tasks, contactsUnlinked: company._count.contacts },
    },
  });
  apiLogger.info({ msg: "crm-purge:company-purged", companyId: company.id, organizationId: input.organizationId, userId: input.userId });
  return { ok: true };
}

export async function purgeCrmContact(input: PurgeCtx & { crmContactId: string }): Promise<{ ok: true } | Fail> {
  const contact = await db.crmContact.findFirst({
    where: { id: input.crmContactId, organizationId: input.organizationId },
    include: { _count: { select: { deals: true, crmNotes: true, tasks: true } } },
  });
  if (!contact) return reject("CONTACT_NOT_FOUND", "Contact not found", { organizationId: input.organizationId, crmContactId: input.crmContactId });
  if (!contact.archivedAt) {
    return reject("NOT_ARCHIVED", "Only archived contacts can be permanently deleted — archive it first", { crmContactId: input.crmContactId });
  }

  try {
    await db.$transaction([
      db.crmActivity.deleteMany({ where: { organizationId: input.organizationId, entityType: "CONTACT", entityId: contact.id } }),
      // Cascades deal links (they vanish from any deal's people list), notes, tasks.
      db.crmContact.delete({ where: { id: contact.id } }),
    ]);
  } catch (err) {
    apiLogger.error({ msg: "crm-purge:contact-failed", crmContactId: contact.id, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "UNKNOWN", message: "Could not delete the contact" };
  }

  void writeAudit({
    userId: input.userId,
    entityType: "CrmContact",
    entityId: contact.id,
    changes: {
      name: `${contact.firstName} ${contact.lastName}`.trim(),
      email: contact.emailKey,
      companyId: contact.companyId,
      archivedAt: contact.archivedAt.toISOString(),
      cascaded: { dealLinks: contact._count.deals, notes: contact._count.crmNotes, tasks: contact._count.tasks },
    },
  });
  apiLogger.info({ msg: "crm-purge:contact-purged", crmContactId: contact.id, organizationId: input.organizationId, userId: input.userId });
  return { ok: true };
}

// ── Bulk: purge the whole archive ────────────────────────────────────────────

export type PurgeArchivedEntity = "deals" | "companies" | "contacts" | "all";

export interface PurgeArchivedReport {
  ok: true;
  purged: { deals: number; companies: number; contacts: number };
  /** Records that could not be purged, with the reason — never a silent skip. */
  skipped: Array<{ entity: "deal" | "company" | "contact"; id: string; name: string; reason: string }>;
  /** True when the per-entity cap bound — re-run to continue (no silent caps). */
  capped: boolean;
}

/** Per-entity per-call ceiling — a runaway backstop, not an expected limit. */
const PURGE_BATCH_CAP = 500;

/**
 * Purge every archived record of the requested kind(s). Runs deals FIRST so a
 * company whose only deals were archived becomes deletable in the same pass
 * (the deal→company FK is Restrict). Each record goes through the same
 * single-record purge as the per-record endpoint — one implementation, one
 * audit shape.
 */
export async function purgeArchived(
  input: PurgeCtx & { entity: PurgeArchivedEntity },
): Promise<PurgeArchivedReport | Fail> {
  const report: PurgeArchivedReport = {
    ok: true,
    purged: { deals: 0, companies: 0, contacts: 0 },
    skipped: [],
    capped: false,
  };
  const wants = (e: Exclude<PurgeArchivedEntity, "all">) => input.entity === "all" || input.entity === e;

  try {
    if (wants("deals")) {
      const rows = await db.crmDeal.findMany({
        where: { organizationId: input.organizationId, archivedAt: { not: null } },
        select: { id: true, name: true },
        orderBy: { archivedAt: "asc" },
        take: PURGE_BATCH_CAP + 1,
      });
      if (rows.length > PURGE_BATCH_CAP) report.capped = true;
      for (const row of rows.slice(0, PURGE_BATCH_CAP)) {
        const res = await purgeDeal({ ...input, dealId: row.id });
        if (res.ok) report.purged.deals++;
        else report.skipped.push({ entity: "deal", id: row.id, name: row.name, reason: res.message });
      }
    }

    if (wants("companies")) {
      const rows = await db.crmCompany.findMany({
        where: { organizationId: input.organizationId, archivedAt: { not: null } },
        select: { id: true, name: true },
        orderBy: { archivedAt: "asc" },
        take: PURGE_BATCH_CAP + 1,
      });
      if (rows.length > PURGE_BATCH_CAP) report.capped = true;
      for (const row of rows.slice(0, PURGE_BATCH_CAP)) {
        const res = await purgeCompany({ ...input, companyId: row.id });
        if (res.ok) report.purged.companies++;
        else report.skipped.push({ entity: "company", id: row.id, name: row.name, reason: res.message });
      }
    }

    if (wants("contacts")) {
      const rows = await db.crmContact.findMany({
        where: { organizationId: input.organizationId, archivedAt: { not: null } },
        select: { id: true, firstName: true, lastName: true },
        orderBy: { archivedAt: "asc" },
        take: PURGE_BATCH_CAP + 1,
      });
      if (rows.length > PURGE_BATCH_CAP) report.capped = true;
      for (const row of rows.slice(0, PURGE_BATCH_CAP)) {
        const res = await purgeCrmContact({ ...input, crmContactId: row.id });
        if (res.ok) report.purged.contacts++;
        else
          report.skipped.push({
            entity: "contact",
            id: row.id,
            name: `${row.firstName} ${row.lastName}`.trim(),
            reason: res.message,
          });
      }
    }
  } catch (err) {
    apiLogger.error({
      msg: "crm-purge:bulk-failed",
      organizationId: input.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "The purge stopped partway — re-run to continue" };
  }

  apiLogger.info({
    msg: "crm-purge:bulk-done",
    organizationId: input.organizationId,
    userId: input.userId,
    entity: input.entity,
    ...report.purged,
    skipped: report.skipped.length,
    capped: report.capped,
  });
  return report;
}
