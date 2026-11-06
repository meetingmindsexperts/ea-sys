/**
 * The CRM's route gate asks the organisation first (module-entitlements.ts):
 * a person with every CRM permission still gets a 404 when their organisation
 * does not have the CRM.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getOrgContext, orgHasModule } = vi.hoisted(() => ({ getOrgContext: vi.fn(), orgHasModule: vi.fn() }));
vi.mock("@/lib/api-auth", () => ({ getOrgContext }));
vi.mock("@/lib/module-entitlements", () => ({ orgHasModule }));
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
    orgHasModule.mockResolvedValue(false);
    const res = await requireCrmRead(req());
    expect(res.error?.status).toBe(404);
    expect(await res.error?.json()).toMatchObject({ code: "MODULE_NOT_ENABLED" });
    expect(orgHasModule).toHaveBeenCalledWith("org-b", "crm");
  });

  it("the write gate inherits the refusal", async () => {
    getOrgContext.mockResolvedValue(admin);
    orgHasModule.mockResolvedValue(false);
    expect((await requireCrmWrite(req())).error?.status).toBe(404);
  });

  it("lets the person through when the organisation has it", async () => {
    getOrgContext.mockResolvedValue(admin);
    orgHasModule.mockResolvedValue(true);
    const res = await requireCrmRead(req());
    expect(res.error).toBeUndefined();
    expect(res.ctx?.organizationId).toBe("org-b");
  });
});
