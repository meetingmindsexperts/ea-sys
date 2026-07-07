/**
 * ONSITE cross-event isolation (the fix for the adversarial-review BLOCKER B1–B4).
 *
 * ONSITE is scoped per-event via Event.settings.onsiteUserIds, but the desk
 * routes (registrations list/create, detail PUT, check-in, badge print) used to
 * authorize on ORG membership only — so an ONSITE user assigned to Event A could
 * read/write Event B in the same org. These pin that every desk route now routes
 * its event lookup through buildEventAccessWhere (REAL, not mocked), so:
 *   - an ONSITE user's event lookup is gated by settings.onsiteUserIds (→ 404 when
 *     unassigned), and
 *   - an ADMIN's lookup stays org-scoped (no assignment gate).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockOrgCtx } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockOrgCtx: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/api-auth", () => ({ getOrgContext: mockOrgCtx }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn().mockReturnValue({ catch: () => {} }) }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/services/registration-service", () => ({ createRegistration: vi.fn() }));
// buildEventAccessWhere + denyReviewer are REAL (pure) — the whole point is to
// prove the routes actually call the real scoping helper.

import { GET as listGET, POST as listPOST } from "@/app/api/events/[eventId]/registrations/route";
import { POST as checkinPOST } from "@/app/api/events/[eventId]/registrations/[registrationId]/check-in/route";
import { POST as badgesPOST } from "@/app/api/events/[eventId]/registrations/badges/route";

const ONSITE = { id: "onsite1", role: "ONSITE", organizationId: "org1" };
const ADMIN = { id: "admin1", role: "ADMIN", organizationId: "org1" };
const eventParams = Promise.resolve({ eventId: "evB" });
const regParams = Promise.resolve({ eventId: "evB", registrationId: "reg1" });

function lastEventWhere() {
  return mockDb.event.findFirst.mock.calls.at(-1)?.[0]?.where as Record<string, unknown>;
}
function expectAssignmentGated(userId: string) {
  expect(lastEventWhere()).toMatchObject({
    settings: { path: ["onsiteUserIds"], array_contains: userId },
  });
}
function expectOrgScopedOnly() {
  const where = lastEventWhere();
  expect(where).toHaveProperty("organizationId", "org1");
  expect(where).not.toHaveProperty("settings");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registration.findMany.mockResolvedValue([]);
  // Default: unassigned → the assignment-gated lookup returns nothing.
  mockDb.event.findFirst.mockResolvedValue(null);
});

describe("registrations LIST GET (API-key-aware)", () => {
  it("gates an ONSITE caller by assignment and 404s when unassigned", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", userId: "onsite1", role: "ONSITE" });
    const res = await listGET(new Request("http://localhost/api/events/evB/registrations"), { params: eventParams });
    expect(res.status).toBe(404);
    expectAssignmentGated("onsite1");
  });

  it("keeps an ADMIN caller org-scoped (no assignment gate)", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", userId: "admin1", role: "ADMIN" });
    mockDb.event.findFirst.mockResolvedValue({ id: "evB" });
    await listGET(new Request("http://localhost/api/events/evB/registrations"), { params: eventParams });
    expectOrgScopedOnly();
  });

  it("keeps an API-key caller (role null) org-scoped", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", userId: null, role: null });
    mockDb.event.findFirst.mockResolvedValue({ id: "evB" });
    await listGET(new Request("http://localhost/api/events/evB/registrations"), { params: eventParams });
    expectOrgScopedOnly();
  });
});

describe("registrations CREATE POST", () => {
  it("gates an ONSITE creator by assignment and 404s when unassigned", async () => {
    mockAuth.mockResolvedValue({ user: ONSITE });
    const req = new Request("http://localhost/api/events/evB/registrations", {
      method: "POST",
      body: JSON.stringify({ attendee: { email: "x@y.com", firstName: "A", lastName: "B" } }),
      headers: { "content-type": "application/json" },
    });
    const res = await listPOST(req, { params: eventParams });
    expect(res.status).toBe(404);
    expectAssignmentGated("onsite1");
  });
});

describe("check-in POST", () => {
  it("gates an ONSITE user by assignment and 404s when unassigned", async () => {
    mockAuth.mockResolvedValue({ user: ONSITE });
    const res = await checkinPOST(new Request("http://localhost/x", { method: "POST" }), { params: regParams });
    expect(res.status).toBe(404);
    expectAssignmentGated("onsite1");
  });

  it("keeps an ADMIN org-scoped", async () => {
    mockAuth.mockResolvedValue({ user: ADMIN });
    mockDb.event.findFirst.mockResolvedValue({ id: "evB" });
    // registration lookup after the event check is null → route 404s later, but
    // the event where-clause is what we assert.
    mockDb.registration.findFirst.mockResolvedValue(null);
    await checkinPOST(new Request("http://localhost/x", { method: "POST" }), { params: regParams });
    expectOrgScopedOnly();
  });
});

describe("badge print POST", () => {
  it("gates an ONSITE user by assignment and 404s when unassigned (badge PDFs carry entry barcodes)", async () => {
    mockAuth.mockResolvedValue({ user: ONSITE });
    const res = await badgesPOST(new Request("http://localhost/x", { method: "POST" }), { params: eventParams });
    expect(res.status).toBe(404);
    expectAssignmentGated("onsite1");
  });
});
