/**
 * The export and the two import routes through the REAL guard with the
 * services and the audit helpers mocked: the flag turns them into 404s, any
 * org staff member exports (audited, as CSV with the BOM and a filename),
 * only an admin imports products, only ADMIN / SUPER_ADMIN import or export
 * suppliers (by role, since Sep 24 2026; a grant no longer admits), an
 * admin's import lands Proposed unless they also hold the settle grant, and
 * an unreadable file is a logged 400 rather than a silent zero-row import.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "127.0.0.1" }));
vi.mock("@/lib/db", () => ({ db: {}, tenantTransaction: vi.fn() }));

const audit = vi.hoisted(() => ({ recordExport: vi.fn(), recordImport: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/audit-data-transfer", () => audit);

const budgetSvc = vi.hoisted(() => ({ getBudget: vi.fn() }));
vi.mock("@/procurement/services/budget-service", () => budgetSvc);
const revenueSvc = vi.hoisted(() => ({ getBudgetRevenue: vi.fn() }));
vi.mock("@/procurement/services/budget-revenue-service", () => revenueSvc);
const productSvc = vi.hoisted(() => ({ importBudgetProducts: vi.fn() }));
vi.mock("@/procurement/services/budget-product-service", () => productSvc);
const supplierSvc = vi.hoisted(() => ({ importSuppliers: vi.fn(), listSuppliersForExport: vi.fn() }));
vi.mock("@/procurement/services/supplier-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/procurement/services/supplier-service")>();
  return { ...real, ...supplierSvc };
});

import { GET as exportGet } from "@/app/api/procurement/budgets/[budgetId]/export/route";
import { POST as importProducts } from "@/app/api/procurement/products/import/route";
import { POST as importSuppliers } from "@/app/api/procurement/suppliers/import/route";
import { GET as exportSuppliers } from "@/app/api/procurement/suppliers/export/route";

const ORG = "org-1";
const user = (over: Record<string, unknown>) => ({ user: { id: "u1", organizationId: ORG, role: "MEMBER", ...over } });
const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const exportReq = () => new NextRequest("http://localhost/api/procurement/budgets/b1/export");
const params = { params: Promise.resolve({ budgetId: "b1" }) };

const budget = {
  id: "b1", eventCode: "HM2026", versionNo: 2, status: "DRAFT", reportingCurrency: "AED", contingencyPercent: "10", contingencyAmount: "0.0000",
  plannedExpenseTotal: "0.0000", taxTotalPlanned: "0.0000", forecastTotal: "0.0000", expectedAttendance: null, recordedAttendance: null, atRisk: false,
  naCategoryCodes: [], event: { name: "HM" }, lines: [
    { lineKey: "k1", category: { code: "AV", name: "AV" }, product: null, description: "LED", qty: "1", unitCost: "1", transactionCurrency: "AED", fxRateToReporting: "1", planned: "1", taxRatePercent: null, taxAmountPlanned: "0", approvedPlanned: null, committedOpen: "0", committedTotal: "0", actual: "0", paid: "0", remaining: "1", forecast: "1", forecastReason: null, varianceNote: null, notes: null, isContingency: false, sortOrder: 1 },
  ],
};

const revenue = {
  lines: [], accounts: [{ code: "430005", name: "In-House Delegate Sales", planned: "1000.0000", actual: "250.0000" }],
  actuals: { notItemised: "0.0000", noAccount: { amount: "0.0000", products: [] }, notConverted: [], total: "250.0000", paidRegistrations: 1, wonDeals: 0 },
  margin: { plannedRevenue: "1000.0000", plannedCost: "0.0000", plannedMargin: "1000.0000", plannedMarginPercent: "100.00", forecastRevenue: "1000.0000", forecastCost: "0.0000", forecastMargin: "1000.0000", forecastMarginPercent: "100.00", belowTarget: false },
  targetMarginPercent: null,
};

beforeEach(() => {
  process.env.PROCUREMENT_MODULE_ENABLED = "true";
  vi.clearAllMocks();
  budgetSvc.getBudget.mockResolvedValue({ ok: true, budget });
  revenueSvc.getBudgetRevenue.mockResolvedValue({ ok: true, value: revenue });
  productSvc.importBudgetProducts.mockResolvedValue({ created: 1, updated: 2, unchanged: 3, errors: ["Row 9: service said no"] });
  supplierSvc.importSuppliers.mockResolvedValue({ created: 1, skipped: [{ rowNum: 3, reason: "code ACME already exists (Acme)" }], errors: [] });
});
afterEach(() => {
  delete process.env.PROCUREMENT_MODULE_ENABLED;
});

describe("GET /api/procurement/budgets/[budgetId]/export", () => {
  it("is a 404 while the module is off", async () => {
    delete process.env.PROCUREMENT_MODULE_ENABLED;
    authMock.mockResolvedValue(user({ role: "SUPER_ADMIN" }));
    expect((await exportGet(exportReq(), params)).status).toBe(404);
    expect(budgetSvc.getBudget).not.toHaveBeenCalled();
  });
  it("streams the CSV to org staff with the BOM, a filename and an audit row", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    const res = await exportGet(exportReq(), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="budget-HM2026-v2.csv"');
    // Response.text() strips a leading byte-order mark by spec, so read the bytes.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const body = new TextDecoder().decode(bytes);
    expect(body).toContain("Event,HM2026");
    expect(body).toContain("AV,AV,,LED,");
    expect(budgetSvc.getBudget).toHaveBeenCalledWith(ORG, "b1");
    expect(audit.recordExport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ entityType: "EventBudget", rowCount: 1, format: "csv", organizationId: ORG, userId: "u1", role: "MEMBER", filters: expect.objectContaining({ budgetId: "b1", eventCode: "HM2026", versionNo: 2, revenue: "included" }) }));
  });
  it("adds revenue and margin for a caller with finance sight, read for the same budget", async () => {
    authMock.mockResolvedValue(user({ role: "ORGANIZER" }));
    const body = await (await exportGet(exportReq(), params)).text();
    expect(revenueSvc.getBudgetRevenue).toHaveBeenCalledWith(ORG, "b1");
    expect(body).toContain("430005,In-House Delegate Sales,1000.00,250.00,-750.00");
    expect(body).toContain("Margin %,100.00,100.00");
  });
  it("leaves revenue out, and says so, for a procurement reader without finance sight", async () => {
    authMock.mockResolvedValue(user({ role: "CRM_USER", procurementPermissions: ["procurement.budgets.view"] }));
    const res = await exportGet(exportReq(), params);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(revenueSvc.getBudgetRevenue).not.toHaveBeenCalled();
    expect(body).toContain("Revenue,Not included: revenue and margin need finance access");
    expect(body).not.toContain("430005");
    expect(audit.recordExport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ filters: expect.objectContaining({ revenue: "omitted" }) }));
  });
  it("maps a revenue read that fails for a found budget to its status, and records no export", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    revenueSvc.getBudgetRevenue.mockResolvedValue({ ok: false, code: "BUDGET_NOT_FOUND", message: "nope" });
    expect((await exportGet(exportReq(), params)).status).toBe(404);
    expect(audit.recordExport).not.toHaveBeenCalled();
  });
  it("refuses an org-null caller and maps an unknown budget to 404", async () => {
    authMock.mockResolvedValue({ user: { id: "u2", organizationId: null, role: "REGISTRANT" } });
    expect((await exportGet(exportReq(), params)).status).toBe(403);
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    budgetSvc.getBudget.mockResolvedValue({ ok: false, code: "BUDGET_NOT_FOUND", message: "nope" });
    expect((await exportGet(exportReq(), params)).status).toBe(404);
    expect(audit.recordExport).not.toHaveBeenCalled();
  });
});

describe("POST /api/procurement/products/import", () => {
  const csv = "sku,name,category,active\n510399,LED wall,AV,\n";
  it("is admin-only", async () => {
    authMock.mockResolvedValue(user({ role: "ORGANIZER" }));
    expect((await importProducts(post("/api/procurement/products/import", { csv }))).status).toBe(403);
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementSettle: true }));
    expect((await importProducts(post("/api/procurement/products/import", { csv }))).status).toBe(403);
    expect(productSvc.importBudgetProducts).not.toHaveBeenCalled();
  });
  it("hands the parsed rows to the service, merges its errors with the file's and audits the counts", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    const res = await importProducts(post("/api/procurement/products/import", { csv: csv + "bad sku!,X,AV,\n" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ totalProcessed: 2, created: 1, updated: 2, unchanged: 3 });
    expect(body.errors).toEqual([expect.stringMatching(/^Row 3: SKU "bad sku!"/), "Row 9: service said no"]);
    expect(productSvc.importBudgetProducts).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, actorUserId: "u1", source: "ui", rows: [{ rowNum: 2, sku: "510399", name: "LED wall", categoryCode: "AV", active: true }] }));
    expect(audit.recordImport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ entityType: "BudgetProduct", totalProcessed: 2, created: 1, updated: 2, skipped: 3, errors: 2, organizationId: ORG, role: "ADMIN" }));
  });
  it("is a logged 400 for a file that cannot be read, and for a missing body", async () => {
    authMock.mockResolvedValue(user({ role: "SUPER_ADMIN" }));
    const res = await importProducts(post("/api/procurement/products/import", { csv: "sku,category\n1,x\n" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_CSV", error: "Missing column: name." });
    expect((await importProducts(post("/api/procurement/products/import", {}))).status).toBe(400);
    expect(productSvc.importBudgetProducts).not.toHaveBeenCalled();
    expect(audit.recordImport).not.toHaveBeenCalled();
  });
});

describe("POST /api/procurement/suppliers/import", () => {
  const csv = "legalName,code\nGulf AV,GULFAV\nAcme,ACME\n";
  it("is ADMIN / SUPER_ADMIN only: a request or settle grant no longer admits", async () => {
    for (const grant of [{ procurementRequest: true }, { procurementSettle: true }, { procurementPermissions: ["procurement.suppliers.propose", "procurement.catalogue.manage"] }]) {
      authMock.mockResolvedValue(user({ role: "MEMBER", ...grant }));
      expect((await importSuppliers(post("/api/procurement/suppliers/import", { csv }))).status).toBe(403);
    }
    authMock.mockResolvedValue(user({ role: "ORGANIZER", procurementSettle: true }));
    expect((await importSuppliers(post("/api/procurement/suppliers/import", { csv }))).status).toBe(403);
    expect(supplierSvc.importSuppliers).not.toHaveBeenCalled();
  });
  it("an admin imports as Proposed; an admin who also holds the settle grant imports approved", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    const res = await importSuppliers(post("/api/procurement/suppliers/import", { csv }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ totalProcessed: 2, created: 1, skipped: 1, skippedDetails: ["Row 3: code ACME already exists (Acme)"], approved: false, errors: [] });
    expect(supplierSvc.importSuppliers).toHaveBeenCalledWith(expect.objectContaining({ approveOnCreate: false, rows: [expect.objectContaining({ legalName: "Gulf AV", code: "GULFAV", currency: "AED" }), expect.objectContaining({ legalName: "Acme", code: "ACME" })] }));
    expect(audit.recordImport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ entityType: "Supplier", totalProcessed: 2, created: 1, skipped: 1, errors: 0 }));

    authMock.mockResolvedValue(user({ role: "SUPER_ADMIN", procurementSettle: true }));
    const res2 = await importSuppliers(post("/api/procurement/suppliers/import", { csv }));
    expect((await res2.json()).approved).toBe(true);
    expect(supplierSvc.importSuppliers).toHaveBeenLastCalledWith(expect.objectContaining({ approveOnCreate: true }));
  });
  it("reports the service's failure as a logged 500 that names what already stands", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    supplierSvc.importSuppliers.mockRejectedValue(new Error("db down"));
    const res = await importSuppliers(post("/api/procurement/suppliers/import", { csv }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "IMPORT_FAILED" });
  });
});

describe("GET /api/procurement/suppliers/export", () => {
  const exportReq = () => new NextRequest("http://localhost/api/procurement/suppliers/export");
  const rows = [
    { code: "ACME", legalName: "Acme Trading LLC", displayName: "Acme", country: "AE", currency: "AED", taxRegistrationNo: "100200300400500", paymentTerms: "30 days", contacts: [{ name: "Amal", email: "amal@acme.example" }], notes: null, approvalStatus: "APPROVED", isActive: true },
  ];
  beforeEach(() => supplierSvc.listSuppliersForExport.mockResolvedValue(rows));

  it("is a 404 while the module is off", async () => {
    delete process.env.PROCUREMENT_MODULE_ENABLED;
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    expect((await exportSuppliers(exportReq())).status).toBe(404);
  });
  it("refuses everyone but ADMIN / SUPER_ADMIN, whatever grant they hold, and reads nothing", async () => {
    for (const u of [{ role: "MEMBER", procurementSettle: true }, { role: "ORGANIZER", procurementRequest: true }, { role: "MEMBER", procurementPermissions: ["procurement.suppliers.financials.view"] }]) {
      authMock.mockResolvedValue(user(u));
      expect((await exportSuppliers(exportReq())).status).toBe(403);
    }
    expect(supplierSvc.listSuppliersForExport).not.toHaveBeenCalled();
  });
  it("streams the CSV to an admin with the BOM, a dated filename and an audit row saying bank details were excluded", async () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"]) {
      vi.clearAllMocks();
      supplierSvc.listSuppliersForExport.mockResolvedValue(rows);
      authMock.mockResolvedValue(user({ role }));
      const res = await exportSuppliers(exportReq());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/csv");
      expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="suppliers-\d{4}-\d{2}-\d{2}\.csv"/);
      // Response.text() strips a leading byte-order mark by spec, so read the bytes.
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
      expect(new TextDecoder().decode(bytes)).toContain("ACME");
      expect(supplierSvc.listSuppliersForExport).toHaveBeenCalledWith(ORG);
      expect(audit.recordExport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ entityType: "Supplier", rowCount: 1, format: "csv", filters: expect.objectContaining({ bankDetails: "excluded" }) }));
    }
  });
});
