/**
 * The supplier service with the db mocked: a derived code that collides gets
 * a suffix while an explicit one is refused, the decision is a conditional
 * claim that commits once, a stale edit is refused, and NO audit row ever
 * carries a tax number or bank details, only the field names.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  supplier: { create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
// Slice 3: an approved supplier converts the requests waiting on it; the conversion's own mechanics are pinned in commitment-service.test.ts.
const orderSvc = vi.hoisted(() => ({ convertRequestsAwaitingSupplier: vi.fn().mockResolvedValue({ issued: [], failed: [] }) }));
vi.mock("@/procurement/services/commitment-service", () => orderSvc);

import { decideSupplier, deriveSupplierCode, proposeSupplier, redactSupplier, updateSupplier, type SupplierRow } from "@/procurement/services/supplier-service";

const base = { organizationId: "org-1", actorUserId: "u1", source: "ui" as const };
const row = (over: Partial<SupplierRow> = {}): SupplierRow => ({
  id: "s1", code: "ACME", legalName: "Acme Events LLC", displayName: "Acme", taxRegistrationNo: "100200300400003", country: "AE", currency: "AED",
  contacts: [], paymentTerms: "30 days", bankDetails: { iban: "AE07 0331 2345 6789 0123 456" }, externalSystemType: null, externalVendorId: null,
  approvalStatus: "PROPOSED", riskStatus: "NONE", isActive: true, notes: null, proposedByUserId: "u9", decidedByUserId: null, decidedAt: null,
  decisionNote: null, version: 1, createdAt: new Date("2026-09-14T00:00:00Z"), updatedAt: new Date("2026-09-14T00:00:00Z"), ...over,
});
const auditJson = () => JSON.stringify(mockDb.auditLog.create.mock.calls.map((c) => c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("deriveSupplierCode + redaction", () => {
  it("derives an upper-case alphanumeric code, capped at 12", () => {
    expect(deriveSupplierCode("Acme Events & Co. LLC")).toBe("ACMEEVENTSCO");
    expect(deriveSupplierCode("!!!")).toBe("SUPPLIER");
  });
  it("redacts the two classified fields for a reader outside the boundary and says so", () => {
    const r = redactSupplier(row(), false);
    expect(r.taxRegistrationNo).toBeNull();
    expect(r.bankDetails).toBeNull();
    expect(r.financialsRedacted).toBe(true);
    expect(redactSupplier(row(), true)).toMatchObject({ taxRegistrationNo: "100200300400003", financialsRedacted: false });
  });
});

describe("proposeSupplier", () => {
  it("creates PROPOSED with a derived code, retrying with a suffix when the code is taken, and audits without the tax number", async () => {
    mockDb.supplier.create.mockRejectedValueOnce({ code: "P2002" }).mockResolvedValueOnce(row({ code: "ACME-2" }));
    const r = await proposeSupplier({ ...base, approveOnCreate: false, legalName: "Acme Events LLC", displayName: "Acme", currency: "aed", taxRegistrationNo: "100200300400003" });
    expect(r).toMatchObject({ ok: true, supplier: { code: "ACME-2" } });
    expect(mockDb.supplier.create.mock.calls[0][0].data).toMatchObject({ code: "ACME", approvalStatus: "PROPOSED", currency: "AED", proposedByUserId: "u1" });
    expect(mockDb.supplier.create.mock.calls[1][0].data).toMatchObject({ code: "ACME-2" });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ entityType: "Supplier", action: "PROPOSE" }) }));
    expect(auditJson()).not.toContain("100200300400003");
  });
  it("an explicit code that is taken is CODE_TAKEN, and a malformed one is refused before the db", async () => {
    mockDb.supplier.create.mockRejectedValue({ code: "P2002" });
    expect(await proposeSupplier({ ...base, approveOnCreate: false, code: "ACME", legalName: "Acme", currency: "AED" })).toMatchObject({ ok: false, code: "CODE_TAKEN" });
    expect(mockDb.supplier.create).toHaveBeenCalledTimes(1);
    expect(await proposeSupplier({ ...base, approveOnCreate: false, code: "bad code!", legalName: "Acme", currency: "AED" })).toMatchObject({ ok: false, code: "INVALID_CODE" });
  });
  it("the settle holder creates it approved, decided by themselves", async () => {
    mockDb.supplier.create.mockResolvedValue(row({ approvalStatus: "APPROVED" }));
    await proposeSupplier({ ...base, approveOnCreate: true, legalName: "Acme", currency: "AED" });
    expect(mockDb.supplier.create.mock.calls[0][0].data).toMatchObject({ approvalStatus: "APPROVED", decidedByUserId: "u1" });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.action).toBe("CREATE");
  });
});

describe("decideSupplier", () => {
  it("is a conditional claim on PROPOSED: the second decision loses with ALREADY_DECIDED", async () => {
    mockDb.supplier.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    mockDb.supplier.findFirst.mockResolvedValueOnce(row({ approvalStatus: "APPROVED" })).mockResolvedValueOnce({ approvalStatus: "APPROVED" });
    const first = await decideSupplier({ ...base, supplierId: "s1", decision: "APPROVED", note: "TRN checked" });
    expect(first).toMatchObject({ ok: true, supplier: { approvalStatus: "APPROVED" } });
    expect(mockDb.supplier.updateMany.mock.calls[0][0].where).toEqual({ id: "s1", organizationId: "org-1", approvalStatus: "PROPOSED" });
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "APPROVE", changes: expect.objectContaining({ note: "TRN checked" }) });
    const second = await decideSupplier({ ...base, supplierId: "s1", decision: "REJECTED" });
    expect(second).toMatchObject({ ok: false, code: "ALREADY_DECIDED", meta: { approvalStatus: "APPROVED" } });
  });
  it("an approval converts the requests waiting on the supplier after the decision committed; a rejection converts nothing", async () => {
    mockDb.supplier.updateMany.mockResolvedValue({ count: 1 });
    mockDb.supplier.findFirst.mockResolvedValue(row({ id: "s1", approvalStatus: "APPROVED" }));
    await decideSupplier({ ...base, supplierId: "s1", decision: "APPROVED" });
    expect(orderSvc.convertRequestsAwaitingSupplier).toHaveBeenCalledWith({ organizationId: base.organizationId, supplierId: "s1", actorUserId: base.actorUserId, source: base.source });
    await decideSupplier({ ...base, supplierId: "s1", decision: "REJECTED" });
    expect(orderSvc.convertRequestsAwaitingSupplier).toHaveBeenCalledTimes(1);
  });
  it("reports what the approval issued, failed to issue and failed to email, for the page to say", async () => {
    mockDb.supplier.updateMany.mockResolvedValue({ count: 1 });
    mockDb.supplier.findFirst.mockResolvedValue(row({ id: "s1", approvalStatus: "APPROVED" }));
    orderSvc.convertRequestsAwaitingSupplier.mockResolvedValueOnce({ issued: ["c1", "c2"], failed: ["srX"], sendFailed: 1 });
    expect(await decideSupplier({ ...base, supplierId: "s1", decision: "APPROVED" })).toMatchObject({ ok: true, conversion: { issued: 2, failed: 1, sendFailed: 1 } });
  });
  it("a foreign supplier is SUPPLIER_NOT_FOUND", async () => {
    mockDb.supplier.updateMany.mockResolvedValue({ count: 0 });
    mockDb.supplier.findFirst.mockResolvedValue(null);
    expect(await decideSupplier({ ...base, supplierId: "s-foreign", decision: "APPROVED" })).toMatchObject({ ok: false, code: "SUPPLIER_NOT_FOUND" });
  });
});

describe("updateSupplier", () => {
  it("writes bank details and the tax number but audits only their field names", async () => {
    mockDb.supplier.findFirst.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ version: 2, bankDetails: { iban: "AE99 NEW" } }));
    mockDb.supplier.updateMany.mockResolvedValue({ count: 1 });
    const r = await updateSupplier({ ...base, supplierId: "s1", expectedVersion: 1, bankDetails: { iban: "AE99 NEW" }, taxRegistrationNo: "999888777" });
    expect(r.ok).toBe(true);
    expect(mockDb.supplier.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "s1", organizationId: "org-1", version: 1 }, data: expect.objectContaining({ taxRegistrationNo: "999888777", version: { increment: 1 } }) });
    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit.changes.fields).toEqual(expect.arrayContaining(["bankDetails", "taxRegistrationNo"]));
    expect(auditJson()).not.toContain("AE99 NEW");
    expect(auditJson()).not.toContain("999888777");
  });
  it("a stale version is refused and names the current one", async () => {
    mockDb.supplier.findFirst.mockResolvedValue(row({ version: 3 }));
    mockDb.supplier.updateMany.mockResolvedValue({ count: 0 });
    expect(await updateSupplier({ ...base, supplierId: "s1", expectedVersion: 2, displayName: "Acme Ltd" })).toMatchObject({ ok: false, code: "STALE_WRITE", meta: { currentVersion: 3 } });
  });
  it("deactivation alone audits as DEACTIVATE", async () => {
    mockDb.supplier.findFirst.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ isActive: false, version: 2 }));
    mockDb.supplier.updateMany.mockResolvedValue({ count: 1 });
    await updateSupplier({ ...base, supplierId: "s1", expectedVersion: 1, isActive: false });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.action).toBe("DEACTIVATE");
  });
});
