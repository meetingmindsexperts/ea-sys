/**
 * DTCM spare-code pool route — the role matrix (review B1).
 *
 * THE BUG THIS PINS. The route originally gated on `REGISTRATION_DESK_ALLOW`
 * alone, which is the right answer to "who staffs the desk" and the wrong
 * answer to "who may see a compliance credential". That allow-list includes
 * MEMBER; `BARCODE_ROLES` deliberately EXCLUDES it (July 11 2026, H6/H7/H8 — a
 * read-only internal viewer has no reason to hold something that opens a door).
 *
 * The leak was not theoretical and it was not write-only: the `already-has-code`
 * outcome returns the code sitting on someone else's row with no write at all.
 * And because MEMBER's registration payloads are redacted, every row rendered as
 * "Not set", so the button was offered on all of them — redaction turned it into
 * one click per registration across every event in the org.
 *
 * `denyReviewer`, `canViewEntryBarcode` and `buildEventAccessWhere` are all REAL
 * here. Mocking any of them would let the routes pass while calling nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockClaim, mockCounts } = vi.hoisted(() => ({
  mockDb: { event: { findFirst: vi.fn() } },
  mockAuth: vi.fn(),
  mockClaim: vi.fn(),
  mockCounts: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: () => ({ allowed: true }),
}));
vi.mock("@/lib/tenant-lane", () => ({
  runWithTenantLane: (_org: unknown, _ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/dtcm-pool", () => ({
  claimSpareDtcmCode: mockClaim,
  getDtcmPoolCounts: mockCounts,
}));

import { GET, POST } from "@/app/api/events/[eventId]/dtcm-pool/route";

const params = Promise.resolve({ eventId: "ev1" });
const req = (body: unknown = { registrationId: "r1" }) =>
  ({ json: async () => body, url: "http://x/api/events/ev1/dtcm-pool" }) as unknown as Request;

const as = (role: string) => ({
  user: { id: "u1", role, organizationId: "org1" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", requiresDtcmBarcode: true });
  mockCounts.mockResolvedValue({ total: 5, assigned: 2, spare: 3, assignedOutsidePool: 0 });
  mockClaim.mockResolvedValue({ status: "assigned", code: "DTCM-001" });
});

/** In BARCODE_ROLES — the people who actually run the door and print badges. */
const ALLOWED = ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "ONSITE", "WEBINARS"];
/**
 * MEMBER is the one that matters: it passes `denyReviewer`'s desk allow-list and
 * must still be refused here. The rest never reach the route at all.
 */
const REFUSED = ["MEMBER", "REVIEWER", "SUBMITTER", "REGISTRANT", "CRM_USER"];

describe("who may assign a DTCM code", () => {
  it.each(ALLOWED)("%s can read the pool and claim a code", async (role) => {
    mockAuth.mockResolvedValue(as(role));

    const get = await GET(req(), { params });
    expect(get.status).toBe(200);

    const post = await POST(req(), { params });
    expect(post.status).toBe(200);
    expect(await post.json()).toMatchObject({ status: "assigned", code: "DTCM-001" });
  });

  it.each(REFUSED)("%s is refused on BOTH verbs", async (role) => {
    mockAuth.mockResolvedValue(as(role));

    expect((await GET(req(), { params })).status).toBe(403);
    expect((await POST(req(), { params })).status).toBe(403);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockCounts).not.toHaveBeenCalled();
  });

  it("MEMBER specifically: passes the desk guard, still cannot reach a code", async () => {
    // The regression, stated on its own so it cannot be lost in a table. If
    // this ever returns 200, someone has re-gated the route on the desk
    // allow-list and reopened the leak.
    const { denyReviewer, REGISTRATION_DESK_ALLOW } = await import("@/lib/auth-guards");
    expect(
      denyReviewer({ user: { role: "MEMBER" } } as never, {
        allow: REGISTRATION_DESK_ALLOW,
        route: "test",
      }),
    ).toBeNull();

    mockAuth.mockResolvedValue(as("MEMBER"));
    const res = await POST(req(), { params });
    expect(res.status).toBe(403);
  });

  it("never leaks a code through the already-has-code path either", async () => {
    // That outcome is a pure READ of the value on someone else's row, so it is
    // the cheapest extraction primitive on the route.
    mockClaim.mockResolvedValue({ status: "already-has-code", code: "DTCM-SOMEONE-ELSE" });
    mockAuth.mockResolvedValue(as("MEMBER"));

    const res = await POST(req(), { params });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("DTCM-SOMEONE-ELSE");
  });

  it("refuses before spending the rate-limit budget", async () => {
    // Ordering matters: a refused role must not be able to exhaust another
    // caller's window by hammering the endpoint.
    const security = await import("@/lib/security");
    const spy = vi.spyOn(security, "checkRateLimit");
    mockAuth.mockResolvedValue(as("MEMBER"));

    await POST(req(), { params });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the rest of the gate still holds", () => {
  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET(req(), { params })).status).toBe(401);
    expect((await POST(req(), { params })).status).toBe(401);
  });

  it("404s an event the caller cannot reach — ONSITE assignment gating", async () => {
    // buildEventAccessWhere is real; an unassigned ONSITE temp resolves no
    // event, so they cannot drain another event's pool.
    mockDb.event.findFirst.mockResolvedValue(null);
    mockAuth.mockResolvedValue(as("ONSITE"));
    expect((await POST(req(), { params })).status).toBe(404);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("400s a claim with no registrationId", async () => {
    mockAuth.mockResolvedValue(as("ADMIN"));
    const res = await POST(req({}), { params });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "MISSING_REGISTRATION_ID" });
  });

  it("reports a non-DTCM event as disabled rather than erroring", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", requiresDtcmBarcode: false });
    mockAuth.mockResolvedValue(as("ADMIN"));
    expect(await (await GET(req(), { params })).json()).toEqual({ enabled: false, counts: null });
  });

  it("surfaces an empty pool as 409, not a silent success", async () => {
    mockClaim.mockResolvedValue({ status: "pool-empty" });
    mockAuth.mockResolvedValue(as("ONSITE"));
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
  });
});
