/** Which card and dialog manage a role (owner, Oct 5, 2026: two dialogs). */
import { describe, it, expect } from "vitest";
import { roleKind } from "@/lib/permissions/role-kind";

describe("roleKind", () => {
  it("sorts a role by its keys", () => {
    expect(roleKind(["procurement.budgets.view", "procurement.orders.view"])).toBe("procurement");
    expect(roleKind(["registrations.read", "crm.read"])).toBe("custom");
    expect(roleKind(["registrations.read", "procurement.budgets.view"])).toBe("mixed");
    expect(roleKind([])).toBe("custom");
  });
});
