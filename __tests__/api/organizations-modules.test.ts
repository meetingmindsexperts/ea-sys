/**
 * PUT /api/organizations/[orgId]/modules: the platform operator switches a
 * module per organisation; nobody else can, and every change is audited in
 * the same transaction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, findUnique, update, auditCreate, forgetOrgModules } = vi.hoisted(() => ({
  auth: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  auditCreate: vi.fn(),
  forgetOrgModules: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/db", () => ({
  tenantTransaction: (fn: (tx: unknown) => unknown) => fn({ organization: { findUnique, update }, auditLog: { create: auditCreate } }),
}));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/module-entitlements", () => ({ ORG_MODULES: ["crm"], forgetOrgModules }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { PUT } from "@/app/api/organizations/[orgId]/modules/route";

const call = (body: unknown, orgId = "org-b") =>
  PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ orgId }) });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PLATFORM_ORG_ID;
  auth.mockResolvedValue({ user: { id: "op", role: "SUPER_ADMIN", organizationId: "org-a" } });
  findUnique.mockResolvedValue({ enabledModules: [] });
});

describe("the module switch", () => {
  it("refuses anyone who is not the platform operator", async () => {
    auth.mockResolvedValue({ user: { id: "a", role: "ADMIN", organizationId: "org-b" } });
    expect((await call({ module: "crm", enabled: true })).status).toBe(403);
    process.env.PLATFORM_ORG_ID = "org-platform";
    auth.mockResolvedValue({ user: { id: "s", role: "SUPER_ADMIN", organizationId: "org-b" } });
    expect((await call({ module: "crm", enabled: true })).status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it("switches the CRM on, audits it and drops the cached answer", async () => {
    const res = await call({ module: "crm", enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabledModules: ["crm"] });
    expect(update).toHaveBeenCalledWith({ where: { id: "org-b" }, data: { enabledModules: ["crm"] } });
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "MODULE_ENABLED", organizationId: "org-b" }) }));
    expect(forgetOrgModules).toHaveBeenCalledWith("org-b");
  });

  it("switching off removes only the entitlement and writes nothing when already in that state", async () => {
    findUnique.mockResolvedValue({ enabledModules: ["crm"] });
    await call({ module: "crm", enabled: false });
    expect(update).toHaveBeenCalledWith({ where: { id: "org-b" }, data: { enabledModules: [] } });
    vi.clearAllMocks();
    findUnique.mockResolvedValue({ enabledModules: [] });
    await call({ module: "crm", enabled: false });
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("refuses an unknown module and an unknown organisation", async () => {
    expect((await call({ module: "hr", enabled: true })).status).toBe(400);
    findUnique.mockResolvedValue(null);
    expect((await call({ module: "crm", enabled: true })).status).toBe(404);
  });
});
