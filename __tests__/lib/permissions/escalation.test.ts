/**
 * The role editor's anti-escalation rules (custom roles plan §7.4, Phase 5)
 * and the scoped session grants a custom role reaches the screens through.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { can, principalFromUser } from "@/lib/permissions/can";
import { decodeSessionGrant, encodeSessionGrant, isGrantableKey } from "@/lib/permissions/catalogue";
import { actorCovers, breaksAdminTrio, firstGrantBeyondActor } from "@/lib/permissions/escalation";
import { isCustomRolesEnabled } from "@/lib/module-flags";

const as = (role: string, extra: Record<string, unknown> = {}) => principalFromUser({ id: "u1", role, organizationId: "org-1", ...extra });

describe("granting only what you hold", () => {
  it("an ALL grant covers every scope; a narrower one covers only itself", () => {
    const organizer = as("ORGANIZER");
    expect(actorCovers(organizer, { permission: "sessions.write", scope: "ALL" })).toBe(true);
    expect(actorCovers(organizer, { permission: "sessions.write", scope: "ASSIGNED" })).toBe(true);
    const webinars = as("WEBINARS");
    expect(actorCovers(webinars, { permission: "sessions.write", scope: "WEBINAR" })).toBe(true);
    expect(actorCovers(webinars, { permission: "sessions.write", scope: "ALL" })).toBe(false);
    const onsite = as("ONSITE");
    expect(actorCovers(onsite, { permission: "registrations.checkin", scope: "ASSIGNED" })).toBe(true);
    expect(actorCovers(onsite, { permission: "registrations.checkin", scope: "ALL" })).toBe(false);
  });

  it("a key the actor does not hold is refused, by name", () => {
    expect(firstGrantBeyondActor(as("MEMBER"), [
      { permission: "registrations.read", scope: "ALL" },
      { permission: "registrations.delete", scope: "ALL" },
    ])).toEqual({ permission: "registrations.delete", scope: "ALL" });
  });

  it("the top administrator may grant any key, including the approver keys their own role leaves out", () => {
    expect(firstGrantBeyondActor(as("SUPER_ADMIN"), [{ permission: "procurement.approvals.decide", scope: null }])).toBeNull();
    expect(can(as("SUPER_ADMIN"), "procurement.approvals.decide")).toBe(false);
  });

  it("the admin-making keys need all three", () => {
    expect(breaksAdminTrio(as("ADMIN"), [{ permission: "users.manage", scope: null }])).toBe(true);
    expect(breaksAdminTrio(as("SUPER_ADMIN"), [{ permission: "users.manage", scope: null }])).toBe(false);
    expect(breaksAdminTrio(as("ADMIN"), [{ permission: "events.update", scope: "ALL" }])).toBe(false);
  });

  it("an actor with no organisation covers nothing", () => {
    expect(actorCovers(principalFromUser({ id: "op", role: "SUPER_ADMIN", organizationId: null }), { permission: "events.read", scope: "ALL" })).toBe(false);
  });
});

describe("the flag and the session encoding", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("off: only the procurement keys are grantable; on: every key", () => {
    vi.stubEnv("CUSTOM_ROLES_ENABLED", "");
    expect(isCustomRolesEnabled()).toBe(false);
    expect(isGrantableKey("procurement.budgets.view", false)).toBe(true);
    expect(isGrantableKey("registrations.read", false)).toBe(false);
    vi.stubEnv("CUSTOM_ROLES_ENABLED", "true");
    expect(isCustomRolesEnabled()).toBe(true);
    expect(isGrantableKey("registrations.read", true)).toBe(true);
    expect(isGrantableKey("not.a.key", true)).toBe(false);
  });

  it("round-trips a scope and drops an unknown one", () => {
    expect(encodeSessionGrant("registrations.read", "ASSIGNED")).toBe("registrations.read@ASSIGNED");
    expect(encodeSessionGrant("crm.read", null)).toBe("crm.read");
    expect(decodeSessionGrant("registrations.read@ASSIGNED")).toEqual({ permission: "registrations.read", scope: "ASSIGNED" });
    expect(decodeSessionGrant("crm.read")).toEqual({ permission: "crm.read" });
    expect(decodeSessionGrant("registrations.read@EVERYWHERE")).toEqual({ permission: "registrations.read" });
  });

  it("a custom role's scoped key reaches can() with its scope", () => {
    const hr = as("HR_USER", { procurementPermissions: ["registrations.read@ASSIGNED"] });
    const assigned = { organizationId: "org-1", eventType: "CONFERENCE", staffUserIds: ["u1"] };
    const other = { organizationId: "org-1", eventType: "CONFERENCE", staffUserIds: [] };
    expect(can(hr, "registrations.read", { event: assigned })).toBe(true);
    expect(can(hr, "registrations.read", { event: other })).toBe(false);
  });
});
