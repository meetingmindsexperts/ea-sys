/**
 * The public agenda's two 404s (Nov 17, 2026).
 *
 * "No such event" and "the agenda is not published yet" are both a 404, and
 * the page shows a different message for each (the second under the event's
 * banner, as a normal state of a real event), so each carries a `code`. The
 * status stays 404: anything already reading it keeps working.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger } = vi.hoisted(() => ({
  mockDb: { event: { findFirst: vi.fn() } },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/public-event", () => ({
  publicEventWhere: async (_req: Request, slug: string) => ({ slug }),
}));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_orgId: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getClientIp: () => "203.0.113.9",
}));

import { GET } from "@/app/api/public/events/[slug]/agenda/route";

const call = (slug: string) =>
  GET(new Request(`http://events.example.com/api/public/events/${slug}/agenda`), {
    params: Promise.resolve({ slug }),
  });

const EVENT = {
  id: "evt_1",
  name: "Heart Failure 2027",
  slug: "hf2027",
  startDate: new Date("2027-01-15T05:00:00.000Z"),
  endDate: new Date("2027-01-17T14:00:00.000Z"),
  timezone: "Asia/Dubai",
  supportEmail: null,
  bannerImage: null,
  bannerImageMobile: null,
  organization: { name: "Org", logo: null },
  tracks: [],
  eventSessions: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/public/events/[slug]/agenda", () => {
  it("answers 404 EVENT_NOT_FOUND for a slug with no public event, logged at info", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    const res = await call("deleted-event");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Event not found", code: "EVENT_NOT_FOUND" });
    // An old link to a deleted event is opened again and again; warn would
    // fill the SystemLog table.
    expect(mockLogger.info).toHaveBeenCalledWith({ slug: "deleted-event" }, "public-agenda:no-public-event");
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("answers 404 AGENDA_NOT_PUBLISHED for a real event whose agenda is not published, logged at warn", async () => {
    mockDb.event.findFirst
      .mockResolvedValueOnce({ id: "evt_1", organizationId: "org_1" })
      .mockResolvedValueOnce({ ...EVENT, settings: {} });
    const res = await call("hf2027");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Agenda not published yet", code: "AGENDA_NOT_PUBLISHED" });
    expect(mockLogger.warn).toHaveBeenCalledWith({ slug: "hf2027", eventId: "evt_1" }, "public-agenda:not-published");
  });

  it.each(["agendaPublished", "programmePublished"])("serves the agenda once %s is set", async (flag) => {
    mockDb.event.findFirst
      .mockResolvedValueOnce({ id: "evt_1", organizationId: "org_1" })
      .mockResolvedValueOnce({ ...EVENT, settings: { [flag]: true } });
    const res = await call("hf2027");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Heart Failure 2027");
    expect(body.code).toBeUndefined();
  });
});
