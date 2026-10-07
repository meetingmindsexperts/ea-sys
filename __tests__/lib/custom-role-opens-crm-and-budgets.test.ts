/**
 * Owner, Oct 7, 2026: ORGANIZER and MEMBER hold no CRM or Budgets of their
 * own; "a custom role adds them". That promise needs every door to read the
 * custom role, and two did not: `crmCan` judged the CRM routes from the org
 * context (base role only), and the agent registered its CRM and Budgets tools
 * from the role name. These pin that a custom role, or a person grant, now
 * opens both, and that without one nothing opens.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {}, dbOperator: {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/agent/event-tools", () => ({ registerEventTools: vi.fn() }));
vi.mock("@/lib/module-flags", async (orig) => ({ ...(await orig<object>()), isProcurementModuleEnabled: () => true }));

import { crmCan } from "@/crm/lib/crm-visibility";
import { collectToolsForActor } from "@/lib/agent/tool-registry";
import { principalFromUser } from "@/lib/permissions/can";

const ORG = "org1";

describe("the CRM routes read the session's custom role", () => {
  const ctx = (role: string, customGrants: string[] | null = null) => ({ organizationId: ORG, userId: "u1", role, fromApiKey: false, customGrants });

  it("refuses a MEMBER or ORGANIZER with no custom role", () => {
    for (const role of ["MEMBER", "ORGANIZER"]) expect(crmCan(ctx(role), "crm.read"), role).toBe(false);
  });

  it("admits them through a custom role holding the key, and only that key", () => {
    expect(crmCan(ctx("MEMBER", ["crm.read"]), "crm.read")).toBe(true);
    expect(crmCan(ctx("MEMBER", ["crm.read"]), "crm.write")).toBe(false);
    expect(crmCan(ctx("ORGANIZER", ["crm.read", "crm.write"]), "crm.write")).toBe(true);
  });

  it("keeps the base role for CRM_USER and ADMIN, with or without custom keys", () => {
    expect(crmCan(ctx("CRM_USER"), "crm.write")).toBe(true);
    expect(crmCan(ctx("ADMIN", ["events.read@ALL"]), "crm.read")).toBe(true);
  });
});

describe("the agent offers CRM and Budgets tools by permission", () => {
  const tools = (role: string, extra: Parameters<typeof principalFromUser>[0] = {}) => {
    const principal = principalFromUser({ id: "u1", role, organizationId: ORG, ...extra });
    return collectToolsForActor({ organizationId: ORG, actor: { userId: "u1", role, fromApiKey: false, principal }, source: "agent" }).map((t) => t.name);
  };

  it("offers a plain MEMBER neither", () => {
    const names = tools("MEMBER");
    expect(names.some((n) => n.includes("crm"))).toBe(false);
    expect(names).not.toContain("list_budgets");
  });

  it("offers the CRM reads to a MEMBER whose custom role grants crm.read", () => {
    const names = tools("MEMBER", { procurementPermissions: ["crm.read"] });
    expect(names).toContain("list_crm_deals");
    expect(names).not.toContain("create_crm_deal");
  });

  it("offers Budgets to an ORGANIZER who holds a person grant (an approver)", () => {
    expect(tools("ORGANIZER", { procurementApproveCeilingAed: 5000 })).toContain("list_budgets");
  });
});
