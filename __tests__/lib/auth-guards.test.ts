import { describe, it, expect, vi, beforeEach } from "vitest";

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

import { denyReviewer, denyFinance, REGISTRATION_DESK_ALLOW } from "@/lib/auth-guards";

describe("denyReviewer", () => {
  it("returns 403 for REVIEWER role", async () => {
    const result = denyReviewer({ user: { role: "REVIEWER" } }, { route: "test" });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body).toEqual({ error: "Forbidden" });
  });

  it("returns 403 for SUBMITTER role", async () => {
    const result = denyReviewer({ user: { role: "SUBMITTER" } }, { route: "test" });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body).toEqual({ error: "Forbidden" });
  });

  it("returns 403 for MEMBER role (read-only viewer — no writes)", async () => {
    const result = denyReviewer({ user: { role: "MEMBER" } }, { route: "test" });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(await result!.json()).toEqual({ error: "Forbidden" });
  });

  it("returns 403 for REGISTRANT role", async () => {
    const result = denyReviewer({ user: { role: "REGISTRANT" } }, { route: "test" });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(await result!.json()).toEqual({ error: "Forbidden" });
  });

  // Contacts write routes (POST/PUT/DELETE/bulk-tags/import/email) route
  // their guard through denyReviewer via { user: { role: ctx.role ?? undefined } }.
  // API-key auth has ctx.role === null → undefined → must pass through
  // (keys are org admin-equivalent; MEMBER cannot mint them).
  it("returns null when role is undefined (API-key auth, admin-equivalent)", () => {
    expect(denyReviewer({ user: { role: undefined } }, { route: "test" })).toBeNull();
  });

  it("returns null for ADMIN role", () => {
    expect(denyReviewer({ user: { role: "ADMIN" } }, { route: "test" })).toBeNull();
  });

  it("returns null for SUPER_ADMIN role", () => {
    expect(denyReviewer({ user: { role: "SUPER_ADMIN" } }, { route: "test" })).toBeNull();
  });

  it("returns null for ORGANIZER role", () => {
    expect(denyReviewer({ user: { role: "ORGANIZER" } }, { route: "test" })).toBeNull();
  });

  it("returns null for null session", () => {
    expect(denyReviewer(null, { route: "test" })).toBeNull();
  });

  it("returns null for session with no user", () => {
    expect(denyReviewer({}, { route: "test" })).toBeNull();
  });

  it("returns null for session with user but no role", () => {
    expect(denyReviewer({ user: {} }, { route: "test" })).toBeNull();
  });

  // ONSITE (registration-desk staff) is restricted by default …
  it("returns 403 for ONSITE role by default", async () => {
    const result = denyReviewer({ user: { role: "ONSITE" } }, { route: "test" });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(await result!.json()).toEqual({ error: "Forbidden" });
  });

  // … but is let through on the routes it is permitted to write.
  it("returns null for ONSITE when allowed (create / check-in / badges)", () => {
    expect(denyReviewer({ user: { role: "ONSITE" } }, { allow: ["ONSITE"], route: "test" })).toBeNull();
  });

  it("still blocks other restricted roles even when ONSITE is allowed", () => {
    expect(denyReviewer({ user: { role: "MEMBER" } }, { allow: ["ONSITE"], route: "test" })).not.toBeNull();
    expect(denyReviewer({ user: { role: "REVIEWER" } }, { allow: ["ONSITE"], route: "test" })).not.toBeNull();
  });

  it("does not affect privileged roles when an allow-list is passed", () => {
    expect(denyReviewer({ user: { role: "ORGANIZER" } }, { allow: ["ONSITE"], route: "test" })).toBeNull();
  });

  // Registration-desk roles (ONSITE + MEMBER) are blocked by default …
  it("blocks ONSITE + MEMBER by default", () => {
    expect(denyReviewer({ user: { role: "ONSITE" } }, { route: "test" })).not.toBeNull();
    expect(denyReviewer({ user: { role: "MEMBER" } }, { route: "test" })).not.toBeNull();
  });

  // … and both pass on the registration-desk routes (REGISTRATION_DESK_ALLOW).
  it("lets ONSITE + MEMBER through with REGISTRATION_DESK_ALLOW", () => {
    expect(denyReviewer({ user: { role: "ONSITE" } }, { allow: REGISTRATION_DESK_ALLOW, route: "test" })).toBeNull();
    expect(denyReviewer({ user: { role: "MEMBER" } }, { allow: REGISTRATION_DESK_ALLOW, route: "test" })).toBeNull();
  });

  it("still blocks abstract/attendee roles even with REGISTRATION_DESK_ALLOW", () => {
    expect(denyReviewer({ user: { role: "REVIEWER" } }, { allow: REGISTRATION_DESK_ALLOW, route: "test" })).not.toBeNull();
    expect(denyReviewer({ user: { role: "REGISTRANT" } }, { allow: REGISTRATION_DESK_ALLOW, route: "test" })).not.toBeNull();
  });
});

/**
 * The refusal is logged inside the guard so no call site can forget it. The
 * cost of that is the log line only knows what the guard knows: on Aug 10, 2026
 * a burst of 51 warnings carried role and userId but no route, and placing them
 * took a five-step deduction (grep the page's hooks, cross-reference which of
 * them carry which guard) that one field would have answered.
 *
 * It was optional until Aug 25 2026, on the reasoning that a route no
 * restricted role can reach never logs. That reasoning assumed you already
 * know which routes are reachable, and being wrong about that is the bug
 * class: on Aug 24 the abstract-reviewers GET turned out to be reachable by
 * MEMBER and ONSITE, which nobody expected. `route` is now required on
 * denyReviewer, so the compiler asks once, at the only moment anyone knows
 * the answer.
 *
 * These pin that it survives to the log line, since a context parameter that
 * quietly gets dropped is worse than none: it reads as "this route has no
 * route field" rather than "nobody passed one".
 */
describe("guard refusals carry route context", () => {
  beforeEach(() => warnSpy.mockClear());

  it("logs route + eventId on a denied write", () => {
    denyReviewer({ user: { role: "SUBMITTER", id: "u1" } }, { allow: ["WEBINARS"],
      route: "tags:list",
      eventId: "ev1" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatchObject({
      msg: "auth-guard:write-denied",
      role: "SUBMITTER",
      userId: "u1",
      route: "tags:list",
      eventId: "ev1",
    });
  });

  it("always names the route, and omits eventId rather than logging undefined", () => {
    // `route` became REQUIRED on Aug 25 2026, so the old version of this test
    // — which asserted the shape when no route was given — describes a state
    // the compiler no longer permits. `eventId` is still optional: a route
    // with no event in scope should not log `eventId: undefined`.
    denyReviewer({ user: { role: "REVIEWER", id: "u2" } }, { route: "contacts:POST" });
    const payload = warnSpy.mock.calls[0][0];
    expect(payload).toMatchObject({ route: "contacts:POST" });
    expect(payload).not.toHaveProperty("eventId");
  });

  it("does not log at all when the role is allowed through", () => {
    warnSpy.mockClear();
    expect(denyReviewer({ user: { role: "ONSITE" } }, { allow: REGISTRATION_DESK_ALLOW, route: "registrations:create" })).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("carries the same shape on a finance refusal", () => {
    denyFinance({ user: { role: "REVIEWER", id: "u3" } }, { route: "invoices:list", eventId: "ev9" });
    expect(warnSpy.mock.calls[0][0]).toMatchObject({
      msg: "auth-guard:finance-denied",
      route: "invoices:list",
      eventId: "ev9",
    });
  });
});
