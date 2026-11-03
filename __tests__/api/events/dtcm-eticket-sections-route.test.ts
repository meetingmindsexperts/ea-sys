/**
 * /api/events/[eventId]/dtcm-eticket (docs/DTCM_ETICKET_PLAN.md step 2): the
 * event's DET sections. DET is mocked; these pin what is asked of it, what is
 * saved, and that nothing is saved that DET's map would refuse.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockUpdateEventSettings, mockGetCreds, mockGetPerformance, mockApiLogger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    ticketType: { findMany: vi.fn() },
    registration: { groupBy: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockUpdateEventSettings: vi.fn(),
  mockGetCreds: vi.fn(),
  mockGetPerformance: vi.fn(),
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: mockUpdateEventSettings }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/dtcm-eticket/credentials", () => ({ getDetCredentials: mockGetCreds }));
vi.mock("@/lib/dtcm-eticket/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dtcm-eticket/client")>()),
  getDetPerformance: mockGetPerformance,
}));

import { GET, PUT } from "@/app/api/events/[eventId]/dtcm-eticket/route";
import { DetApiError } from "@/lib/dtcm-eticket/client";

const admin = { user: { id: "u1", organizationId: "org1", role: "ADMIN" } };
const params = { params: Promise.resolve({ eventId: "evt1" }) };
const put = (body: unknown) =>
  PUT(new Request("http://localhost/api", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), params);

const performance = {
  performanceCode: "PDUB01DEC2023B",
  name: "Batch 3",
  startDate: null,
  endDate: null,
  venueCode: null,
  sections: [{ code: "SVIP2", name: "VIP2", categoryId: 78, capacity: 160000, holds: 0 }],
  priceTypes: [{ code: "C", name: "Comps", categoryId: 78, price: 0 }],
};

const dubaiEvent = (over: Record<string, unknown> = {}) => ({
  id: "evt1",
  organizationId: "org1",
  requiresDtcmBarcode: true,
  dtcmPerformanceCode: "PDUB01DEC2023B",
  settings: {},
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(admin);
  mockDb.event.findFirst.mockResolvedValue(dubaiEvent());
  mockDb.ticketType.findMany.mockResolvedValue([
    { id: "tt-delegate", name: "Delegate", isFaculty: false, isActive: true },
    { id: "tt-faculty", name: "Faculty", isFaculty: true, isActive: true },
  ]);
  mockDb.registration.groupBy.mockResolvedValue([{ ticketTypeId: "tt-delegate", _count: { _all: 12 } }]);
  mockDb.auditLog.create.mockResolvedValue({});
  mockGetCreds.mockResolvedValue({ organizationId: "org1", environment: "staging", clientId: "AMMEE1", clientSecret: "s", apiKey: "k", version: "v" });
  mockGetPerformance.mockResolvedValue(performance);
  mockUpdateEventSettings.mockResolvedValue({});
});

describe("GET", () => {
  it("refuses a caller with no organisation before touching the event", async () => {
    mockAuth.mockResolvedValue({ user: { id: "op", organizationId: null, role: "SUPER_ADMIN" } });
    expect((await GET(new Request("http://localhost/api"), params)).status).toBe(403);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });

  it("does not ask DET while DTCM is off", async () => {
    mockDb.event.findFirst.mockResolvedValue(dubaiEvent({ requiresDtcmBarcode: false }));
    const body = await (await GET(new Request("http://localhost/api"), params)).json();
    expect(body.det).toBeNull();
    expect(mockGetPerformance).not.toHaveBeenCalled();
  });

  it("returns the live performance, the types with their in-person counts, and the stored mapping", async () => {
    mockDb.event.findFirst.mockResolvedValue(
      dubaiEvent({ settings: { dtcm: { sections: { "tt-delegate": { area: "SVIP2", priceTypeCode: "C" } }, environment: "staging" } } }),
    );
    const body = await (await GET(new Request("http://localhost/api"), params)).json();
    expect(body.det).toMatchObject({ environment: "staging", error: null, performance: { name: "Batch 3" } });
    expect(body.ticketTypes).toEqual([
      { id: "tt-delegate", name: "Delegate", isFaculty: false, isActive: true, registrations: 12 },
      { id: "tt-faculty", name: "Faculty", isFaculty: true, isActive: true, registrations: 0 },
    ]);
    expect(body.mapping.sections).toEqual({ "tt-delegate": { area: "SVIP2", priceTypeCode: "C" } });
    expect(mockDb.registration.groupBy.mock.calls[0][0].where).toMatchObject({ status: { not: "CANCELLED" }, attendanceMode: "IN_PERSON" });
  });

  it("reports a DET failure as part of the answer, not a 5xx", async () => {
    mockGetPerformance.mockRejectedValue(new DetApiError("DET performanceMap failed (HTTP 400, code 2001): Performance is not found.", "performanceMap", 400, "2001"));
    const res = await GET(new Request("http://localhost/api"), params);
    expect(res.status).toBe(200);
    expect((await res.json()).det).toMatchObject({ performance: null, error: { stage: "performanceMap", code: "DET_FAILED" } });
  });
});

describe("PUT", () => {
  it("refuses while DTCM is off", async () => {
    mockDb.event.findFirst.mockResolvedValue(dubaiEvent({ dtcmPerformanceCode: null }));
    const res = await put({ sections: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("DTCM_NOT_ENABLED");
  });

  it("refuses a registration type from another event", async () => {
    mockDb.ticketType.findMany.mockResolvedValue([]);
    const res = await put({ sections: { "tt-other": { area: "SVIP2", priceTypeCode: "C" } } });
    expect((await res.json()).code).toBe("UNKNOWN_TICKET_TYPE");
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
  });

  it("saves nothing when DET cannot be asked", async () => {
    mockDb.ticketType.findMany.mockResolvedValue([{ id: "tt-delegate" }]);
    mockGetPerformance.mockRejectedValue(new DetApiError("DET performanceMap could not be reached", "performanceMap", null));
    const res = await put({ sections: { "tt-delegate": { area: "SVIP2", priceTypeCode: "C" } } });
    expect(res.status).toBe(502);
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
  });

  it("saves nothing DET's map would refuse", async () => {
    mockDb.ticketType.findMany.mockResolvedValue([{ id: "tt-delegate" }]);
    const res = await put({ sections: { "tt-delegate": { area: "SVIP1", priceTypeCode: "C" } } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NOT_ON_DET_MAP");
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
  });

  it("saves the mapping with the environment and code it was checked against, in the event's own organisation", async () => {
    mockDb.ticketType.findMany.mockResolvedValue([{ id: "tt-delegate" }]);
    const res = await put({ sections: { "tt-delegate": { area: "SVIP2", priceTypeCode: "C" }, "tt-faculty": null } });
    expect(res.status).toBe(200);
    const [eventId, patch, opts] = mockUpdateEventSettings.mock.calls[0];
    expect(eventId).toBe("evt1");
    expect(opts).toEqual({ organizationId: "org1" });
    const written = patch({ registrationOpen: true });
    expect(written.registrationOpen).toBe(true);
    expect(written.dtcm).toMatchObject({
      sections: { "tt-delegate": { area: "SVIP2", priceTypeCode: "C" } },
      environment: "staging",
      performanceCode: "PDUB01DEC2023B",
    });
    expect(written.dtcm.checkedAt).toEqual(expect.any(String));
    expect(mockDb.auditLog.create).toHaveBeenCalled();
  });
});
