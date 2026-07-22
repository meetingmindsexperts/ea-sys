/**
 * Deal documents — the sponsorship prospectus + supporting files.
 *
 * Pins: (1) the one-prospectus-per-deal replace transaction, (2) org/deal
 * binding on every lookup (a foreign id is a 404, never a write), (3) the
 * archived-deal freeze, (4) History rows on add/remove.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const tx = {
  crmDealDocument: {
    findFirst: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
  },
};

vi.mock("@/lib/db", () => ({
  db: {
    crmDeal: { findFirst: vi.fn() },
    crmDealDocument: { findFirst: vi.fn(), delete: vi.fn() },
    crmActivity: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  },
}));

import { db } from "@/lib/db";
import { addDealDocument, removeDealDocument } from "@/crm/services/deal-document-service";

const ORG = "org-1";
const base = { organizationId: ORG, userId: "u-1", source: "rest" as const };
const filePart = {
  url: "/uploads/crm-deal-docs/d-1/abc.pdf",
  filename: "BRIDGES-2026-prospectus.pdf",
  label: null,
  mimeType: "application/pdf",
  size: 123_456,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.crmActivity.create).mockResolvedValue({} as never);
  vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", name: "Abbott Gold", archivedAt: null } as never);
  tx.crmDealDocument.findFirst.mockResolvedValue(null);
  tx.crmDealDocument.create.mockResolvedValue({ id: "doc-1" });
});

describe("addDealDocument", () => {
  it("refuses a deal outside the caller's org (IDOR — the lookup is org-bound)", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue(null as never);

    const res = await addDealDocument({ ...base, dealId: "other-orgs-deal", kind: "OTHER", ...filePart });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("DEAL_NOT_FOUND");
    expect(db.crmDeal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "other-orgs-deal", organizationId: ORG } }),
    );
    expect(tx.crmDealDocument.create).not.toHaveBeenCalled();
  });

  it("an archived deal is frozen — no new documents", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", name: "x", archivedAt: new Date() } as never);

    const res = await addDealDocument({ ...base, dealId: "d-1", kind: "PROSPECTUS", ...filePart });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("DEAL_ARCHIVED");
  });

  it("OTHER documents stack — no replace lookup runs", async () => {
    const res = await addDealDocument({ ...base, dealId: "d-1", kind: "OTHER", ...filePart });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.replacedUrl).toBeNull();
    expect(tx.crmDealDocument.findFirst).not.toHaveBeenCalled();
    expect(db.crmActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "DOCUMENT_ADDED", entityId: "d-1" }) }),
    );
  });

  it("a new PROSPECTUS REPLACES the previous one inside the transaction", async () => {
    tx.crmDealDocument.findFirst.mockResolvedValue({ id: "old-doc", url: "/uploads/crm-deal-docs/d-1/old.pdf" });

    const res = await addDealDocument({ ...base, dealId: "d-1", kind: "PROSPECTUS", ...filePart });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    // The old row is deleted and its file path reported so the route can unlink it.
    expect(tx.crmDealDocument.delete).toHaveBeenCalledWith({ where: { id: "old-doc" } });
    expect(res.replacedUrl).toBe("/uploads/crm-deal-docs/d-1/old.pdf");
    const created = tx.crmDealDocument.create.mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(created.kind).toBe("PROSPECTUS");
    expect(created.organizationId).toBe(ORG);
  });
});

describe("removeDealDocument", () => {
  it("binds the document through BOTH the deal and the org — a foreign id never deletes", async () => {
    vi.mocked(db.crmDealDocument.findFirst).mockResolvedValue(null as never);

    const res = await removeDealDocument({ ...base, dealId: "d-1", documentId: "someone-elses-doc" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("DOCUMENT_NOT_FOUND");
    expect(db.crmDealDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "someone-elses-doc", dealId: "d-1", organizationId: ORG },
      }),
    );
    expect(db.crmDealDocument.delete).not.toHaveBeenCalled();
  });

  it("removes and reports the file path + records the History row", async () => {
    vi.mocked(db.crmDealDocument.findFirst).mockResolvedValue({
      id: "doc-1", url: "/uploads/crm-deal-docs/d-1/abc.pdf", filename: "prospectus.pdf", kind: "PROSPECTUS",
    } as never);
    vi.mocked(db.crmDealDocument.delete).mockResolvedValue({} as never);

    const res = await removeDealDocument({ ...base, dealId: "d-1", documentId: "doc-1" });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.removedUrl).toBe("/uploads/crm-deal-docs/d-1/abc.pdf");
    expect(db.crmActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "DOCUMENT_REMOVED", entityId: "d-1" }) }),
    );
  });
});
