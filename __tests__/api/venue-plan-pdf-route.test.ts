/**
 * GET /api/events/:eventId/venue/plan-pdf with the REAL permission code: dark
 * while VENUE_MODULE_ENABLED is off, anyone who sees the event may download,
 * a bad paper size and missing rooms are refused in plain words, the hourly
 * limit holds, and stand n carries the nth sponsor in the venue's order.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TEMPLATES } from "@/lib/venue/rooms";

const { mockAuth, mockDb, rateLimit, render, programme } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() } },
  rateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
  render: vi.fn<(input: unknown) => Promise<Buffer>>(async () => Buffer.from("%PDF-1.3 test")),
  programme: vi.fn(async () => ({ v: 1, tz: "Asia/Dubai", sessions: [], sponsors: [{ name: "Pfizer" }, { name: "Novartis" }] })),
}));

vi.mock("next/server", () => {
  class NextResponse {
    status: number;
    headers: Headers;
    body: unknown;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }
    static json(b: unknown, i?: { status?: number; headers?: Record<string, string> }) {
      const r = new NextResponse(b, i);
      return Object.assign(r, { json: async () => b });
    }
  }
  return { NextResponse };
});
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", async (orig) => ({ ...(await orig<typeof import("@/lib/security")>()), checkRateLimit: rateLimit }));
vi.mock("@/services/venue-programme-service", () => ({ loadVenueProgramme: programme }));
vi.mock("@/lib/venue/floor-plan-pdf", async (orig) => ({ ...(await orig<typeof import("@/lib/venue/floor-plan-pdf")>()), renderFloorPlanPdf: render }));

import { GET } from "@/app/api/events/[eventId]/venue/plan-pdf/route";

type Res = { status: number; headers: Headers; json?: () => Promise<Record<string, unknown>> };
const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const as = (role: string) => mockAuth.mockResolvedValue({ user: { id: `u-${role}`, role, organizationId: "org-1" } });
const get = (q = "") => GET(new Request(`http://localhost/x${q}`), params) as Promise<Res>;
const savedRooms = { venue: { rooms: { list: TEMPLATES.congress.rooms, updatedAt: 5, updatedBy: "u" } } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VENUE_MODULE_ENABLED", "true");
  mockDb.event.findFirst.mockResolvedValue({
    id: "evt-1", name: "Summit", slug: "summit-27", organizationId: "org-1", settings: savedRooms,
    startDate: new Date("2027-03-12T05:00:00Z"), endDate: new Date("2027-03-14T15:00:00Z"), timezone: "Asia/Dubai",
    venue: "Atlantis", city: "Dubai", country: "United Arab Emirates",
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/events/:eventId/venue/plan-pdf", () => {
  it("404 while the module is off", async () => {
    vi.stubEnv("VENUE_MODULE_ENABLED", "");
    as("ADMIN");
    expect((await get()).status).toBe(404);
  });

  it("401 without a session, 403 for a role that cannot see events", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    as("HR_USER");
    expect((await get()).status).toBe(403);
  });

  it("a member downloads the A3 PDF by default, named after the event", async () => {
    as("MEMBER");
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="summit-27-floor-plan-A3.pdf"');
    const input = render.mock.calls[0][0] as unknown as { paper: string; sponsors: { id: string; name: string }[]; dateLine: string; place: string };
    expect(input.paper).toBe("A3");
    expect(input.sponsors.map((s) => s.name)).toEqual(["Pfizer", "Novartis"]);
    expect(input.dateLine).toBe("12 to 14 March 2027");
    expect(input.place).toBe("Atlantis, Dubai, United Arab Emirates");
  });

  it("A4 on request; any other paper is a 400", async () => {
    as("ADMIN");
    expect((await get("?paper=A4")).status).toBe(200);
    expect((render.mock.calls[0][0] as unknown as { paper: string }).paper).toBe("A4");
    const bad = await get("?paper=Letter");
    expect(bad.status).toBe(400);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("409 in plain words when no rooms are saved", async () => {
    as("ADMIN");
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1", name: "S", slug: "s", organizationId: "org-1", settings: {}, startDate: new Date(), endDate: new Date(), timezone: "Asia/Dubai", venue: null, city: null, country: null });
    const res = await get();
    expect(res.status).toBe(409);
    expect((await res.json!()).code).toBe("NO_ROOMS");
    expect(render).not.toHaveBeenCalled();
  });

  it("429 with Retry-After at the hourly limit, before any render", async () => {
    as("ADMIN");
    rateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 600 });
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("600");
    expect(render).not.toHaveBeenCalled();
    expect(rateLimit).toHaveBeenCalledWith(expect.objectContaining({ key: "venue-plan-pdf:u-ADMIN", limit: 30 }));
  });
});

describe("the place line", () => {
  it("says a repeated part once", async () => {
    as("ADMIN");
    mockDb.event.findFirst.mockResolvedValueOnce({
      id: "evt-1", name: "S", slug: "s", organizationId: "org-1", settings: savedRooms,
      startDate: new Date("2027-03-12T05:00:00Z"), endDate: new Date("2027-03-12T05:00:00Z"), timezone: "Asia/Dubai",
      venue: "Dubai", city: "dubai", country: "United Arab Emirates",
    });
    await get();
    expect((render.mock.calls[0][0] as unknown as { place: string }).place).toBe("Dubai, United Arab Emirates");
  });
});
