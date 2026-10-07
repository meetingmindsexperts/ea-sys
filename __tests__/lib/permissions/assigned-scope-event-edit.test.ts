/**
 * Phase 6 review (Oct 7, 2026): a custom role granting an event key at the
 * ASSIGNED scope could never save an event, because the event edit's
 * resulting-object check was given the event type but not its desk staff.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("next/server", () => ({ NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, body: b }) } }));

import { refuseOutOfScope } from "@/lib/permissions/require-permission";
import { principalFromUser } from "@/lib/permissions/can";

const assignedEditor = principalFromUser({ id: "u1", role: "MEMBER", organizationId: "org1", procurementPermissions: ["events.settings@ASSIGNED"] });

describe("an ASSIGNED-scope grant on the event edit", () => {
  it("passes on an event the person is assigned to", () => {
    expect(refuseOutOfScope(assignedEditor, "events.settings", { eventType: "CONFERENCE", staffUserIds: ["u1"] }, { route: "t" })).toBeNull();
  });

  it("is refused on an event they are not assigned to", () => {
    expect(refuseOutOfScope(assignedEditor, "events.settings", { eventType: "CONFERENCE", staffUserIds: ["someone-else"] }, { route: "t" })?.status).toBe(403);
  });

  it("the event PUT hands the stored staff to the check", () => {
    const src = readFileSync("src/app/api/events/[eventId]/route.ts", "utf8");
    const call = src.slice(src.indexOf("const outOfScope = refuseOutOfScope("), src.indexOf("if (outOfScope) return outOfScope;"));
    expect(call).toContain("staffUserIds:");
  });
});
