/**
 * The "API key (full)" system role equals what a key can actually reach: the
 * tool registry as built for a key, mapped through TOOL_PERMISSIONS, plus the
 * REST routes that authenticate a key, plus the field keys whose predicates
 * say yes to a key. Derived, not asserted by hand, so adding a tool without a
 * mapping, or widening the system role past the code, fails here (the first
 * review of Phase 1 found the row had been written from "would be admin",
 * some forty cells wider than the code).
 *
 * The registry is built against a recording stub (tool-registry.ts), so no
 * tool runs; the database is mocked away because the executors import it.
 */
import { eventFieldPermissions } from "@/lib/permissions/field-permissions";
import { EVENT_UPDATE_FIELD_WHITELIST } from "@/lib/agent/tools/events";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {}, dbOperator: {}, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  authLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  dbLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  eventLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { collectToolsForActor } from "@/lib/agent/tool-registry";
import { describePermission, type PermissionKey } from "@/lib/permissions/catalogue";
import { SYSTEM_ROLES } from "@/lib/permissions/system-roles";
import {
  API_KEY_FIELD_PERMISSIONS,
  REST_API_KEY_PERMISSIONS,
  TOOL_PERMISSIONS,
  TOOLS_REFUSED_TO_API_KEYS,
} from "@/lib/permissions/tool-permissions";

const toolsFor = (role: string, fromApiKey: boolean) =>
  collectToolsForActor({ organizationId: "org-1", actor: { userId: "user-1", role, fromApiKey }, source: "mcp" }).map((t) => t.name);

describe("every registered tool maps to a permission", () => {
  it.each(["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER"])("for %s", (role) => {
    const unmapped = toolsFor(role, false).filter((n) => !(n in TOOL_PERMISSIONS));
    expect(unmapped, "tools with no permission mapping").toEqual([]);
  });

  it("and every mapping names a catalogue key", () => {
    for (const [tool, key] of Object.entries(TOOL_PERMISSIONS)) {
      expect(describePermission(key), `${tool} -> ${key}`).toBeDefined();
    }
  });
});

describe("the API key (full) system role is exactly the key's reach", () => {
  it("tools plus key-capable REST routes plus the field keys, nothing more and nothing less", () => {
    const keyTools = toolsFor("", true).filter((n) => !TOOLS_REFUSED_TO_API_KEYS.has(n));
    expect(keyTools.length).toBeGreaterThan(100);
    const reach = new Set<PermissionKey>([
      ...keyTools.map((n) => TOOL_PERMISSIONS[n]),
      ...REST_API_KEY_PERMISSIONS.map((r) => r.permission),
      ...API_KEY_FIELD_PERMISSIONS,
      // update_event asks each changed field's own key beside its tool key
      // (field-permissions.ts), so its allowed fields are reach too.
      ...eventFieldPermissions([...EVENT_UPDATE_FIELD_WHITELIST]),
    ]);
    const held = new Set(SYSTEM_ROLES.API_KEY.grants.map((g) => g.permission));
    expect([...held].filter((k) => !reach.has(k)).sort(), "held by the system role but reachable by no tool or key route").toEqual([]);
    expect([...reach].filter((k) => !held.has(k)).sort(), "reachable but missing from the system role").toEqual([]);
  });

  it("holds every event-bound key at ALL and nothing from the per-person surfaces", () => {
    for (const g of SYSTEM_ROLES.API_KEY.grants) {
      if (describePermission(g.permission)?.eventBound) expect(g.scope, g.permission).toBe("ALL");
    }
    const held = new Set(SYSTEM_ROLES.API_KEY.grants.map((g) => g.permission));
    for (const k of ["hr.read", "loginActivity.read", "supportingDocs.view", "crm.purge", "users.manage", "roles.manage", "agent.use", "procurement.budgets.view"] as PermissionKey[]) {
      expect(held.has(k), k).toBe(false);
    }
  });
});
