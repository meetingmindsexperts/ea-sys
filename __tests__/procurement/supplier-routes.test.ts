/**
 * The supplier routes through the REAL guard with the service mocked: the
 * flag turns them into 404s; org staff read with the classified fields
 * redacted unless they sit inside the boundary; a request-grant holder
 * proposes, the settle holder creates approved and decides, and nobody else
 * writes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "127.0.0.1" }));
// The real service module is imported for its pure redaction helper; its db import must not load the real client.
vi.mock("@/lib/db", () => ({ db: {}, tenantTransaction: vi.fn() }));

const supplier = { id: "s1", code: "ACME", legalName: "Acme", displayName: "Acme", taxRegistrationNo: "TRN-1", country: "AE", currency: "AED", contacts: [], paymentTerms: null, bankDetails: { iban: "AE1" }, externalSystemType: null, externalVendorId: null, approvalStatus: "PROPOSED", riskStatus: "NONE", isActive: true, notes: null, proposedByUserId: "u9", decidedByUserId: null, decidedAt: null, decisionNote: null, version: 1, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" };
const svc = vi.hoisted(() => ({
  listSuppliers: vi.fn(),
  getSupplier: vi.fn(),
  proposeSupplier: vi.fn(),
  decideSupplier: vi.fn(),
  updateSupplier: vi.fn(),
}));
vi.mock("@/procurement/services/supplier-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/procurement/services/supplier-service")>();
  return { ...real, ...svc };
});

import { GET as listGet, POST as proposePost } from "@/app/api/procurement/suppliers/route";
import { GET as oneGet, PATCH as patchOne } from "@/app/api/procurement/suppliers/[supplierId]/route";
import { POST as decidePost } from "@/app/api/procurement/suppliers/[supplierId]/decide/route";

const ORG = "org-1";
const user = (over: Record<string, unknown>) => ({ user: { id: "u1", organizationId: ORG, role: "MEMBER", ...over } });
const params = { params: Promise.resolve({ supplierId: "s1" }) };
const req = (url: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${url}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });

beforeEach(() => {
  process.env.PROCUREMENT_MODULE_ENABLED = "true";
  vi.clearAllMocks();
  svc.listSuppliers.mockResolvedValue([supplier]);
  svc.getSupplier.mockResolvedValue({ ok: true, supplier });
  svc.proposeSupplier.mockResolvedValue({ ok: true, supplier });
  svc.decideSupplier.mockResolvedValue({ ok: true, supplier: { ...supplier, approvalStatus: "APPROVED" } });
  svc.updateSupplier.mockResolvedValue({ ok: true, supplier: { ...supplier, version: 2 } });
});
afterEach(() => {
  delete process.env.PROCUREMENT_MODULE_ENABLED;
});

describe("supplier routes: flag, reads and redaction", () => {
  it("is a 404 for everyone while the module is off", async () => {
    delete process.env.PROCUREMENT_MODULE_ENABLED;
    authMock.mockResolvedValue(user({ role: "SUPER_ADMIN" }));
    expect((await listGet(req("/api/procurement/suppliers"))).status).toBe(404);
  });
  it("a MEMBER without the settle grant reads the list with the classified fields redacted", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    const res = await listGet(req("/api/procurement/suppliers"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suppliers[0]).toMatchObject({ code: "ACME", taxRegistrationNo: null, bankDetails: null, financialsRedacted: true });
  });
  it("an ORGANIZER, and a MEMBER holding settle, read the classified fields", async () => {
    authMock.mockResolvedValue(user({ role: "ORGANIZER" }));
    expect((await (await oneGet(req("/api/procurement/suppliers/s1"), params)).json()).supplier).toMatchObject({ taxRegistrationNo: "TRN-1", financialsRedacted: false });
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementSettle: true }));
    expect((await (await oneGet(req("/api/procurement/suppliers/s1"), params)).json()).supplier).toMatchObject({ taxRegistrationNo: "TRN-1", financialsRedacted: false });
  });
  it("a bad status filter is a 400, never a wider list", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    expect((await listGet(req("/api/procurement/suppliers?status=NOPE"))).status).toBe(400);
    expect(svc.listSuppliers).not.toHaveBeenCalled();
    expect((await listGet(req("/api/procurement/suppliers?status=PROPOSED&includeInactive=1"))).status).toBe(200);
    expect(svc.listSuppliers).toHaveBeenCalledWith(ORG, { status: "PROPOSED", includeInactive: true });
  });
});

describe("supplier routes: who writes", () => {
  const body = { legalName: "Acme Events LLC", currency: "AED", taxRegistrationNo: "TRN-1" };
  it("a MEMBER with no grant, and an ORGANIZER with no grant, cannot propose", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    expect((await proposePost(req("/api/procurement/suppliers", "POST", body))).status).toBe(403);
    authMock.mockResolvedValue(user({ role: "ORGANIZER" }));
    expect((await proposePost(req("/api/procurement/suppliers", "POST", body))).status).toBe(403);
    expect(svc.proposeSupplier).not.toHaveBeenCalled();
  });
  it("a request-grant holder proposes (queue), the settle holder creates it approved", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementRequest: true }));
    const res = await proposePost(req("/api/procurement/suppliers", "POST", body));
    expect(res.status).toBe(201);
    expect(svc.proposeSupplier).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, actorUserId: "u1", approveOnCreate: false, legalName: "Acme Events LLC" }));
    // The proposer typed the tax number but reads it back redacted: they sit outside the boundary.
    expect((await res.json()).supplier).toMatchObject({ taxRegistrationNo: null, financialsRedacted: true });
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementSettle: true }));
    await proposePost(req("/api/procurement/suppliers", "POST", body));
    expect(svc.proposeSupplier).toHaveBeenLastCalledWith(expect.objectContaining({ approveOnCreate: true }));
  });
  it("the settle holder, a super admin or the final approver decides; only the settle holder edits; an ADMIN is refused both", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    expect((await decidePost(req("/api/procurement/suppliers/s1/decide", "POST", { decision: "APPROVED" }), params)).status).toBe(403);
    expect((await patchOne(req("/api/procurement/suppliers/s1", "PATCH", { expectedVersion: 1, currency: "USD" }), params)).status).toBe(403);
    authMock.mockResolvedValue(user({ role: "ADMIN", procurementApproveCeilingAed: 1000000 }));
    expect((await decidePost(req("/api/procurement/suppliers/s1/decide", "POST", { decision: "APPROVED" }), params)).status).toBe(403);
    authMock.mockResolvedValue(user({ role: "SUPER_ADMIN" }));
    expect((await decidePost(req("/api/procurement/suppliers/s1/decide", "POST", { decision: "APPROVED" }), params)).status).toBe(200);
    expect((await patchOne(req("/api/procurement/suppliers/s1", "PATCH", { expectedVersion: 1, currency: "USD" }), params)).status).toBe(403);
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementApproveUnlimited: true }));
    const finalApprover = await decidePost(req("/api/procurement/suppliers/s1/decide", "POST", { decision: "APPROVED" }), params);
    expect(finalApprover.status).toBe(200);
    // A final approver who is not in the financials boundary still sees the bank details blanked.
    expect((await finalApprover.json()).supplier).toMatchObject({ financialsRedacted: true });
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementSettle: true }));
    expect((await decidePost(req("/api/procurement/suppliers/s1/decide", "POST", { decision: "APPROVED", note: "ok" }), params)).status).toBe(200);
    expect(svc.decideSupplier).toHaveBeenCalledWith(expect.objectContaining({ supplierId: "s1", decision: "APPROVED", note: "ok" }));
    expect((await patchOne(req("/api/procurement/suppliers/s1", "PATCH", { expectedVersion: 1, currency: "USD" }), params)).status).toBe(200);
  });
  it("the service's refusals map to their statuses and a bad decision body is a 400", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementSettle: true }));
    svc.decideSupplier.mockResolvedValue({ ok: false, code: "ALREADY_DECIDED", message: "done" });
    expect((await decidePost(req("/api/procurement/suppliers/s1/decide", "POST", { decision: "REJECTED" }), params)).status).toBe(409);
    expect((await decidePost(req("/api/procurement/suppliers/s1/decide", "POST", { decision: "MAYBE" }), params)).status).toBe(400);
    svc.updateSupplier.mockResolvedValue({ ok: false, code: "STALE_WRITE", message: "stale" });
    expect((await patchOne(req("/api/procurement/suppliers/s1", "PATCH", { expectedVersion: 1, notes: "x" }), params)).status).toBe(409);
  });
});

describe("the supplier decision reports what it issued", () => {
  it("returns the orders issued, failed and not emailed, for the page to say", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementSettle: true }));
    svc.decideSupplier.mockResolvedValue({ ok: true, supplier: { ...supplier, approvalStatus: "APPROVED" }, conversion: { issued: 2, failed: 1, sendFailed: 1 } });
    const res = await decidePost(req("/api/procurement/suppliers/s1/decide", "POST", { decision: "APPROVED" }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ordersIssued: 2, ordersFailed: 1, ordersEmailFailed: 1 });
  });
});
