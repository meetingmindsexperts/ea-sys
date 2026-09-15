/**
 * CRM saved quotes: draft, create, edit, list, delete.
 *
 * Pins: the org-bound deal and quote lookups; a price pre-fills only in the same
 * currency (no conversion); yearly numbers from the atomic sequence; stored
 * totals; the optimistic lock (a stale version or a lost claim is a conflict,
 * never an overwrite); a product link is dropped unless it is this org's; files
 * are never orphaned (a failed save removes the new PDF, a successful edit
 * removes the old one); and the History rows.
 *
 * The PDF renders through real pdfkit; file writes go to a mocked fs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Named and default exports: storage.ts imports fs/promises dynamically and
// destructures NAMED members.
const { fsMock } = vi.hoisted(() => ({
  fsMock: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error("no logo")),
    // Identity realpath keeps storage's REAL containment guard running.
    realpath: vi.fn(async (p: string) => p),
  },
}));
vi.mock("fs/promises", () => ({ default: fsMock, ...fsMock }));

const { tx, dbMock } = vi.hoisted(() => {
  const tx = {
    crmQuoteSequence: { upsert: vi.fn() },
    crmDealDocument: { create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    crmQuote: { create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn() },
    crmQuoteLine: { deleteMany: vi.fn(), createMany: vi.fn() },
  };
  const dbMock = {
    crmDeal: { findFirst: vi.fn() },
    crmQuote: { findFirst: vi.fn(), findMany: vi.fn() },
    crmProduct: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    crmActivity: { create: vi.fn() },
  };
  return { tx, dbMock };
});

vi.mock("@/lib/db", () => ({
  db: dbMock,
  tenantTransaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
}));

const { updateOrganizationSettings } = vi.hoisted(() => ({
  updateOrganizationSettings: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/event-settings", () => ({ updateOrganizationSettings }));

// crm-route's auth chain reaches next-auth, which does not load under vitest;
// only its redactForCaller is used here.
vi.mock("@/lib/api-auth", () => ({ getOrgContext: vi.fn() }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordImport: vi.fn(), recordExport: vi.fn() }));
import { redactForCaller } from "@/crm/lib/crm-route";

import {
  archiveDealQuote,
  createDealQuote,
  getDealQuoteDraft,
  listDealQuotes,
  updateDealQuote,
} from "@/crm/services/crm-quote-service";
import { DEFAULT_QUOTE_TERMS, quoteYear, type QuoteInput } from "@/crm/lib/quote-rules";

const ORG = "org-1";
const actor = { organizationId: ORG, userId: "u-1", source: "rest" as const };

const healthyDeal = {
  id: "d-1",
  name: "Abbott Diamond",
  archivedAt: null,
  currency: "USD",
  company: { name: "Abbott", city: "Dubai", country: "UAE" },
  event: { name: "Middle East Heart Failure Conference 2026", code: "MEHFC 2026", taxRate: "5", taxLabel: "VAT" },
  products: [
    { productName: "Sponsorship - Diamond", sku: "SPO10001", unitPrice: "95000", currency: "USD", quantity: 1, crmProductId: "p-1" },
    { productName: "Exhibition booth", sku: "EXH-1", unitPrice: "20000", currency: "AED", quantity: 1, crmProductId: "p-2" },
  ],
  contacts: [{ crmContact: { firstName: "Sara", lastName: "Khan" } }],
  org: {
    name: "Meeting Minds",
    logo: null,
    companyName: "Meeting Minds - FZ LLC",
    companyAddress: "Dubai Studio City 508/509",
    companyCity: "Dubai",
    companyState: null,
    companyZipCode: "502464",
    companyCountry: null,
    taxId: "100352048100003",
    settings: {},
  },
};

const input: QuoteInput = {
  title: "Abbott Quote - MEHFC 2026",
  currency: "USD",
  quoteDate: "2026-09-15",
  validUntil: "2026-10-15",
  preparedFor: "Abbott",
  attention: "Sara Khan",
  taxRate: 5,
  taxLabel: "VAT",
  terms: "Terms text",
  notes: null,
  lines: [
    { productCode: "SPO10001", name: "Sponsorship - Diamond", description: "Diamond tier", quantity: 1, unitPrice: 95000, crmProductId: "p-1" },
  ],
};

function savedQuote(overrides: Record<string, unknown> = {}) {
  return {
    id: "q-1",
    number: "Q-2026-0003",
    title: "Abbott Quote - MEHFC 2026",
    currency: "USD",
    quoteDate: new Date("2026-09-15T00:00:00.000Z"),
    validUntil: new Date("2026-10-15T00:00:00.000Z"),
    preparedFor: "Abbott",
    attention: "Sara Khan",
    preparedByName: "Atiqur Rahman",
    taxRate: "5",
    taxLabel: "VAT",
    subtotal: "95000",
    taxAmount: "4750",
    total: "99750",
    terms: "Terms text",
    notes: null,
    version: 1,
    documentId: "doc-1",
    createdAt: new Date("2026-09-15T08:00:00.000Z"),
    updatedAt: new Date("2026-09-15T08:00:00.000Z"),
    lines: [
      { id: "l-1", productCode: "SPO10001", name: "Sponsorship - Diamond", description: "Diamond tier", quantity: 1, unitPrice: "95000", amount: "95000", crmProductId: "p-1" },
    ],
    ...overrides,
  };
}

const OLD_URL = "/uploads/crm-deal-docs/d-1/old.pdf";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.crmActivity.create.mockResolvedValue({});
  dbMock.crmDeal.findFirst.mockResolvedValue(healthyDeal);
  dbMock.user.findUnique.mockResolvedValue({ firstName: "Atiqur", lastName: "Rahman" });
  dbMock.crmProduct.findMany.mockResolvedValue([{ id: "p-1" }]);
  dbMock.crmQuote.findFirst.mockResolvedValue({ ...savedQuote(), archivedAt: null, document: { id: "doc-1", url: OLD_URL } });
  dbMock.crmQuote.findMany.mockResolvedValue([savedQuote()]);
  tx.crmQuoteSequence.upsert.mockResolvedValue({ lastNumber: 3 });
  tx.crmDealDocument.create.mockResolvedValue({ id: "doc-1" });
  tx.crmDealDocument.updateMany.mockResolvedValue({ count: 1 });
  tx.crmDealDocument.deleteMany.mockResolvedValue({ count: 1 });
  tx.crmQuote.create.mockResolvedValue(savedQuote());
  tx.crmQuote.updateMany.mockResolvedValue({ count: 1 });
  tx.crmQuote.findFirstOrThrow.mockResolvedValue(savedQuote({ version: 2, title: "Abbott Quote - revised" }));
  tx.crmQuoteLine.deleteMany.mockResolvedValue({ count: 1 });
  tx.crmQuoteLine.createMany.mockResolvedValue({ count: 1 });
});

describe("getDealQuoteDraft", () => {
  it("builds the draft from the org-bound deal: title, recipient, event tax and default terms", async () => {
    const res = await getDealQuoteDraft({ organizationId: ORG, userId: "u-1", dealId: "d-1" });

    expect(dbMock.crmDeal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "d-1", organizationId: ORG } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.draft).toMatchObject({
      title: "Abbott Quote - MEHFC 2026",
      currency: "USD",
      preparedFor: "Abbott",
      attention: "Sara Khan",
      preparedByName: "Atiqur Rahman",
      taxRate: 5,
      taxLabel: "VAT",
      terms: DEFAULT_QUOTE_TERMS,
    });
  });

  it("pre-fills a price only when the product is in the quote's currency, never a conversion", async () => {
    const res = await getDealQuoteDraft({ organizationId: ORG, userId: "u-1", dealId: "d-1" });
    if (!res.ok) throw new Error("unreachable");

    expect(res.draft.lines[0]).toMatchObject({ productCode: "SPO10001", unitPrice: 95000, productCurrency: "USD", cataloguePrice: 95000 });
    // The AED price is carried in AED so the editor can fill it if the rep switches to AED.
    expect(res.draft.lines[1]).toMatchObject({ productCode: "EXH-1", unitPrice: null, productCurrency: "AED", cataloguePrice: 20000 });
  });

  it("uses the org's saved default terms over the built-in wording", async () => {
    dbMock.crmDeal.findFirst.mockResolvedValue({
      ...healthyDeal,
      org: { ...healthyDeal.org, settings: { crmQuote: { terms: "Org terms" } } },
    });
    const res = await getDealQuoteDraft({ organizationId: ORG, userId: "u-1", dealId: "d-1" });
    if (!res.ok) throw new Error("unreachable");
    expect(res.draft.terms).toBe("Org terms");
  });

  it("starts with no terms when an admin saved the default terms empty, instead of the built-in wording", async () => {
    dbMock.crmDeal.findFirst.mockResolvedValue({
      ...healthyDeal,
      org: { ...healthyDeal.org, settings: { crmQuote: { terms: null } } },
    });
    const res = await getDealQuoteDraft({ organizationId: ORG, userId: "u-1", dealId: "d-1" });
    if (!res.ok) throw new Error("unreachable");
    expect(res.draft.terms).toBeNull();
  });

  it("falls back to USD when the deal carries a currency the editor does not offer", async () => {
    dbMock.crmDeal.findFirst.mockResolvedValue({ ...healthyDeal, currency: "JPY" });
    const res = await getDealQuoteDraft({ organizationId: ORG, userId: "u-1", dealId: "d-1" });
    if (!res.ok) throw new Error("unreachable");
    expect(res.draft.currency).toBe("USD");
  });
});

describe("createDealQuote", () => {
  it("refuses a deal outside the caller's org and burns no number", async () => {
    dbMock.crmDeal.findFirst.mockResolvedValue(null);
    const res = await createDealQuote({ ...actor, dealId: "other", input });

    expect(res).toMatchObject({ ok: false, code: "DEAL_NOT_FOUND" });
    expect(tx.crmQuoteSequence.upsert).not.toHaveBeenCalled();
  });

  it("refuses an archived deal", async () => {
    dbMock.crmDeal.findFirst.mockResolvedValue({ ...healthyDeal, archivedAt: new Date() });
    const res = await createDealQuote({ ...actor, dealId: "d-1", input });
    expect(res).toMatchObject({ ok: false, code: "DEAL_ARCHIVED" });
  });

  it("mints a yearly number, renders the PDF, and stores the quote, its lines and totals with its document", async () => {
    const res = await createDealQuote({ ...actor, dealId: "d-1", input });

    expect(res.ok).toBe(true);
    const year = quoteYear();
    expect(tx.crmQuoteSequence.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId_year: { organizationId: ORG, year } } }),
    );

    const written = fsMock.writeFile.mock.calls[0]![1] as Buffer;
    expect(written.subarray(0, 5).toString()).toBe("%PDF-");

    const doc = tx.crmDealDocument.create.mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(doc).toMatchObject({ kind: "QUOTE", organizationId: ORG, filename: `Q-${year}-0003.pdf` });

    const quote = tx.crmQuote.create.mock.calls[0]![0]!.data as Record<string, unknown> & {
      lines: { create: Record<string, unknown>[] };
    };
    expect(quote).toMatchObject({
      organizationId: ORG,
      number: `Q-${year}-0003`,
      year,
      sequence: 3,
      currency: "USD",
      subtotal: 95000,
      taxRate: 5,
      taxAmount: 4750,
      total: 99750,
      preparedByName: "Atiqur Rahman",
      documentId: "doc-1",
    });
    expect(quote.lines.create[0]).toMatchObject({ organizationId: ORG, amount: 95000, sortOrder: 0, crmProductId: "p-1" });

    expect(dbMock.crmActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "QUOTE_GENERATED", entityId: "d-1" }) }),
    );
  });

  // Review H1 (Sep 15 2026): the activity feed runs only redactForCaller, which
  // strips by key NAME, so the History payload must carry money only under keys
  // the redaction knows. These run the payload the service actually wrote.
  describe("History rows and the money redaction", () => {
    const MEMBER_CTX = { organizationId: ORG, userId: "u-m", role: "MEMBER", fromApiKey: false } as never;
    const STAFF_CTX = { organizationId: ORG, userId: "u-s", role: "ORGANIZER", fromApiKey: false } as never;

    function recordedChanges(): Record<string, unknown> {
      const call = dbMock.crmActivity.create.mock.calls.at(-1)![0] as { data: { changes: Record<string, unknown> } };
      return call.data.changes;
    }

    it("a MEMBER reading the feed cannot see the total of a created quote", async () => {
      await createDealQuote({ ...actor, dealId: "d-1", input });
      const changes = recordedChanges();

      expect(changes).toMatchObject({ quoteNumber: expect.any(String), quoteTotal: 99750 });
      expect(changes).not.toHaveProperty("total");
      expect(JSON.stringify(redactForCaller(changes, MEMBER_CTX))).not.toContain("99750");
      expect(redactForCaller(changes, STAFF_CTX)).toMatchObject({ quoteTotal: 99750 });
    });

    it("a MEMBER reading the feed cannot see an edit's total or tax rate diff", async () => {
      tx.crmQuote.findFirstOrThrow.mockResolvedValue(savedQuote({ version: 2, total: "126000", taxRate: "7.5" }));
      await updateDealQuote({ ...actor, dealId: "d-1", quoteId: "q-1", expectedVersion: 1, input });
      const changes = recordedChanges() as { changes: Record<string, unknown> };

      expect(changes.changes).toMatchObject({ quoteTotal: { from: 99750, to: 126000 } });
      const redacted = JSON.stringify(redactForCaller(changes, MEMBER_CTX));
      expect(redacted).not.toContain("126000");
      expect(redacted).not.toContain("99750");
      expect(redacted).not.toContain("7.5");
    });
  });

  it("drops a product link that is not this org's rather than linking across tenants", async () => {
    dbMock.crmProduct.findMany.mockResolvedValue([]);
    await createDealQuote({ ...actor, dealId: "d-1", input });

    const quote = tx.crmQuote.create.mock.calls[0]![0]!.data as { lines: { create: Record<string, unknown>[] } };
    expect(dbMock.crmProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["p-1"] }, organizationId: ORG } }),
    );
    expect(quote.lines.create[0]!.crmProductId).toBeNull();
  });

  it("removes the uploaded PDF when the rows fail to save", async () => {
    tx.crmQuote.create.mockRejectedValue(new Error("db down"));
    const res = await createDealQuote({ ...actor, dealId: "d-1", input });

    expect(res).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(fsMock.unlink).toHaveBeenCalled();
  });

  it("refuses a total larger than the columns hold, before minting a number", async () => {
    const res = await createDealQuote({
      ...actor,
      dealId: "d-1",
      input: { ...input, lines: [{ name: "Huge", quantity: 100000, unitPrice: 9_999_999 }] },
    });
    expect(res).toMatchObject({ ok: false, code: "QUOTE_TOTAL_TOO_LARGE" });
    expect(tx.crmQuoteSequence.upsert).not.toHaveBeenCalled();
  });

  it("saves the terms as the org default by merging into the existing settings block", async () => {
    await createDealQuote({ ...actor, dealId: "d-1", input, saveTermsAsDefault: true });

    expect(updateOrganizationSettings).toHaveBeenCalledWith(ORG, expect.any(Function));
    const patch = updateOrganizationSettings.mock.calls[0]![1] as (cur: Record<string, unknown>) => Record<string, unknown>;
    expect(patch({ crmQuote: { keep: 1 }, other: true })).toEqual({
      crmQuote: { keep: 1, terms: "Terms text" },
      other: true,
    });
  });
});

describe("updateDealQuote", () => {
  const edit = { ...actor, dealId: "d-1", quoteId: "q-1", expectedVersion: 1, input: { ...input, title: "Abbott Quote - revised" } };

  it("finds the quote through the deal and the org", async () => {
    await updateDealQuote(edit);
    expect(dbMock.crmQuote.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "q-1", dealId: "d-1", organizationId: ORG } }),
    );
  });

  it("refuses a stale version without rendering or writing anything", async () => {
    dbMock.crmQuote.findFirst.mockResolvedValue({ ...savedQuote({ version: 4 }), archivedAt: null, document: null });
    const res = await updateDealQuote(edit);

    expect(res).toMatchObject({ ok: false, code: "STALE_WRITE" });
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(tx.crmQuote.updateMany).not.toHaveBeenCalled();
  });

  it("treats a lost version claim as a conflict and removes the PDF it had just uploaded", async () => {
    tx.crmQuote.updateMany.mockResolvedValue({ count: 0 });
    const res = await updateDealQuote(edit);

    expect(res).toMatchObject({ ok: false, code: "STALE_WRITE" });
    expect(tx.crmQuoteLine.deleteMany).not.toHaveBeenCalled();
    expect(fsMock.unlink).toHaveBeenCalledTimes(1);
  });

  it("keeps the number, replaces the lines and the PDF file, removes the old file and records the edit", async () => {
    const res = await updateDealQuote(edit);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.quote.number).toBe("Q-2026-0003");
    expect(res.quote.version).toBe(2);

    expect(tx.crmQuote.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "q-1", organizationId: ORG, version: 1, archivedAt: null },
        data: expect.objectContaining({ title: "Abbott Quote - revised", version: { increment: 1 } }),
      }),
    );
    expect(tx.crmQuoteLine.deleteMany).toHaveBeenCalledWith({ where: { quoteId: "q-1", organizationId: ORG } });
    const created = tx.crmQuoteLine.createMany.mock.calls[0]![0]!.data as Record<string, unknown>[];
    expect(created[0]).toMatchObject({ quoteId: "q-1", organizationId: ORG, amount: 95000 });
    expect(tx.crmDealDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "doc-1", organizationId: ORG } }),
    );

    const unlinked = fsMock.unlink.mock.calls.map((c) => String(c[0]));
    expect(unlinked.some((p) => p.endsWith("old.pdf"))).toBe(true);

    expect(dbMock.crmActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "QUOTE_UPDATED" }) }),
    );
  });

  it("mints a new document when the quote's document row was removed meanwhile, so the new PDF is never orphaned (review L2)", async () => {
    tx.crmDealDocument.updateMany.mockResolvedValue({ count: 0 });
    const res = await updateDealQuote(edit);

    expect(res.ok).toBe(true);
    expect(tx.crmDealDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: "QUOTE", dealId: "d-1", organizationId: ORG }) }),
    );
    expect(tx.crmQuote.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "q-1", organizationId: ORG }, data: { documentId: "doc-1" } }),
    );
  });

  it("refuses to edit a deleted quote", async () => {
    dbMock.crmQuote.findFirst.mockResolvedValue({ ...savedQuote(), archivedAt: new Date(), document: null });
    const res = await updateDealQuote(edit);
    expect(res).toMatchObject({ ok: false, code: "QUOTE_ARCHIVED" });
  });

  it("returns not found for a quote outside the org", async () => {
    dbMock.crmQuote.findFirst.mockResolvedValue(null);
    const res = await updateDealQuote(edit);
    expect(res).toMatchObject({ ok: false, code: "QUOTE_NOT_FOUND" });
  });
});

describe("listDealQuotes and archiveDealQuote", () => {
  it("lists only live quotes, bound to the org", async () => {
    const res = await listDealQuotes({ organizationId: ORG, dealId: "d-1" });

    expect(res.ok).toBe(true);
    expect(dbMock.crmQuote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { dealId: "d-1", organizationId: ORG, archivedAt: null } }),
    );
    if (!res.ok) throw new Error("unreachable");
    expect(res.quotes[0]).toMatchObject({ number: "Q-2026-0003", total: 99750, quoteDate: "2026-09-15" });
  });

  it("archives the quote, deletes its document row and hands back the file to unlink", async () => {
    tx.crmQuote.findFirst.mockResolvedValue({ document: { id: "doc-1", url: OLD_URL } });
    const res = await archiveDealQuote({ ...actor, dealId: "d-1", quoteId: "q-1" });

    expect(res).toEqual({ ok: true, removedUrl: OLD_URL });
    expect(tx.crmQuote.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "q-1", organizationId: ORG, archivedAt: null } }),
    );
    expect(tx.crmQuote.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "q-1", organizationId: ORG }, data: { documentId: null } }),
    );
    expect(tx.crmDealDocument.deleteMany).toHaveBeenCalledWith({ where: { id: "doc-1", organizationId: ORG } });
    expect(dbMock.crmActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "QUOTE_ARCHIVED" }) }),
    );
  });

  it("removes the file the quote holds once claimed, not the one read before the claim (review L1)", async () => {
    // An edit committed between the first read and the claim: the document row
    // now points at the edit's new file, and the edit has deleted the old one.
    tx.crmQuote.findFirst.mockResolvedValue({ document: { id: "doc-1", url: "/uploads/crm-deal-docs/d-1/new.pdf" } });
    const res = await archiveDealQuote({ ...actor, dealId: "d-1", quoteId: "q-1" });

    expect(res).toEqual({ ok: true, removedUrl: "/uploads/crm-deal-docs/d-1/new.pdf" });
  });

  it("records nothing and removes nothing when a concurrent delete won the claim (review L1)", async () => {
    tx.crmQuote.updateMany.mockResolvedValue({ count: 0 });
    const res = await archiveDealQuote({ ...actor, dealId: "d-1", quoteId: "q-1" });

    expect(res).toEqual({ ok: true, removedUrl: null });
    expect(tx.crmDealDocument.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.crmActivity.create).not.toHaveBeenCalled();
  });

  it("is a no-op on an already deleted quote", async () => {
    dbMock.crmQuote.findFirst.mockResolvedValue({ id: "q-1", number: "Q-2026-0003", archivedAt: new Date(), document: null });
    const res = await archiveDealQuote({ ...actor, dealId: "d-1", quoteId: "q-1" });

    expect(res).toEqual({ ok: true, removedUrl: null });
    expect(tx.crmQuote.updateMany).not.toHaveBeenCalled();
  });
});
