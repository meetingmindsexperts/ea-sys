/**
 * CRM quote generation — deal products → numbered PDF stored as a deal document.
 *
 * Pins: lines come from the deal's PRODUCTS (none → refused), ONE currency only
 * (mixed → refused, never fudged into one symbol), org-bound deal lookup,
 * archived freeze, org-sequential numbering, and the QUOTE_GENERATED History row.
 * The PDF itself renders through real pdfkit (no snapshot — just "it produced
 * bytes and a %PDF header").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// File writes go to a scratch-safe void — the service's disk layout is not
// under test, the row/number/guard logic is.
vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error("no logo")),
  },
}));

const tx = {
  crmQuoteCounter: {
    upsert: vi.fn().mockResolvedValue({}),
    findUniqueOrThrow: vi.fn().mockResolvedValue({ lastNumber: 7 }),
  },
};

vi.mock("@/lib/db", () => ({
  db: {
    crmDeal: { findFirst: vi.fn() },
    crmDealDocument: { create: vi.fn() },
    crmActivity: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  },
}));

import fs from "fs/promises";
import { db } from "@/lib/db";
import { generateDealQuote } from "@/crm/services/crm-quote-service";

const ORG = "org-1";
const base = {
  organizationId: ORG,
  userId: "u-1",
  source: "rest" as const,
  dealId: "d-1",
  validityDays: 30,
};

const healthyDeal = {
  id: "d-1",
  name: "Abbott — BRIDGES Gold",
  archivedAt: null,
  company: { name: "Abbott", city: "Dubai", country: "UAE" },
  event: { name: "BRIDGES 2026" },
  products: [
    { productName: "Gold sponsorship", category: "Sponsorship", unitPrice: "40000", currency: "USD", quantity: 1 },
    { productName: "Symposium slot", category: "Content", unitPrice: "5000", currency: "USD", quantity: 2 },
  ],
  contacts: [{ crmContact: { firstName: "Sara", lastName: "Khan" } }],
  org: {
    name: "Meeting Minds", logo: null, companyName: "Meeting Minds FZ LLC",
    companyAddress: "DSC Tower", companyCity: "Dubai", companyState: null,
    companyZipCode: null, companyCountry: "UAE", taxId: "1003",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.crmActivity.create).mockResolvedValue({} as never);
  vi.mocked(db.crmDeal.findFirst).mockResolvedValue(healthyDeal as never);
  vi.mocked(db.crmDealDocument.create).mockResolvedValue({ id: "doc-1" } as never);
  tx.crmQuoteCounter.upsert.mockResolvedValue({});
  tx.crmQuoteCounter.findUniqueOrThrow.mockResolvedValue({ lastNumber: 7 });
});

describe("generateDealQuote", () => {
  it("refuses a deal outside the caller's org (IDOR — the lookup is org-bound)", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue(null as never);

    const res = await generateDealQuote({ ...base, dealId: "other-orgs-deal" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("DEAL_NOT_FOUND");
    expect(db.crmDeal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "other-orgs-deal", organizationId: ORG } }),
    );
  });

  it("an archived deal is frozen", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ ...healthyDeal, archivedAt: new Date() } as never);

    const res = await generateDealQuote(base);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("DEAL_ARCHIVED");
  });

  it("no products → refused (the Products card IS the itemization)", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ ...healthyDeal, products: [] } as never);

    const res = await generateDealQuote(base);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("NO_PRODUCTS");
    // No number is burned on a refused generation.
    expect(tx.crmQuoteCounter.upsert).not.toHaveBeenCalled();
  });

  it("mixed currencies → refused, never fudged into one symbol", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({
      ...healthyDeal,
      products: [
        { productName: "A", category: "X", unitPrice: "100", currency: "USD", quantity: 1 },
        { productName: "B", category: "X", unitPrice: "100", currency: "AED", quantity: 1 },
      ],
    } as never);

    const res = await generateDealQuote(base);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("MIXED_CURRENCIES");
    expect(tx.crmQuoteCounter.upsert).not.toHaveBeenCalled();
  });

  it("mints the org-sequential number, writes the PDF, stores a QUOTE document + History row", async () => {
    const res = await generateDealQuote(base);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.quoteNumber).toBe("Q-0007");

    // The counter is claimed atomically (upsert increment inside the tx).
    expect(tx.crmQuoteCounter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG } }),
    );

    // Real PDF bytes hit the disk.
    const written = vi.mocked(fs.writeFile).mock.calls[0]![1] as Buffer;
    expect(written.subarray(0, 5).toString()).toBe("%PDF-");

    const row = vi.mocked(db.crmDealDocument.create).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(row.kind).toBe("QUOTE");
    expect(row.filename).toBe("Q-0007.pdf");
    expect(row.organizationId).toBe(ORG);

    expect(db.crmActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "QUOTE_GENERATED", entityId: "d-1" }),
      }),
    );
  });

  it("unlinks the written file when the row create fails (no orphaned PDFs)", async () => {
    vi.mocked(db.crmDealDocument.create).mockRejectedValue(new Error("db down") as never);

    const res = await generateDealQuote(base);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("UNKNOWN");
    expect(fs.unlink).toHaveBeenCalled();
  });
});
