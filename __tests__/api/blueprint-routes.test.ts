/**
 * The /api/blueprint gate, with the REAL permission code: the module flag
 * (404 when off), sign-in (401), an organisation (403 for org-null roles),
 * then the owner's role defaults: Admins and Organizers write, Members only
 * read, the vendor's "build team" flag is blueprints.manage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockAuth, mockService } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockService: {
    listBlueprints: vi.fn(),
    getBlueprint: vi.fn(),
    saveBlueprint: vi.fn(),
    listTemplates: vi.fn(),
    saveTemplate: vi.fn(),
    storeFile: vi.fn(),
    readFile: vi.fn(),
    removeFile: vi.fn(),
  },
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/services/blueprint-service", () => mockService);

import { GET as listGET } from "@/app/api/blueprint/blueprints/route";
import { PUT as savePUT } from "@/app/api/blueprint/blueprints/[id]/route";
import { GET as meGET } from "@/app/api/blueprint/me/route";

const as = (role: string, organizationId: string | null = "org-1") =>
  mockAuth.mockResolvedValue({ user: { id: `u-${role}`, role, organizationId } });
const params = { params: Promise.resolve({ id: "bp_mg9x2k1abcde" }) };
const put = () =>
  savePUT(new Request("http://localhost/api/blueprint/blueprints/bp_mg9x2k1abcde", { method: "PUT", body: JSON.stringify({ v: 2 }) }), params);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BLUEPRINT_MODULE_ENABLED", "true");
  mockService.listBlueprints.mockResolvedValue([]);
  mockService.saveBlueprint.mockResolvedValue({ ok: true, updated: 1 });
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/blueprint gate", () => {
  it("answers 404 for everyone while the module is off", async () => {
    vi.stubEnv("BLUEPRINT_MODULE_ENABLED", "");
    as("SUPER_ADMIN");
    expect((await listGET()).status).toBe(404);
    expect(mockService.listBlueprints).not.toHaveBeenCalled();
  });

  it("401 without a session", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await listGET()).status).toBe(401);
  });

  it.each(["REVIEWER", "SUBMITTER", "REGISTRANT"])("403 for the org-null %s", async (role) => {
    as(role, null);
    expect((await listGET()).status).toBe(403);
  });

  it.each(["ONSITE", "WEBINARS", "CRM_USER", "HR_USER"])("%s cannot see blueprints", async (role) => {
    as(role);
    expect((await listGET()).status).toBe(403);
  });

  it.each([
    ["SUPER_ADMIN", 200, 200],
    ["ADMIN", 200, 200],
    ["ORGANIZER", 200, 200],
    ["MEMBER", 200, 403],
  ])("%s: list %i, save %i", async (role, list, save) => {
    as(role);
    expect((await listGET()).status).toBe(list);
    expect((await put()).status).toBe(save);
  });

  it("passes the caller's organisation to the service, never one from the body", async () => {
    as("ORGANIZER");
    await put();
    expect(mockService.saveBlueprint).toHaveBeenCalledWith({ organizationId: "org-1", userId: "u-ORGANIZER" }, "bp_mg9x2k1abcde", { v: 2 });
  });

  it.each([
    ["ADMIN", true, true],
    ["ORGANIZER", false, true],
    ["MEMBER", false, false],
  ])("me: %s isEditor=%s canWrite=%s", async (role, isEditor, canWrite) => {
    as(role);
    expect(await (await meGET()).json()).toEqual({ id: `u-${role}`, isEditor, canWrite });
  });
});
