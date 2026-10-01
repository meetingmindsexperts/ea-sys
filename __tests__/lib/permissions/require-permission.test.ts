/**
 * `requirePermission()` at the route boundary (custom roles Phase 1 slice 4):
 * who is asking, whether they hold the key, which events (the `where` comes
 * from the same key), and the resulting-object rule of plan §3.2 that replaces
 * the two hand-written WEBINAR_ONLY checks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "next-auth";

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: mockWarn, info: vi.fn(), error: vi.fn() } }));

import { principalFromApiKey, principalFromSession, requirePermission } from "@/lib/permissions/require-permission";
import { eventWhereFor } from "@/lib/permissions/can";

const session = (role: string, extra: Record<string, unknown> = {}, organizationId: string | null = "org-1") =>
  ({ user: { id: "user-1", role, organizationId, firstName: "F", lastName: "L", ...extra } }) as unknown as Session;

const status = async (gate: ReturnType<typeof requirePermission>) => (gate.ok ? 200 : gate.response.status);

beforeEach(() => vi.clearAllMocks());

describe("who is asking", () => {
  it("401 with no session or a session without a user, and logs the route", async () => {
    expect(await status(requirePermission(null, "events.read", { route: "r:GET" }))).toBe(401);
    expect(await status(requirePermission({} as Session, "events.read", { route: "r:GET" }))).toBe(401);
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ msg: "permissions:unauthenticated", route: "r:GET" }));
  });
});

describe("holding the key", () => {
  it("403 with the same body denyReviewer gives, and a log naming the route and key", async () => {
    const gate = requirePermission(session("MEMBER"), "events.delete", { route: "events/[eventId]:DELETE" });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.response.status).toBe(403);
    expect(await gate.response.json()).toEqual({ error: "Forbidden" });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "permissions:denied", route: "events/[eventId]:DELETE", permission: "events.delete", role: "MEMBER" }),
    );
  });

  it("an organisation-wide key passes with no event filter", () => {
    const gate = requirePermission(session("ADMIN"), "org.settings", { route: "r" });
    expect(gate.ok && gate.eventWhere).toBeNull();
  });

  it("refuses an org-less staff account an organisation-wide key (requireOrgId's job today)", async () => {
    expect(await status(requirePermission(session("ADMIN", {}, null), "org.settings", { route: "r" }))).toBe(403);
  });
});

describe("which events", () => {
  it("eventWhere is eventWhereFor of the same key and event", () => {
    const gate = requirePermission(session("ONSITE"), "registrations.checkin", { route: "r", eventId: "ev-1" });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.eventWhere).toEqual(eventWhereFor(gate.principal, "registrations.checkin", "ev-1"));
    expect(gate.eventWhere).toEqual({ id: "ev-1", organizationId: "org-1", settings: { path: ["onsiteUserIds"], array_contains: "user-1" } });
  });

  it("WEBINARS reaches every event for the desk and only webinars for control", () => {
    const desk = requirePermission(session("WEBINARS"), "registrations.checkin", { route: "r", eventId: "ev-1" });
    const control = requirePermission(session("WEBINARS"), "sessions.write", { route: "r", eventId: "ev-1" });
    expect(desk.ok && desk.eventWhere).toEqual({ id: "ev-1", organizationId: "org-1" });
    expect(control.ok && control.eventWhere).toEqual({ id: "ev-1", organizationId: "org-1", eventType: "WEBINAR" });
  });
});

describe("the resulting-object rule (§3.2)", () => {
  it("a WEBINAR-scoped events.create may create a webinar and not a conference", async () => {
    expect(await status(requirePermission(session("WEBINARS"), "events.create", { route: "events:POST", resulting: { eventType: "WEBINAR" } }))).toBe(200);
    const refused = requirePermission(session("WEBINARS"), "events.create", { route: "events:POST", resulting: { eventType: "CONFERENCE" } });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.response.status).toBe(403);
    expect((await refused.response.json()).code).toBe("OUT_OF_SCOPE");
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ msg: "permissions:resulting-out-of-scope", eventType: "CONFERENCE" }));
  });

  it("a WEBINAR-scoped events.update cannot flip a webinar into a conference", async () => {
    expect(await status(requirePermission(session("WEBINARS"), "events.update", { route: "r", eventId: "ev-1", resulting: { eventType: "CONFERENCE" } }))).toBe(403);
  });

  it("an ALL-scoped grant creates either kind", async () => {
    for (const eventType of ["WEBINAR", "CONFERENCE", "HYBRID"]) {
      expect(await status(requirePermission(session("ORGANIZER"), "events.create", { route: "r", resulting: { eventType } }))).toBe(200);
    }
  });
});

describe("principals", () => {
  it("custom-role keys on the session become grants; keys the build does not enforce are dropped", () => {
    const plain = principalFromSession(session("MEMBER"));
    const p = principalFromSession(session("MEMBER", { procurementPermissions: ["procurement.orders.view", "events.delete", "not.a.key"] }));
    expect(p.grants.slice(plain.grants.length)).toEqual([{ permission: "procurement.orders.view" }]);
  });

  it("the person grants ride from the session", () => {
    const p = principalFromSession(session("MEMBER", { hrAccess: true, procurementApproveCeilingAed: 500 }));
    expect(p.personGrants).toMatchObject({ hrAccess: true, procurementApproveCeilingAed: 500 });
  });

  it("an API key principal is the API_KEY row, accepted in place of a session", async () => {
    const key = principalFromApiKey("org-1");
    expect(key.fromApiKey).toBe(true);
    expect(await status(requirePermission(key, "events.read", { route: "events:GET" }))).toBe(200);
  });
});
