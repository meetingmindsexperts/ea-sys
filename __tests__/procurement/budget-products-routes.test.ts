/**
 * The product routes through the REAL guard with the service mocked: the flag
 * turns them into 404s, org staff read (and the read seeds), only an admin
 * writes, an organiser is refused, and the service's rejections map to the
 * documented statuses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "127.0.0.1" }));

const svc = vi.hoisted(() => ({
  ensureBudgetProducts: vi.fn().mockResolvedValue([{ id: "p1", sku: "510301", name: "AV", categoryId: "c1", isActive: true, sortOrder: 0, category: { id: "c1", code: "AV", name: "AV & Production" } }]),
  createBudgetProduct: vi.fn().mockResolvedValue({ ok: true, product: { id: "p2", sku: "999" } }),
  updateBudgetProduct: vi.fn().mockResolvedValue({ ok: true, product: { id: "p1", sku: "510301", isActive: false } }),
}));
vi.mock("@/procurement/services/budget-product-service", () => svc);

import { GET as listGet, POST as createPost } from "@/app/api/procurement/products/route";
import { PATCH as patchProduct } from "@/app/api/procurement/products/[productId]/route";

const ORG = "org-1";
const user = (over: Record<string, unknown>) => ({ user: { id: "u1", organizationId: ORG, role: "MEMBER", ...over } });
const post = (body: unknown) => new NextRequest("http://localhost/api/procurement/products", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const patch = (body: unknown) => new NextRequest("http://localhost/api/procurement/products/p1", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = { params: Promise.resolve({ productId: "p1" }) };

beforeEach(() => {
  process.env.PROCUREMENT_MODULE_ENABLED = "true";
  vi.clearAllMocks();
  svc.createBudgetProduct.mockResolvedValue({ ok: true, product: { id: "p2", sku: "999" } });
  svc.updateBudgetProduct.mockResolvedValue({ ok: true, product: { id: "p1", sku: "510301", isActive: false } });
});
afterEach(() => {
  delete process.env.PROCUREMENT_MODULE_ENABLED;
});

describe("procurement products routes", () => {
  it("is a 404 for everyone while the module is off", async () => {
    delete process.env.PROCUREMENT_MODULE_ENABLED;
    authMock.mockResolvedValue(user({ role: "SUPER_ADMIN" }));
    expect((await listGet()).status).toBe(404);
    expect(svc.ensureBudgetProducts).not.toHaveBeenCalled();
  });
  it("MEMBER reads the catalogue, and the read seeds it for the org", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    const res = await listGet();
    expect(res.status).toBe(200);
    expect((await res.json()).products).toHaveLength(1);
    expect(svc.ensureBudgetProducts).toHaveBeenCalledWith(ORG);
  });
  it("ORGANIZER and MEMBER cannot write; ADMIN creates and patches", async () => {
    authMock.mockResolvedValue(user({ role: "ORGANIZER" }));
    expect((await createPost(post({ sku: "999", name: "Thing", categoryId: "c1" }))).status).toBe(403);
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    expect((await patchProduct(patch({ isActive: false }), params)).status).toBe(403);
    expect(svc.createBudgetProduct).not.toHaveBeenCalled();
    expect(svc.updateBudgetProduct).not.toHaveBeenCalled();
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    expect((await createPost(post({ sku: "999", name: "Thing", categoryId: "c1" }))).status).toBe(201);
    expect(svc.createBudgetProduct).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, actorUserId: "u1", source: "ui", sku: "999", name: "Thing", categoryId: "c1" }));
    expect((await patchProduct(patch({ isActive: false }), params)).status).toBe(200);
    expect(svc.updateBudgetProduct).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, productId: "p1", isActive: false }));
  });
  it("a bad body is a 400 and an empty patch is a 400", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    expect((await createPost(post({ name: "no sku" }))).status).toBe(400);
    expect((await patchProduct(patch({}), params)).status).toBe(400);
  });
  it("the service's rejections map to their statuses", async () => {
    authMock.mockResolvedValue(user({ role: "SUPER_ADMIN" }));
    svc.createBudgetProduct.mockResolvedValue({ ok: false, code: "SKU_TAKEN", message: "taken" });
    expect((await createPost(post({ sku: "510301", name: "Dup", categoryId: "c1" }))).status).toBe(409);
    svc.updateBudgetProduct.mockResolvedValue({ ok: false, code: "PRODUCT_NOT_FOUND", message: "missing" });
    expect((await patchProduct(patch({ name: "x" }), params)).status).toBe(404);
  });
});
