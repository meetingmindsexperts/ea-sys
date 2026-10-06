/**
 * The custom-roles review fixes (Oct 6, 2026), the pure rules:
 *  - H1/H2/L4: the admin-only keys are never grantable in a custom role;
 *  - M5: a call naming no event needs the key for every event;
 *  - M6: a custom grant must fit the base role's areas.
 */
import { describe, it, expect } from "vitest";
import { ADMIN_ONLY_KEYS, isGrantableKey } from "@/lib/permissions/catalogue";
import { canEverywhere, principalFromUser, type Principal } from "@/lib/permissions/can";
import { grantsOutsideAreas, keyArea } from "@/lib/permissions/key-areas";
import { gateToolCall } from "@/lib/agent/tool-gate";

describe("admin-only keys", () => {
  it("are never grantable, flag on or off", () => {
    for (const key of ["roles.manage", "users.manage", "apiKeys.manage", "mcp.connect"]) {
      expect(ADMIN_ONLY_KEYS.has(key)).toBe(true);
      expect(isGrantableKey(key, true)).toBe(false);
      expect(isGrantableKey(key, false)).toBe(false);
    }
    expect(isGrantableKey("events.update", true)).toBe(true);
  });
});

describe("a call that names no event", () => {
  const webinarOnly = {
    ...principalFromUser({ id: "k", role: "MEMBER", organizationId: "o" }),
    grants: [{ permission: "events.read", scope: "WEBINAR" }, { permission: "events.create", scope: "WEBINAR" }],
  } as Principal;

  it("needs the key for every event", () => {
    expect(canEverywhere(webinarOnly, "events.read")).toBe(false);
    expect(canEverywhere(principalFromUser({ id: "m", role: "MEMBER", organizationId: "o" }), "events.read")).toBe(true);
  });

  it("refuses list_events and create_event to a webinar-only principal, and allows them on a named webinar", () => {
    expect(gateToolCall("list_events", { principal: webinarOnly, writesSoFar: 0 }).kind).toBe("refuse");
    expect(gateToolCall("create_event", { principal: webinarOnly, writesSoFar: 0 }).kind).toBe("refuse");
    const webinar = { organizationId: "o", eventType: "WEBINAR", staffUserIds: [] };
    expect(gateToolCall("get_event_info", { principal: webinarOnly, event: webinar, writesSoFar: 0 }).kind).not.toBe("refuse");
  });
});

describe("custom grants stay inside the base role's areas", () => {
  const g = (permission: string, scope: "ALL" | "ASSIGNED" | "WEBINAR" | null = null) => ({ permission, scope });

  it("sorts keys into areas", () => {
    expect(keyArea("crm.write")).toBe("crm");
    expect(keyArea("hr.read")).toBe("hr");
    expect(keyArea("procurement.budgets.view")).toBe("procurement");
    expect(keyArea("registrations.export")).toBe("desk");
    expect(keyArea("speakers.update")).toBe("events");
    expect(keyArea("contacts.export")).toBe("org");
  });

  it("refuses a CRM user registrations and an HR user the CRM", () => {
    expect(grantsOutsideAreas("CRM_USER", [g("registrations.export", "ALL")])).toHaveLength(1);
    expect(grantsOutsideAreas("HR_USER", [g("crm.read")])).toHaveLength(1);
    expect(grantsOutsideAreas("CRM_USER", [g("crm.export")])).toHaveLength(0);
  });

  it("keeps the Onsite desk on its assigned events", () => {
    expect(grantsOutsideAreas("ONSITE", [g("registrations.read", "ALL")])).toHaveLength(1);
    expect(grantsOutsideAreas("ONSITE", [g("registrations.update", "ASSIGNED")])).toHaveLength(0);
    // A key Onsite already holds at that scope (the agenda it reads) is not new reach.
    expect(grantsOutsideAreas("ONSITE", [g("sessions.read", "ASSIGNED")])).toHaveLength(0);
    expect(grantsOutsideAreas("ONSITE", [g("speakers.update", "ASSIGNED")])).toHaveLength(1);
  });

  it("keeps Webinars' management to webinars", () => {
    expect(grantsOutsideAreas("WEBINARS", [g("speakers.update", "WEBINAR")])).toHaveLength(0);
    expect(grantsOutsideAreas("WEBINARS", [g("speakers.update", "ALL")])).toHaveLength(1);
  });

  it("lets org-wide staff take anything in their areas, and fails closed on an unknown role", () => {
    expect(grantsOutsideAreas("MEMBER", [g("speakers.update", "ALL"), g("crm.write"), g("contacts.export")])).toHaveLength(0);
    expect(grantsOutsideAreas("REGISTRANT", [g("events.read", "ALL")])).toHaveLength(1);
    expect(grantsOutsideAreas(null, [g("crm.read")])).toHaveLength(1);
  });
});
