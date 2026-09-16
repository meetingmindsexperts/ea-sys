/**
 * The three custom-role endpoints, through the REAL guard with the service
 * mocked: who may call them, what the module flag does, and how a service
 * refusal becomes a status.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));

// All four real loggers, not just the one a file happens to use: these routes
// import `@/lib/db`, which imports `dbLogger`, so a mock naming a single export
// breaks the moment the import graph widens.
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: loggerMock, dbLogger: loggerMock, authLogger: loggerMock, eventLogger: loggerMock,
}));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "127.0.0.1", checkRateLimit: () => ({ allowed: true }) }));

const { mockDb } = vi.hoisted(() => ({ mockDb: { user: { findFirst: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: unknown) => (fn as (t: unknown) => unknown)(mockDb) }));

const svc = vi.hoisted(() => ({
  ensureStarterPermissionSets: vi.fn().mockResolvedValue([]),
  listPermissionSets: vi.fn().mockResolvedValue([]),
  createPermissionSet: vi.fn(),
  updatePermissionSet: vi.fn(),
  setPermissionSetArchived: vi.fn(),
  readUserPermissionSetIds: vi.fn().mockResolvedValue([]),
  setUserPermissionSets: vi.fn(),
}));
vi.mock("@/lib/permissions/permission-set-service", () => svc);

import { GET as listGet, POST as createPost } from "@/app/api/organization/permission-sets/route";
import { PATCH as detailPatch } from "@/app/api/organization/permission-sets/[permissionSetId]/route";
import { GET as assignGet, PUT as assignPut } from "@/app/api/organization/users/[userId]/permission-sets/route";

const ORG = "org-1";
const session = (role: string, over: Record<string, unknown> = {}) => ({
  user: { id: "u1", organizationId: ORG, role, ...over },
});
const listReq = () => new NextRequest("http://localhost/api/organization/permission-sets");
const post = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const patch = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const put = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const setParams = { params: Promise.resolve({ permissionSetId: "s1" }) };
const userParams = { params: Promise.resolve({ userId: "target-1" }) };

beforeEach(() => {
  process.env.PROCUREMENT_MODULE_ENABLED = "true";
  vi.clearAllMocks();
  svc.ensureStarterPermissionSets.mockResolvedValue([]);
  svc.listPermissionSets.mockResolvedValue([]);
  svc.readUserPermissionSetIds.mockResolvedValue([]);
  mockDb.user.findFirst.mockResolvedValue({ id: "target-1", role: "MEMBER" });
});
afterEach(() => {
  delete process.env.PROCUREMENT_MODULE_ENABLED;
});

describe("the flag and the boundary", () => {
  it("is a 404 for everyone while the module is off, a super admin included", async () => {
    delete process.env.PROCUREMENT_MODULE_ENABLED;
    authMock.mockResolvedValue(session("SUPER_ADMIN"));
    expect((await listGet(listReq())).status).toBe(404);
  });

  it("answers 404 before 401 on a flagless deployment, so it never advertises the surface", async () => {
    delete process.env.PROCUREMENT_MODULE_ENABLED;
    authMock.mockResolvedValue(null);
    expect((await listGet(listReq())).status).toBe(404);
  });

  it("is a 401 with no session", async () => {
    authMock.mockResolvedValue(null);
    expect((await listGet(listReq())).status).toBe(401);
  });

  it("REFUSES AN ADMIN: a role can carry approval authority, so only a super admin mints one", async () => {
    // The restriction is the mechanism, not caution — an admin deliberately
    // kept out of approving must not be able to grant it to themselves.
    authMock.mockResolvedValue(session("ADMIN"));
    expect((await listGet(listReq())).status).toBe(403);
    expect((await createPost(post("/api/organization/permission-sets", { name: "X", permissions: ["procurement.budgets.view"] }))).status).toBe(403);
    expect((await detailPatch(patch("/api/organization/permission-sets/s1", { archived: true }), setParams)).status).toBe(403);
    expect((await assignPut(put("/api/organization/users/target-1/permission-sets", { permissionSetIds: [] }), userParams)).status).toBe(403);
    expect(svc.createPermissionSet).not.toHaveBeenCalled();
  });

  it("refuses an org-null account", async () => {
    authMock.mockResolvedValue({ user: { id: "s", organizationId: null, role: "SUPER_ADMIN" } });
    expect((await listGet(listReq())).status).toBe(403);
  });
});

describe("listing and creating", () => {
  it("SEEDS the starter roles on the first read, so the screen is never empty", async () => {
    authMock.mockResolvedValue(session("SUPER_ADMIN"));
    const res = await listGet(listReq());
    expect(res.status).toBe(200);
    expect(svc.ensureStarterPermissionSets).toHaveBeenCalledWith(ORG);
  });

  it("passes includeArchived through only when asked", async () => {
    authMock.mockResolvedValue(session("SUPER_ADMIN"));
    await listGet(listReq());
    expect(svc.listPermissionSets).toHaveBeenCalledWith(ORG, { includeArchived: false });
    await listGet(new NextRequest("http://localhost/api/organization/permission-sets?includeArchived=1"));
    expect(svc.listPermissionSets).toHaveBeenCalledWith(ORG, { includeArchived: true });
  });

  it("creates and returns 201", async () => {
    authMock.mockResolvedValue(session("SUPER_ADMIN"));
    svc.createPermissionSet.mockResolvedValue({ ok: true, set: { id: "s1" } });
    const res = await createPost(post("/api/organization/permission-sets", { name: "PO Author", permissions: ["procurement.budgets.view"] }));
    expect(res.status).toBe(201);
    expect(svc.createPermissionSet).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, actorUserId: "u1" }));
  });

  it("rejects a body with no permissions before reaching the service", async () => {
    authMock.mockResolvedValue(session("SUPER_ADMIN"));
    const res = await createPost(post("/api/organization/permission-sets", { name: "X", permissions: [] }));
    expect(res.status).toBe(400);
    expect(svc.createPermissionSet).not.toHaveBeenCalled();
  });
});

describe("service refusals map to their own statuses", () => {
  const cases: [string, number][] = [
    ["SEPARATION_CONFLICT", 422],
    ["STALE_WRITE", 409],
    ["DUPLICATE_NAME", 409],
    ["NOT_FOUND", 404],
    ["UNKNOWN_PERMISSION", 400],
    ["UNKNOWN", 500],
  ];
  for (const [code, status] of cases) {
    it(`${code} becomes ${status}`, async () => {
      authMock.mockResolvedValue(session("SUPER_ADMIN"));
      svc.updatePermissionSet.mockResolvedValue({ ok: false, code, message: "no" });
      const res = await detailPatch(patch("/api/organization/permission-sets/s1", { expectedVersion: 1, name: "x" }), setParams);
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ code });
    });
  }
});

describe("editing and archiving", () => {
  it("demands expectedVersion on an edit, because the version IS the lock", async () => {
    authMock.mockResolvedValue(session("SUPER_ADMIN"));
    const res = await detailPatch(patch("/api/organization/permission-sets/s1", { name: "x" }), setParams);
    expect(res.status).toBe(400);
    expect(svc.updatePermissionSet).not.toHaveBeenCalled();
  });

  it("archiving needs no version and routes to its own operation", async () => {
    authMock.mockResolvedValue(session("SUPER_ADMIN"));
    svc.setPermissionSetArchived.mockResolvedValue({ ok: true, set: { id: "s1" }, holderCount: 3 });
    const res = await detailPatch(patch("/api/organization/permission-sets/s1", { archived: true }), setParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ holderCount: 3 });
    expect(svc.updatePermissionSet).not.toHaveBeenCalled();
  });
});

describe("assigning roles to a person", () => {
  it("reads the roles a person holds", async () => {
    authMock.mockResolvedValue(session("SUPER_ADMIN"));
    svc.readUserPermissionSetIds.mockResolvedValue(["s1", "s2"]);
    const res = await assignGet(new NextRequest("http://localhost/x"), userParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ permissionSetIds: ["s1", "s2"] });
  });

  it("refuses a target who is not a team member", async () => {
    // Org-bound registrants share the organisation but are not staff; a role
    // on one of them would be access nobody intended to give.
    authMock.mockResolvedValue(session("SUPER_ADMIN"));
    mockDb.user.findFirst.mockResolvedValue({ id: "target-1", role: "REGISTRANT" });
    const res = await assignPut(put("/api/organization/users/target-1/permission-sets", { permissionSetIds: ["s1"] }), userParams);
    expect(res.status).toBe(404);
    expect(svc.setUserPermissionSets).not.toHaveBeenCalled();
  });

  it("refuses a target in another organisation", async () => {
    authMock.mockResolvedValue(session("SUPER_ADMIN"));
    mockDb.user.findFirst.mockResolvedValue(null);
    const res = await assignPut(put("/api/organization/users/target-1/permission-sets", { permissionSetIds: [] }), userParams);
    expect(res.status).toBe(404);
    // Bound on the READ: the lookup carries the caller's org.
    expect(mockDb.user.findFirst.mock.calls[0][0].where.organizationId).toBe(ORG);
  });

  it("saves the replace-all set and records who assigned it", async () => {
    authMock.mockResolvedValue(session("SUPER_ADMIN"));
    svc.setUserPermissionSets.mockResolvedValue({ ok: true, permissionSetIds: ["s1"], permissions: [] });
    const res = await assignPut(put("/api/organization/users/target-1/permission-sets", { permissionSetIds: ["s1"] }), userParams);
    expect(res.status).toBe(200);
    expect(svc.setUserPermissionSets).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, actorUserId: "u1", userId: "target-1", permissionSetIds: ["s1"] }),
    );
  });

  it("a refused combination is a 422 the dialog can show verbatim", async () => {
    authMock.mockResolvedValue(session("SUPER_ADMIN"));
    svc.setUserPermissionSets.mockResolvedValue({ ok: false, code: "SEPARATION_CONFLICT", message: "Signing off and approving cannot be held by the same person." });
    const res = await assignPut(put("/api/organization/users/target-1/permission-sets", { permissionSetIds: ["s1"] }), userParams);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("cannot be held by the same person");
  });
});
