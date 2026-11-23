/**
 * GET /api/events/[eventId]/webinar/presence: the summary and the CSV of the
 * page attendance report (Nov 16, 2026). Pins: the CSV asks the attendance
 * export permission (the summary asks only to read), is rate-limited, audited,
 * never cached, and reads the whole record, not the live 60-second window.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockDb: { event: { findFirst: vi.fn() }, webinarPresence: { findMany: vi.fn(), groupBy: vi.fn() } },
  permSpy: vi.fn(),
  exportSpy: vi.fn(),
  rate: { allowed: true },
}));

vi.mock("next/server", () => {
  class NextResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
    constructor(body: string, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = init?.headers ?? {};
    }
    async text() {
      return this.body;
    }
    async json() {
      return JSON.parse(this.body);
    }
    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new NextResponse(JSON.stringify(body), init);
    }
  }
  return { NextResponse };
});
vi.mock("@/lib/auth", () => ({ auth: () => h.mockAuth() }));
vi.mock("@/lib/logger", () => ({ apiLogger: h.mockLogger }));
vi.mock("@/lib/db", () => ({ db: h.mockDb }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: h.rate.allowed, retryAfterSeconds: 60 }) }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordExport: (...a: unknown[]) => h.exportSpy(...a) }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: (_s: unknown, key: string) => h.permSpy(key),
}));

import { GET } from "@/app/api/events/[eventId]/webinar/presence/route";

const ctx = { params: Promise.resolve({ eventId: "ev1" }) };
const req = (query: string) => new Request(`http://localhost/api/events/ev1/webinar/presence${query}`);

const ROW = {
  phase: "joined",
  firstJoinedAt: new Date("2026-12-20T09:55:00Z"),
  lastSeenAt: new Date("2026-12-20T11:02:00Z"),
  joinCount: 2,
  watchedSeconds: 3_000,
  // A row from before Nov 23, 2026: no watch analytics yet (the columns' defaults).
  deviceType: null,
  browser: null,
  os: null,
  viewMode: null,
  stallCount: 0,
  stallSeconds: 0,
  reconnectCount: 0,
  watchedMinutes: [],
  registration: { serialId: 7, attendee: { firstName: "Aisha", lastName: "Khan", email: "aisha@x.com" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.rate.allowed = true;
  h.mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  h.permSpy.mockReturnValue({ ok: true, principal: { organizationId: "org1", baseRole: "ADMIN", fromApiKey: false }, eventWhere: { id: "ev1" } });
  h.mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: { webinar: { sessionId: "s1" } }, timezone: "Asia/Dubai" });
  h.mockDb.webinarPresence.findMany.mockResolvedValue([ROW]);
});

describe("the page attendance report", () => {
  it("the CSV asks the attendance export permission, and a refusal stops it", async () => {
    h.permSpy.mockReturnValue({ ok: false, response: { status: 403 } });
    const res = await GET(req("?export=csv"), ctx);
    expect(res.status).toBe(403);
    expect(h.permSpy).toHaveBeenCalledWith("webinar.attendance.export");
    expect(h.mockDb.webinarPresence.findMany).not.toHaveBeenCalled();
  });

  it("the CSV: every row of the session (no live window), audited, never cached", async () => {
    const res = (await GET(req("?export=csv"), ctx)) as unknown as { status: number; headers: Record<string, string>; text(): Promise<string> };
    expect(res.status).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
    expect(res.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["Content-Disposition"]).toContain("webinar-page-attendance-ev1.csv");
    const where = h.mockDb.webinarPresence.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ sessionId: "s1", eventId: "ev1" });
    const lines = (await res.text()).split("\n");
    expect(lines[1]).toBe("Aisha Khan,aisha@x.com,007,2026-12-20 13:55,2026-12-20 15:02,2,50,,,,,,0,0,0");
    expect(h.exportSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ entityType: "WebinarPresence", rowCount: 1, format: "csv" }));
  });

  it("rate limited: 429 with the time to wait, nothing read", async () => {
    h.rate.allowed = false;
    const res = await GET(req("?export=csv"), ctx);
    expect(res.status).toBe(429);
    expect(h.mockDb.webinarPresence.findMany).not.toHaveBeenCalled();
    expect(h.mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1" }), "webinar-presence:export-rate-limited");
  });

  it("the summary asks only to read, is counted by the database, and carries no names", async () => {
    h.mockDb.webinarPresence.groupBy.mockResolvedValue([
      { phase: "joined", _count: { _all: 1 }, _sum: { watchedSeconds: 3_000 } },
      { phase: "lobby", _count: { _all: 1 }, _sum: { watchedSeconds: 0 } },
    ]);
    const res = await GET(req("?view=summary"), ctx);
    expect(h.permSpy).toHaveBeenCalledWith("webinar.analytics.read");
    expect(await res.json()).toEqual({ opened: 2, joined: 1, totalWatchedSeconds: 3_000, avgWatchedSeconds: 3_000 });
    expect(h.mockDb.webinarPresence.groupBy).toHaveBeenCalledWith(expect.objectContaining({ by: ["phase"], where: { sessionId: "s1", eventId: "ev1" } }));
    expect(h.mockDb.webinarPresence.findMany).not.toHaveBeenCalled();
    expect(h.exportSpy).not.toHaveBeenCalled();
  });

  it("the watch analytics ask only to read, count the people who reached the live view, and carry no names", async () => {
    h.mockDb.webinarPresence.findMany.mockResolvedValue([
      { ...ROW, registration: undefined, deviceType: "mobile", browser: "Safari", os: "iOS", viewMode: "stream", stallCount: 2 },
    ]);
    const res = await GET(req("?view=analytics"), ctx);
    expect(h.permSpy).toHaveBeenCalledWith("webinar.analytics.read");
    const query = h.mockDb.webinarPresence.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ sessionId: "s1", eventId: "ev1", phase: "joined" });
    expect(query.select).not.toHaveProperty("registration");
    const body = await res.json();
    expect(body).toMatchObject({ watched: 1, devices: [{ label: "Phone", count: 1 }], playback: { streamViewers: 1, buffered: 1 } });
    expect(JSON.stringify(body)).not.toContain("aisha");
    expect(h.exportSpy).not.toHaveBeenCalled();
  });

  it("no webinar session yet: the CSV is a logged 409, the summary is empty", async () => {
    h.mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: {}, timezone: "Asia/Dubai" });
    expect((await GET(req("?export=csv"), ctx)).status).toBe(409);
    expect(h.mockLogger.warn).toHaveBeenCalledWith(expect.anything(), "webinar-presence:export-no-anchor-session");
    expect(await (await GET(req("?view=summary"), ctx)).json()).toEqual({ opened: 0, joined: 0, totalWatchedSeconds: 0, avgWatchedSeconds: 0 });
  });
});
