/**
 * Deal documents — the sponsorship prospectus + supporting files a deal holds.
 *
 * The service owns the ROW lifecycle (org-bound deal check, the one-prospectus
 * replace transaction, the History record); the route owns the FILE (formData,
 * magic bytes, disk write) and unlinks whatever this service reports replaced.
 *
 * PROSPECTUS is one-per-deal: a new upload replaces the previous row inside the
 * transaction, with the partial-unique SQL index as the race backstop (the
 * SpeakerDocument signed-agreement pattern).
 */
import type { CrmDealDocumentKind } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordCrmActivity } from "@/crm/lib/crm-activity";

export const DEAL_DOCUMENT_SELECT = {
  id: true,
  kind: true,
  url: true,
  filename: true,
  label: true,
  mimeType: true,
  size: true,
  createdAt: true,
  uploadedBy: { select: { firstName: true, lastName: true } },
} as const;

type Fail = { ok: false; code: "DEAL_NOT_FOUND" | "DEAL_ARCHIVED" | "DOCUMENT_NOT_FOUND" | "UNKNOWN"; message: string };

interface Ctx {
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
}

async function loadDeal(organizationId: string, dealId: string) {
  return db.crmDeal.findFirst({
    where: { id: dealId, organizationId },
    select: { id: true, name: true, archivedAt: true },
  });
}

export async function addDealDocument(
  input: Ctx & {
    dealId: string;
    kind: CrmDealDocumentKind;
    url: string;
    filename: string;
    label: string | null;
    mimeType: string;
    size: number;
  },
): Promise<
  | { ok: true; document: Record<string, unknown> & { id: string }; replacedUrl: string | null }
  | Fail
> {
  try {
    const deal = await loadDeal(input.organizationId, input.dealId);
    if (!deal) {
      apiLogger.warn({ msg: "crm-deal-doc:deal-not-found", dealId: input.dealId, organizationId: input.organizationId });
      return { ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" };
    }
    // An archived deal is frozen — restore before attaching files.
    if (deal.archivedAt) {
      apiLogger.warn({ msg: "crm-deal-doc:deal-archived", dealId: input.dealId });
      return { ok: false, code: "DEAL_ARCHIVED", message: "This deal was archived — restore it before adding documents" };
    }

    const { document, replacedUrl } = await db.$transaction(async (tx) => {
      let replaced: string | null = null;
      if (input.kind === "PROSPECTUS") {
        const previous = await tx.crmDealDocument.findFirst({
          where: { dealId: input.dealId, kind: "PROSPECTUS" },
          select: { id: true, url: true },
        });
        if (previous) {
          replaced = previous.url;
          await tx.crmDealDocument.delete({ where: { id: previous.id } });
        }
      }
      const created = await tx.crmDealDocument.create({
        data: {
          organizationId: input.organizationId,
          dealId: input.dealId,
          kind: input.kind,
          url: input.url,
          filename: input.filename,
          label: input.label,
          mimeType: input.mimeType,
          size: input.size,
          uploadedById: input.userId,
        },
        select: DEAL_DOCUMENT_SELECT,
      });
      return { document: created, replacedUrl: replaced };
    });

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "DEAL",
      entityId: input.dealId,
      action: "DOCUMENT_ADDED",
      actorId: input.userId,
      changes: {
        source: input.source,
        kind: input.kind,
        filename: input.filename,
        ...(replacedUrl ? { replacedPrevious: true } : {}),
      },
    });

    apiLogger.info({
      msg: "crm-deal-doc:added",
      dealId: input.dealId,
      documentId: document.id,
      kind: input.kind,
      replaced: !!replacedUrl,
      source: input.source,
    });
    return { ok: true, document, replacedUrl };
  } catch (err) {
    apiLogger.error({
      msg: "crm-deal-doc:add-failed",
      dealId: input.dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not save the document" };
  }
}

export async function removeDealDocument(
  input: Ctx & { dealId: string; documentId: string },
): Promise<{ ok: true; removedUrl: string } | Fail> {
  try {
    // Bound through BOTH the deal and the org — a foreign documentId against
    // your own dealId (or vice versa) is a 404, never a delete.
    const doc = await db.crmDealDocument.findFirst({
      where: { id: input.documentId, dealId: input.dealId, organizationId: input.organizationId },
      select: { id: true, url: true, filename: true, kind: true },
    });
    if (!doc) {
      apiLogger.warn({ msg: "crm-deal-doc:remove-not-found", dealId: input.dealId, documentId: input.documentId, organizationId: input.organizationId });
      return { ok: false, code: "DOCUMENT_NOT_FOUND", message: "Document not found" };
    }

    await db.crmDealDocument.delete({ where: { id: doc.id } });

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "DEAL",
      entityId: input.dealId,
      action: "DOCUMENT_REMOVED",
      actorId: input.userId,
      changes: { source: input.source, kind: doc.kind, filename: doc.filename },
    });

    apiLogger.info({ msg: "crm-deal-doc:removed", dealId: input.dealId, documentId: doc.id, source: input.source });
    return { ok: true, removedUrl: doc.url };
  } catch (err) {
    apiLogger.error({
      msg: "crm-deal-doc:remove-failed",
      dealId: input.dealId,
      documentId: input.documentId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not remove the document" };
  }
}
