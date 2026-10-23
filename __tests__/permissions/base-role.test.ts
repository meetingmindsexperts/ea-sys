/**
 * The "Base role" (BASE, Oct 23, 2026; docs/BASE_ROLE_PLAN.md): no default
 * permissions, everything from the custom roles the person holds. Pins that:
 *  - a plain Base role person can do and reach nothing;
 *  - the Marketing role (see events, export registrations and contacts) fits,
 *    and nothing outside events, the desk and organisation pages does;
 *  - page confinement, the sidebar and the session token agree, with a home
 *    that is always a page the person may open (no redirect loop);
 *  - it is grantable only while custom roles are on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({ mockDb: { permissionSet: { findMany: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ authLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/module-flags", () => ({ isCustomRolesEnabled: () => true }));

import { grantsOutsideAreas } from "@/lib/permissions/key-areas";
import { can, inArea, principalFromUser } from "@/lib/permissions/can";
import { SYSTEM_ROLE_KEYS, systemRoleFor } from "@/lib/permissions/system-roles";
import { confinementRedirect } from "@/lib/route-confinement";
import { computeSidebarNav } from "@/components/layout/sidebar-nav";
import { clearSessionPermissionCache, extraAreasForToken } from "@/lib/permissions/session-permissions";
import { isRoleGrantableHere, isTeamRole, NOTIFIED_ROLES } from "@/lib/team-roles";
import { ASSIGNABLE_USER_ROLES } from "@/lib/auth-guards";

const MARKETING = ["events.read@ALL", "registrations.read@ALL", "registrations.export@ALL", "contacts.read", "contacts.export"];
const EVENT = { organizationId: "org-1", eventType: "CONFERENCE", staffUserIds: [] };
const person = (keys: string[] = []) =>
  principalFromUser({ id: "u1", role: "BASE", organizationId: "org-1", procurementPermissions: keys });

describe("the role itself", () => {
  it("holds no permission and no area", () => {
    const sys = systemRoleFor("BASE");
    expect(sys?.grants).toEqual([]);
    expect(sys?.areas).toEqual([]);
    expect(sys?.impliedPersonGrants).toEqual([]);
  });

  it("is staff, assignable, and never notified", () => {
    expect(isTeamRole("BASE")).toBe(true);
    expect(ASSIGNABLE_USER_ROLES).toContain("BASE");
    expect(NOTIFIED_ROLES as readonly string[]).not.toContain("BASE");
  });

  it("is grantable only while custom roles are on; other roles are unaffected", () => {
    expect(isRoleGrantableHere("BASE", { hrModuleEnabled: true, customRolesEnabled: false })).toBe(false);
    expect(isRoleGrantableHere("BASE", { hrModuleEnabled: false, customRolesEnabled: true })).toBe(true);
    expect(isRoleGrantableHere("HR_USER", { hrModuleEnabled: false, customRolesEnabled: true })).toBe(false);
    expect(isRoleGrantableHere("MEMBER", { hrModuleEnabled: false, customRolesEnabled: false })).toBe(true);
  });
});

describe("what a custom role may add", () => {
  const g = (permission: string, scope: "ALL" | null = null) => ({ permission, scope });

  it("the Marketing role fits", () => {
    expect(
      grantsOutsideAreas("BASE", [
        g("events.read", "ALL"),
        g("registrations.read", "ALL"),
        g("registrations.export", "ALL"),
        g("contacts.read"),
        g("contacts.export"),
      ]),
    ).toEqual([]);
  });

  it("Budgets, the CRM and HR never fit (owner D3: no HR access)", () => {
    expect(grantsOutsideAreas("BASE", [g("procurement.budgets.view")])).toHaveLength(1);
    expect(grantsOutsideAreas("BASE", [g("crm.read")])).toHaveLength(1);
    expect(grantsOutsideAreas("BASE", [g("hr.read")])).toHaveLength(1);
  });
});

describe("the person", () => {
  it("a plain Base role person can do nothing", () => {
    const p = person();
    expect(inArea(p, "events")).toBe(false);
    expect(inArea(p, "desk")).toBe(false);
    expect(can(p, "events.read", { event: EVENT })).toBe(false);
    expect(can(p, "contacts.read")).toBe(false);
  });

  it("with Marketing: read and export, and no money, barcodes, edits or check-in", () => {
    const p = person(MARKETING);
    expect(can(p, "registrations.export", { event: EVENT })).toBe(true);
    expect(can(p, "contacts.export")).toBe(true);
    for (const key of ["finance.view", "barcode.view", "registrations.update", "registrations.checkin", "contacts.write", "events.update"] as const) {
      expect(can(p, key, { event: EVENT })).toBe(false);
    }
  });
});

describe("pages", () => {
  const marketing = { extraAreas: ["desk", "org:/contacts"] };

  it("plain: only the (empty) events list, as an unknown role", () => {
    expect(confinementRedirect("BASE", "/events", { extraAreas: [] })).toBeNull();
    expect(confinementRedirect("BASE", "/dashboard", { extraAreas: [] })).toBe("/events");
    expect(confinementRedirect("BASE", "/contacts", { extraAreas: [] })).toBe("/events");
  });

  it("Marketing: events list, an event's Registrations, and Contacts", () => {
    expect(confinementRedirect("BASE", "/events", marketing)).toBeNull();
    expect(confinementRedirect("BASE", "/events/ev1/registrations", marketing)).toBeNull();
    expect(confinementRedirect("BASE", "/contacts", marketing)).toBeNull();
    // Any other event page goes to its Registrations; nothing else opens.
    expect(confinementRedirect("BASE", "/events/ev1/speakers", marketing)).toBe("/events/ev1/registrations");
    expect(confinementRedirect("BASE", "/events/new", marketing)).toBe("/events");
    for (const path of ["/dashboard", "/settings", "/invoices", "/crm", "/hr", "/procurement"]) {
      expect(confinementRedirect("BASE", path, marketing)).toBe("/events");
    }
  });

  it("contacts only: lands on Contacts, not an empty events list", () => {
    const contactsOnly = { extraAreas: ["org:/contacts"] };
    expect(confinementRedirect("BASE", "/contacts", contactsOnly)).toBeNull();
    expect(confinementRedirect("BASE", "/dashboard", contactsOnly)).toBe("/contacts");
    expect(confinementRedirect("BASE", "/events", contactsOnly)).toBe("/contacts");
    expect(confinementRedirect("BASE", "/profile", contactsOnly)).toBeNull();
    // An event page is not theirs either: back to Contacts, not to an empty list.
    expect(confinementRedirect("BASE", "/events/ev1/registrations", contactsOnly)).toBe("/contacts");
  });

  it("every redirect lands on a page the person may open (no loop)", () => {
    const cases = [{ extraAreas: [] }, marketing, { extraAreas: ["org:/contacts"] }, { extraAreas: ["events"] }];
    for (const grants of cases) {
      for (const path of ["/dashboard", "/events", "/events/ev1/agenda", "/settings", "/hr", "/contacts"]) {
        const to = confinementRedirect("BASE", path, grants);
        if (to) expect(confinementRedirect("BASE", to, grants)).toBeNull();
      }
    }
  });

  it("person grants open nothing for an empty base, and other areas in the cookie are ignored", () => {
    expect(confinementRedirect("BASE", "/hr", { hrAccess: true, extraAreas: ["desk"] })).toBe("/events");
    expect(confinementRedirect("BASE", "/procurement", { extraAreas: ["procurement", "desk"] })).toBe("/events");
  });

  it("other roles keep their confinement", () => {
    expect(confinementRedirect("CRM_USER", "/events")).toBe("/crm");
    expect(confinementRedirect("ONSITE", "/events/ev1/registrations")).toBeNull();
    expect(confinementRedirect("ONSITE", "/contacts")).toBe("/events");
  });
});

describe("the sidebar", () => {
  const nav = (keys: string[], isEventPage = true) =>
    computeSidebarNav({
      user: { id: "u1", organizationId: "org-1", role: "BASE", procurementPermissions: keys } as never,
      hrEnabled: true,
      procurementEnabled: true,
      isEventPage,
      currentEvent: isEventPage ? ({ eventType: "CONFERENCE" } as never) : undefined,
      submitterCtx: undefined,
    });

  it("Marketing: Events and Contacts; inside an event, Registrations and no Check-In", () => {
    const m = nav(MARKETING);
    expect(m.baseNavigation.map((i) => i.name).sort()).toEqual(["Contacts", "Events"]);
    expect(m.visibleEventSections.flatMap((s) => s.items.map((i) => i.name))).toEqual(["Registrations"]);
  });

  it("plain: nothing to open", () => {
    const m = nav([], false);
    expect(m.baseNavigation.map((i) => i.name)).not.toContain("Contacts");
    expect(m.baseNavigation.map((i) => i.name)).not.toContain("Settings");
  });
});

describe("the session token", () => {
  beforeEach(() => {
    clearSessionPermissionCache();
    mockDb.permissionSet.findMany.mockReset();
  });

  it("carries the desk and the Contacts page for Marketing", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([
      {
        id: "marketing",
        version: 1,
        archivedAt: null,
        permissions: [
          { permission: "events.read", scope: "ALL" },
          { permission: "registrations.read", scope: "ALL" },
          { permission: "registrations.export", scope: "ALL" },
          { permission: "contacts.read", scope: null },
          { permission: "contacts.export", scope: null },
        ],
      },
    ]);
    expect((await extraAreasForToken("BASE", "org-1", [["marketing", 1]]))?.sort()).toEqual(["desk", "org:/contacts"]);
  });
});

describe("private contact columns (D4)", () => {
  it("every built-in role that exports contacts or registrations also exports the private columns, so none loses them", () => {
    for (const key of SYSTEM_ROLE_KEYS) {
      const keys = new Set(systemRoleFor(key)?.grants.map((g) => g.permission) ?? []);
      if (keys.has("contacts.export") || keys.has("registrations.export")) {
        expect(keys.has("contacts.export.sensitive"), key).toBe(true);
      }
    }
  });

  it("the Marketing role does not include them", () => {
    expect(can(person(MARKETING), "contacts.export.sensitive")).toBe(false);
  });
});
