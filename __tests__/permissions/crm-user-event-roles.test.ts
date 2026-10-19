/**
 * A custom role may add event work to a CRM User (owner, Oct 19, 2026): the
 * "Sales" role (see events, manage sponsors) on a salesperson. Pins that:
 *  - the role fits (no OUTSIDE_AREAS), and only within events, the desk and
 *    the organisation (CRM_USER.extendableAreas);
 *  - the person works events only WHILE a held role grants a key there: a
 *    plain CRM User is exactly as confined as before;
 *  - the sidebar, page confinement and the session token agree.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({ mockDb: { permissionSet: { findMany: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ authLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/module-flags", () => ({ isCustomRolesEnabled: () => true }));

import { customGrantAreas, grantsOutsideAreas } from "@/lib/permissions/key-areas";
import { can, inArea, principalFromUser } from "@/lib/permissions/can";
import { confinementRedirect } from "@/lib/route-confinement";
import { computeSidebarNav } from "@/components/layout/sidebar-nav";
import { clearSessionPermissionCache, extraAreasForToken } from "@/lib/permissions/session-permissions";

const SALES = ["events.read@ALL", "sponsors.read@ALL", "sponsors.manage@ALL", "crm.export"];
const crmUser = (keys: string[] = []) =>
  principalFromUser({ id: "u1", role: "CRM_USER", organizationId: "org-1", procurementPermissions: keys });

describe("the area rule", () => {
  it("a Sales role fits a CRM User; Budgets still does not", () => {
    const g = (permission: string, scope: "ALL" | null = null) => ({ permission, scope });
    expect(grantsOutsideAreas("CRM_USER", [g("events.read", "ALL"), g("sponsors.manage", "ALL"), g("contacts.read")])).toEqual([]);
    expect(grantsOutsideAreas("CRM_USER", [g("procurement.budgets.view")])).toHaveLength(1);
  });

  it("the extra areas come only from keys a role actually grants", () => {
    expect(customGrantAreas("CRM_USER", [{ permission: "crm.export", scope: null }])).toEqual([]);
    expect(customGrantAreas("CRM_USER", [{ permission: "sponsors.manage", scope: "ALL" }]).map((a) => a.area)).toEqual(["events"]);
    // A key the CRM User already holds (contacts.read) opens nothing, so no Settings.
    expect(customGrantAreas("CRM_USER", [{ permission: "contacts.read", scope: null }])).toEqual([]);
    // A role without extendable areas gains nothing from any key.
    expect(customGrantAreas("ONSITE", [{ permission: "sponsors.manage", scope: "ALL" }])).toEqual([]);
  });
});

describe("the person", () => {
  it("a plain CRM User works the CRM only, as before", () => {
    const p = crmUser();
    expect(inArea(p, "crm")).toBe(true);
    expect(inArea(p, "events")).toBe(false);
    expect(inArea(p, "desk")).toBe(false);
  });

  it("with the Sales role: events and sponsors, nothing else of an organiser's", () => {
    const p = crmUser(SALES);
    expect(inArea(p, "events")).toBe(true);
    expect(can(p, "sponsors.manage", { event: { organizationId: "org-1", eventType: "CONFERENCE", staffUserIds: [] } })).toBe(true);
    expect(can(p, "events.update", { event: { organizationId: "org-1", eventType: "CONFERENCE", staffUserIds: [] } })).toBe(false);
    expect(can(p, "registrations.create", { event: { organizationId: "org-1", eventType: "CONFERENCE", staffUserIds: [] } })).toBe(false);
  });
});

describe("pages and the sidebar", () => {
  it("a plain CRM User is still sent to the CRM from Events", () => {
    expect(confinementRedirect("CRM_USER", "/events")).toBe("/crm");
    expect(confinementRedirect("CRM_USER", "/events/ev1/sponsors", { extraAreas: [] })).toBe("/crm");
  });

  it("a salesperson's home stays the CRM", () => {
    expect(confinementRedirect("CRM_USER", "/dashboard", { extraAreas: ["events", "desk"] })).toBe("/crm");
  });

  it("with the Sales role's areas, Events and an event's pages open; HR and Budgets do not", () => {
    const grants = { extraAreas: ["events", "desk", "org"] };
    expect(confinementRedirect("CRM_USER", "/events", grants)).toBeNull();
    expect(confinementRedirect("CRM_USER", "/events/ev1/sponsors", grants)).toBeNull();
    expect(confinementRedirect("CRM_USER", "/crm", grants)).toBeNull();
    expect(confinementRedirect("CRM_USER", "/procurement", grants)).not.toBeNull();
  });

  it("an area the base role cannot be extended into is ignored, whatever the cookie says", () => {
    expect(confinementRedirect("CRM_USER", "/procurement", { extraAreas: ["procurement"] })).not.toBeNull();
    expect(confinementRedirect("ONSITE", "/settings", { extraAreas: ["org"] })).not.toBeNull();
  });

  it("the sidebar shows Events and the event's Setup hub (where Sponsors lives) only with the role", () => {
    const nav = (keys: string[]) =>
      computeSidebarNav({
        user: { id: "u1", organizationId: "org-1", role: "CRM_USER", procurementPermissions: keys } as never,
        hrEnabled: false,
        procurementEnabled: false,
        isEventPage: true,
        currentEvent: { eventType: "CONFERENCE" } as never,
        submitterCtx: undefined,
      });
    expect(nav([]).baseNavigation.map((i) => i.name)).not.toContain("Events");
    const sales = nav(SALES);
    expect(sales.baseNavigation.map((i) => i.name)).toContain("Events");
    const items = sales.visibleEventSections.flatMap((s) => s.items.map((i) => i.name));
    expect(items).toContain("Event Setup");
    // Nothing the role does not grant: no registrations list without registrations.read.
    // (The event's Settings page opens read-only with events.read, as for a Member.)
    expect(items).not.toContain("Registrations");
  });
});

describe("the session token", () => {
  beforeEach(() => {
    clearSessionPermissionCache();
    mockDb.permissionSet.findMany.mockReset();
  });

  it("carries the areas the held roles add, from the roles' keys", async () => {
    mockDb.permissionSet.findMany.mockResolvedValue([
      { id: "sales", version: 1, archivedAt: null, permissions: [{ permission: "sponsors.manage", scope: "ALL" }, { permission: "events.read", scope: "ALL" }] },
    ]);
    expect((await extraAreasForToken("CRM_USER", "org-1", [["sales", 1]])).sort()).toEqual(["desk", "events"]);
  });

  it("asks nothing for a role custom roles cannot extend", async () => {
    expect(await extraAreasForToken("ORGANIZER", "org-1", [["sales", 1]])).toEqual([]);
    expect(mockDb.permissionSet.findMany).not.toHaveBeenCalled();
  });
});
