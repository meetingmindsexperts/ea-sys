/**
 * The venue's programme read (src/services/venue-programme-service.ts, phase
 * 6 step 4): workshops and symposia are sessions, break items are not; only
 * what the public agenda would show; and a failed read gives an empty
 * programme (the venue's placeholders) with an error logged, never a broken page.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { findMany, getSponsors, logError } = vi.hoisted(() => ({ findMany: vi.fn(), getSponsors: vi.fn(), logError: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { eventSession: { findMany } } }));
vi.mock("@/lib/sponsors", () => ({ getSponsors }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: logError } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));

import { loadProgrammeSummary, loadVenueProgramme } from "@/services/venue-programme-service";

const caller = { organizationId: "org-1", eventId: "evt-1" };
const rooms = [{ id: "plenary", name: "Plenary Hall" }, { id: "workshop", name: "Workshop Room" }];

beforeEach(() => {
  vi.clearAllMocks();
  getSponsors.mockResolvedValue([{ id: "s1", name: "Gold Co", tier: "gold", sortOrder: 0 }]);
  findMany.mockResolvedValue([
    { name: "Bleeding emergencies", startTime: new Date("2026-10-24T07:40:00Z"), endTime: new Date("2026-10-24T08:20:00Z"), location: null, track: { name: "Workshop Room" } },
  ]);
});

describe("loadVenueProgramme", () => {
  it("reads programme sessions (not break items) the public agenda shows, and places them", async () => {
    const p = await loadVenueProgramme(caller, rooms, "Asia/Dubai");
    const where = findMany.mock.calls[0][0].where;
    expect(where.eventId).toBe("evt-1");
    expect(where.type.notIn).toEqual(expect.arrayContaining(["REGISTRATION", "BREAK", "LUNCH", "NETWORKING"]));
    expect(where.type.notIn).not.toContain("WORKSHOP");
    expect(where.type.notIn).not.toContain("SYMPOSIUM");
    expect(where.status.in).toEqual(["SCHEDULED", "LIVE", "COMPLETED"]);
    expect(p.sessions).toEqual([expect.objectContaining({ room: "workshop", title: "Bleeding emergencies" })]);
    expect(p.sponsors.map((s) => s.name)).toEqual(["Gold Co"]);
  });

  it("gives an empty programme and logs an error when the read fails", async () => {
    findMany.mockRejectedValue(new Error("db down"));
    expect(await loadVenueProgramme(caller, rooms, "Asia/Dubai")).toEqual({ v: 1, tz: "Asia/Dubai", sessions: [], sponsors: [] });
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ msg: "venue:programme-load-failed", eventId: "evt-1" }));
  });
});

describe("loadProgrammeSummary", () => {
  it("returns each session's title, location and track, and the sponsor count; null on failure", async () => {
    expect(await loadProgrammeSummary(caller)).toEqual({ sessions: [{ title: "Bleeding emergencies", location: null, track: "Workshop Room" }], sponsors: 1 });
    getSponsors.mockRejectedValue(new Error("db down"));
    expect(await loadProgrammeSummary(caller)).toBeNull();
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ msg: "venue:programme-summary-failed" }));
  });
});
