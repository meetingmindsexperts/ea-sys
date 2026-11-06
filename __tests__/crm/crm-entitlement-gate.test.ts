/**
 * The CRM's route gate asks the organisation first (module-entitlements.ts):
 * a person with every CRM permission still gets a 404 when their organisation
 * does not have the CRM.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getOrgContext, orgModuleState } = vi.hoisted(() => ({ getOrgContext: vi.fn(), orgModuleState: vi.fn() }));
vi.mock("@/lib/api-auth", () => ({ getOrgContext }));
vi.mock("@/lib/module-entitlements", () => ({ orgModuleState }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => {
  const l = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { apiLogger: l, dbLogger: l, authLogger: l, eventLogger: l };
});

import { requireCrmRead, requireCrmWrite } from "@/crm/lib/crm-route";

const admin = { organizationId: "org-b", userId: "u1", role: "SUPER_ADMIN", fromApiKey: false, fromMobile: false };
const req = () => new Request("http://x/api/crm/deals");

beforeEach(() => vi.clearAllMocks());

describe("requireCrmRead and the organisation's entitlement", () => {
  it("404s a SUPER_ADMIN whose organisation does not have the CRM", async () => {
    getOrgContext.mockResolvedValue(admin);
    orgModuleState.mockResolvedValue("off");
    const res = await requireCrmRead(req());
    expect(res.error?.status).toBe(404);
    expect(await res.error?.json()).toMatchObject({ code: "MODULE_NOT_ENABLED" });
    expect(orgModuleState).toHaveBeenCalledWith("org-b", "crm");
  });

  it("the write gate inherits the refusal", async () => {
    getOrgContext.mockResolvedValue(admin);
    orgModuleState.mockResolvedValue("off");
    expect((await requireCrmWrite(req())).error?.status).toBe(404);
  });

  it("a failed read is a 503, never a false 'not enabled'", async () => {
    getOrgContext.mockResolvedValue(admin);
    orgModuleState.mockResolvedValue("unknown");
    const res = await requireCrmRead(req());
    expect(res.error?.status).toBe(503);
  });

  it("lets the person through when the organisation has it", async () => {
    getOrgContext.mockResolvedValue(admin);
    orgModuleState.mockResolvedValue("on");
    const res = await requireCrmRead(req());
    expect(res.error).toBeUndefined();
    expect(res.ctx?.organizationId).toBe("org-b");
  });
});
