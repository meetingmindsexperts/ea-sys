/**
 * The export and the two import routes through the REAL guard with the
 * services and the audit helpers mocked: the flag turns them into 404s, any
 * org staff member exports (audited, as CSV with the BOM and a filename),
 * only an admin imports products, a propose-grant holder imports suppliers
 * as Proposed while a settle holder imports them approved, and an
 * unreadable file is a logged 400 rather than a silent zero-row import.
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
const productSvc = vi.hoisted(() => ({ importBudgetProducts: vi.fn() }));
vi.mock("@/procurement/services/budget-product-service", () => productSvc);
const supplierSvc = vi.hoisted(() => ({ importSuppliers: vi.fn() }));
vi.mock("@/procurement/services/supplier-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/procurement/services/supplier-service")>();
  return { ...real, ...supplierSvc };
});

import { GET as exportGet } from "@/app/api/procurement/budgets/[budgetId]/export/route";
import { POST as importProducts } from "@/app/api/procurement/products/import/route";
import { POST as importSuppliers } from "@/app/api/procurement/suppliers/import/route";

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

beforeEach(() => {
  process.env.PROCUREMENT_MODULE_ENABLED = "true";
  vi.clearAllMocks();
  budgetSvc.getBudget.mockResolvedValue({ ok: true, budget });
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
    expect(audit.recordExport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ entityType: "EventBudget", rowCount: 1, format: "csv", organizationId: ORG, userId: "u1", role: "MEMBER", filters: expect.objectContaining({ budgetId: "b1", eventCode: "HM2026", versionNo: 2 }) }));
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
  it("needs the request or settle grant; staff without one are refused", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    expect((await importSuppliers(post("/api/procurement/suppliers/import", { csv }))).status).toBe(403);
    expect(supplierSvc.importSuppliers).not.toHaveBeenCalled();
  });
  it("a request-grant holder imports as Proposed; a settle holder imports approved", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementRequest: true }));
    const res = await importSuppliers(post("/api/procurement/suppliers/import", { csv }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ totalProcessed: 2, created: 1, skipped: 1, skippedDetails: ["Row 3: code ACME already exists (Acme)"], approved: false, errors: [] });
    expect(supplierSvc.importSuppliers).toHaveBeenCalledWith(expect.objectContaining({ approveOnCreate: false, rows: [expect.objectContaining({ legalName: "Gulf AV", code: "GULFAV", currency: "AED" }), expect.objectContaining({ legalName: "Acme", code: "ACME" })] }));
    expect(audit.recordImport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ entityType: "Supplier", totalProcessed: 2, created: 1, skipped: 1, errors: 0 }));

    authMock.mockResolvedValue(user({ role: "MEMBER", procurementSettle: true }));
    const res2 = await importSuppliers(post("/api/procurement/suppliers/import", { csv }));
    expect((await res2.json()).approved).toBe(true);
    expect(supplierSvc.importSuppliers).toHaveBeenLastCalledWith(expect.objectContaining({ approveOnCreate: true }));
  });
  it("reports the service's failure as a logged 500 that names what already stands", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementSettle: true }));
    supplierSvc.importSuppliers.mockRejectedValue(new Error("db down"));
    const res = await importSuppliers(post("/api/procurement/suppliers/import", { csv }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "IMPORT_FAILED" });
  });
});
