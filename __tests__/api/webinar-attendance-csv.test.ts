/**
 * The Zoom attendance CSV (Nov 25, 2026): each attendee's role, specialty,
 * organisation and country beside their name, read from the registration
 * Zoom's row was matched to. A Zoom guest with no registration keeps blank
 * cells, so no column shifts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockDb: {
    event: { findFirst: vi.fn() },
    zoomMeeting: { findFirst: vi.fn() },
    zoomAttendance: { findMany: vi.fn() },
    registration: { count: vi.fn() },
    organization: { findUnique: vi.fn() },
  },
  permSpy: vi.fn(),
  exportSpy: vi.fn(),
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
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordExport: (...a: unknown[]) => h.exportSpy(...a) }));
vi.mock("@/lib/webinar-attendance", () => ({ syncWebinarAttendance: vi.fn() }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: (_s: unknown, key: string) => h.permSpy(key),
}));

import { GET } from "@/app/api/events/[eventId]/webinar/attendance/route";

const ctx = { params: Promise.resolve({ eventId: "ev1" }) };
const req = (query: string) => new Request(`http://localhost/api/events/ev1/webinar/attendance${query}`);

const MATCHED = {
  id: "a1",
  name: "Aisha Khan",
  email: "aisha@x.com",
  joinTime: new Date("2026-12-20T10:00:00Z"),
  leaveTime: new Date("2026-12-20T10:50:00Z"),
  durationSeconds: 3_000,
  attentivenessScore: null,
  registrationId: "r1",
  registration: {
    serialId: 7,
    attendee: { role: "PHYSICIAN", specialty: "Hematology", organization: "SKMC, Abu Dhabi", country: "United Arab Emirates" },
  },
};
const GUEST = { ...MATCHED, id: "a2", name: "Guest", email: null, registrationId: null, registration: null };

beforeEach(() => {
  vi.clearAllMocks();
  h.mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  h.permSpy.mockReturnValue({ ok: true, principal: { organizationId: "org1" }, eventWhere: { id: "ev1" } });
  h.mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "W", settings: { webinar: { sessionId: "s1" } } });
  h.mockDb.zoomMeeting.findFirst.mockResolvedValue({ id: "z1", lastAttendanceSyncAt: null });
  h.mockDb.zoomAttendance.findMany.mockResolvedValue([MATCHED, GUEST]);
  h.mockDb.registration.count.mockResolvedValue(10);
  h.mockDb.organization.findUnique.mockResolvedValue({ settings: {} });
});

describe("the Zoom attendance CSV", () => {
  it("names each attendee's role (by its label), specialty, organisation and country after the email", async () => {
    const res = (await GET(req("?export=csv"), ctx)) as unknown as { status: number; text(): Promise<string> };
    expect(res.status).toBe(200);
    expect(h.permSpy).toHaveBeenCalledWith("webinar.attendance.export");
    const lines = (await res.text()).split("\n");
    expect(lines[0]).toBe("Name,Email,Role,Specialty,Organization,Country,Join Time,Leave Time,Duration (min),Attentiveness,Registration #");
    expect(lines[1]).toBe(
      'Aisha Khan,aisha@x.com,Physician,Hematology,"SKMC, Abu Dhabi",United Arab Emirates,2026-12-20T10:00:00.000Z,2026-12-20T10:50:00.000Z,50,,007',
    );
  });

  it("a Zoom guest with no registration keeps four blank cells: no column shifts", async () => {
    const res = (await GET(req("?export=csv"), ctx)) as unknown as { text(): Promise<string> };
    const guest = (await res.text()).split("\n")[2].split(",");
    expect(guest.length).toBe(11);
    expect(guest.slice(0, 6)).toEqual(["Guest", "", "", "", "", ""]);
  });

  it("the screen's rows do not carry them: they are read for the file only, and the labels are not loaded", async () => {
    const res = (await GET(req(""), ctx)) as unknown as { json(): Promise<{ rows: Record<string, unknown>[] }> };
    const { rows } = await res.json();
    // The exact keys (review of fe509d869): one field added to the screen, or the database row spread into
    // it, would hand these to people who may see the screen but not download the file.
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["attentivenessScore", "durationSeconds", "email", "id", "joinTime", "leaveTime", "name", "registrationId", "registrationSerialId"].sort(),
    );
    expect(h.mockDb.organization.findUnique).not.toHaveBeenCalled();
  });

  it("a failed read of the organisation's labels never fails the export: the default labels are used", async () => {
    h.mockDb.organization.findUnique.mockRejectedValue(new Error("db blip"));
    const res = (await GET(req("?export=csv"), ctx)) as unknown as { status: number; text(): Promise<string> };
    expect(res.status).toBe(200);
    expect((await res.text()).split("\n")[1]).toContain(",Physician,");
  });
});
