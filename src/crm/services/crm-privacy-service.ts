/**
 * A CRM contact's data on request: EXPORT everything held on one person, or
 * ERASE it (Nov 6, 2026; CRM product review P1-9). SERVER ONLY.
 *
 * WHY THIS IS NOT THE PURGE. crm-purge-service deletes an ARCHIVED contact for
 * housekeeping and deliberately KEEPS their correspondence (email threads are
 * SetNull "so the history survives"). An erasure request is the opposite
 * promise: nothing identifying the person stays. So erasure also removes every
 * email thread with them (matched by link OR by address, since a captured
 * thread may never have been linked), the messages and attachment files on
 * those threads, their notes and tasks, their deal links and their own History.
 * It does not require the contact to be archived first.
 *
 * WHAT STAYS, ON PURPOSE:
 *   - deals, accounts and quotes: they are the organisation's commercial
 *     records, not the person's. A quote PDF addressed to them by name is a
 *     sent document; removing it is a separate decision, so the export lists
 *     those quotes and the erasure reports how many name them.
 *   - one AuditLog row, CRM_CONTACT_ERASED, written in the erasure's own
 *     transaction: the contact id and the counts, never a name or address.
 *   - deal History lines that mention the person by name (CONTACT_ADDED and the
 *     like). Their wording is not structured enough to scrub safely; the count
 *     of such lines is reported so they can be reviewed.
 *
 * Errors as values; runs inside the caller's tenant lane; never imports
 * next/server (services/README.md).
 */
import { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { crmStorage } from "@/crm/integrations/storage";

type Fail = { ok: false; code: "CONTACT_NOT_FOUND" | "CONFIRMATION_MISMATCH" | "UNKNOWN"; message: string };

interface Ctx {
  organizationId: string;
  crmContactId: string;
}

/** Threads with this person: linked to the contact, or with their address as the counterparty. */
function threadWhere(organizationId: string, contact: { id: string; email: string }): Prisma.CrmEmailThreadWhereInput {
  return {
    organizationId,
    OR: [{ crmContactId: contact.id }, { counterpartyEmail: { equals: contact.email, mode: "insensitive" } }],
  };
}

async function findContact(ctx: Ctx) {
  return db.crmContact.findFirst({ where: { id: ctx.crmContactId, organizationId: ctx.organizationId } });
}

function notFound(ctx: Ctx): Fail {
  apiLogger.warn({ msg: "crm-privacy:contact-not-found", organizationId: ctx.organizationId, crmContactId: ctx.crmContactId });
  return { ok: false, code: "CONTACT_NOT_FOUND", message: "Contact not found" };
}

/** Attachment metadata as stored on a message: an array of { filename, size, mimeType, path }. */
function attachmentList(value: Prisma.JsonValue | null): { filename: string; size: number; mimeType: string; path: string }[] {
  if (!Array.isArray(value)) return [];
  return value.filter((a): a is { filename: string; size: number; mimeType: string; path: string } =>
    !!a && typeof a === "object" && typeof (a as { path?: unknown }).path === "string",
  );
}

export interface CrmContactExport {
  exportedAt: string;
  contact: Record<string, unknown>;
  company: { id: string; name: string } | null;
  deals: { dealId: string; dealName: string; role: string | null }[];
  notes: { id: string; activityType: string; body: string; createdAt: string }[];
  tasks: { id: string; title: string; description: string | null; status: string; dueAt: string | null; createdAt: string }[];
  emailThreads: {
    id: string;
    subject: string;
    counterpartyEmail: string;
    counterpartyName: string | null;
    messages: { direction: string; fromEmail: string; fromName: string | null; subject: string | null; textBody: string | null; sentAt: string; attachments: { filename: string; size: number; mimeType: string }[] }[];
  }[];
  history: { action: string; changes: unknown; createdAt: string }[];
  /** Quotes on their deals that may name them as "prepared for" / "attention": listed, not exported. */
  quotesOnTheirDeals: { number: string; dealId: string; preparedFor: string | null; attention: string | null }[];
}

/** Everything held on one CRM contact, as one JSON document. */
export async function exportCrmContactData(ctx: Ctx): Promise<{ ok: true; data: CrmContactExport } | Fail> {
  try {
    const contact = await findContact(ctx);
    if (!contact) return notFound(ctx);

    const [company, dealLinks, notes, tasks, threads, history] = await Promise.all([
      contact.companyId ? db.crmCompany.findFirst({ where: { id: contact.companyId, organizationId: ctx.organizationId }, select: { id: true, name: true } }) : null,
      db.crmDealContact.findMany({ where: { crmContactId: contact.id }, select: { role: true, deal: { select: { id: true, name: true } } } }),
      db.crmNote.findMany({ where: { organizationId: ctx.organizationId, crmContactId: contact.id }, select: { id: true, activityType: true, body: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
      db.crmTask.findMany({ where: { organizationId: ctx.organizationId, crmContactId: contact.id }, select: { id: true, title: true, description: true, status: true, dueAt: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
      db.crmEmailThread.findMany({
        where: threadWhere(ctx.organizationId, contact),
        select: {
          id: true,
          subject: true,
          counterpartyEmail: true,
          counterpartyName: true,
          messages: { select: { direction: true, fromEmail: true, fromName: true, subject: true, textBody: true, createdAt: true, attachments: true }, orderBy: { createdAt: "asc" } },
        },
      }),
      db.crmActivity.findMany({ where: { organizationId: ctx.organizationId, entityType: "CONTACT", entityId: contact.id }, select: { action: true, changes: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
    ]);
    const dealIds = dealLinks.map((l) => l.deal.id);
    const quotes = dealIds.length
      ? await db.crmQuote.findMany({ where: { organizationId: ctx.organizationId, dealId: { in: dealIds } }, select: { number: true, dealId: true, preparedFor: true, attention: true } })
      : [];

    const { organizationId: _org, emailKey: _key, ...ownFields } = contact;
    void _org;
    void _key;
    const data: CrmContactExport = {
      exportedAt: new Date().toISOString(),
      contact: ownFields,
      company,
      deals: dealLinks.map((l) => ({ dealId: l.deal.id, dealName: l.deal.name, role: l.role ?? null })),
      notes: notes.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
      tasks: tasks.map((t) => ({ ...t, dueAt: t.dueAt?.toISOString() ?? null, createdAt: t.createdAt.toISOString() })),
      emailThreads: threads.map((t) => ({
        id: t.id,
        subject: t.subject,
        counterpartyEmail: t.counterpartyEmail,
        counterpartyName: t.counterpartyName,
        messages: t.messages.map((m) => ({
          direction: m.direction,
          fromEmail: m.fromEmail,
          fromName: m.fromName,
          subject: m.subject,
          textBody: m.textBody,
          sentAt: m.createdAt.toISOString(),
          attachments: attachmentList(m.attachments).map(({ filename, size, mimeType }) => ({ filename, size, mimeType })),
        })),
      })),
      history: history.map((h) => ({ action: h.action, changes: h.changes, createdAt: h.createdAt.toISOString() })),
      quotesOnTheirDeals: quotes,
    };
    apiLogger.info({ msg: "crm-privacy:exported", organizationId: ctx.organizationId, crmContactId: contact.id, threads: threads.length, notes: notes.length });
    return { ok: true, data };
  } catch (err) {
    apiLogger.error({ msg: "crm-privacy:export-failed", crmContactId: ctx.crmContactId, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "UNKNOWN", message: "Could not export the contact's data" };
  }
}

export interface CrmContactErasure {
  erased: {
    emailThreads: number;
    emailMessages: number;
    attachmentFiles: number;
    notes: number;
    tasks: number;
    dealLinks: number;
    historyLines: number;
  };
  /** Left in place on purpose, for a person to review (see the header). */
  remaining: { quotesOnTheirDeals: number; dealHistoryMentions: number };
}

/**
 * Erase one CRM contact and everything identifying them. `confirmEmail` must
 * equal the contact's address: an erasure cannot be undone, so the caller
 * proves they are erasing the person they think they are.
 */
export async function eraseCrmContact(
  ctx: Ctx & { userId: string | null; confirmEmail: string; source: "rest" | "mcp" | "agent" },
): Promise<{ ok: true; report: CrmContactErasure } | Fail> {
  try {
    const contact = await findContact(ctx);
    if (!contact) return notFound(ctx);
    if (ctx.confirmEmail.trim().toLowerCase() !== contact.email.trim().toLowerCase()) {
      apiLogger.warn({ msg: "crm-privacy:erase-confirmation-mismatch", crmContactId: contact.id });
      return { ok: false, code: "CONFIRMATION_MISMATCH", message: "Type the contact's email address exactly to confirm the erasure" };
    }

    const outcome = await tenantTransaction(async (tx) => {
      const threads = await tx.crmEmailThread.findMany({
        where: threadWhere(ctx.organizationId, contact),
        select: { id: true, messages: { select: { attachments: true } } },
      });
      const files = threads.flatMap((t) => t.messages.flatMap((m) => attachmentList(m.attachments).map((a) => a.path)));
      const messageCount = threads.reduce((n, t) => n + t.messages.length, 0);
      const threadIds = threads.map((t) => t.id);

      const [notes, tasks, dealLinks] = await Promise.all([
        tx.crmNote.count({ where: { organizationId: ctx.organizationId, crmContactId: contact.id } }),
        tx.crmTask.count({ where: { organizationId: ctx.organizationId, crmContactId: contact.id } }),
        tx.crmDealContact.findMany({ where: { crmContactId: contact.id }, select: { dealId: true } }),
      ]);
      const dealIds = dealLinks.map((l) => l.dealId);
      const [quotesOnTheirDeals, dealHistoryMentions] = dealIds.length
        ? await Promise.all([
            tx.crmQuote.count({ where: { organizationId: ctx.organizationId, dealId: { in: dealIds } } }),
            tx.crmActivity.count({ where: { organizationId: ctx.organizationId, entityType: "DEAL", entityId: { in: dealIds }, action: { in: ["CONTACT_ADDED", "CONTACT_REMOVED"] } } }),
          ])
        : [0, 0];

      // Messages go with their threads (onDelete: Cascade).
      if (threadIds.length) await tx.crmEmailThread.deleteMany({ where: { id: { in: threadIds }, organizationId: ctx.organizationId } });
      const history = await tx.crmActivity.deleteMany({ where: { organizationId: ctx.organizationId, entityType: "CONTACT", entityId: contact.id } });
      // Notes, tasks and deal links cascade from the contact.
      await tx.crmContact.deleteMany({ where: { id: contact.id, organizationId: ctx.organizationId } });

      const report: CrmContactErasure = {
        erased: {
          emailThreads: threadIds.length,
          emailMessages: messageCount,
          attachmentFiles: files.length,
          notes,
          tasks,
          dealLinks: dealLinks.length,
          historyLines: history.count,
        },
        remaining: { quotesOnTheirDeals, dealHistoryMentions },
      };
      // The only trace: who erased which record id, and how much. No name, no address.
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          action: "CRM_CONTACT_ERASED",
          entityType: "CrmContact",
          entityId: contact.id,
          changes: { source: ctx.source, ...report } as unknown as Prisma.InputJsonValue,
        },
      });
      return { report, files };
    });

    // The rows are gone; the files are now unreferenced. A file that will not
    // delete is logged with its path so it can be removed by hand.
    for (const path of outcome.files) {
      await crmStorage.remove("emailAttachment", path).catch((err) =>
        apiLogger.error({ msg: "crm-privacy:attachment-delete-failed", crmContactId: contact.id, path, err: err instanceof Error ? err.message : String(err) }),
      );
    }
    apiLogger.info({ msg: "crm-privacy:erased", organizationId: ctx.organizationId, crmContactId: contact.id, ...outcome.report.erased });
    return { ok: true, report: outcome.report };
  } catch (err) {
    apiLogger.error({ msg: "crm-privacy:erase-failed", crmContactId: ctx.crmContactId, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "UNKNOWN", message: "Could not erase the contact" };
  }
}
