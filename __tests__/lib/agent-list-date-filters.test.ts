/**
 * MCP list_speakers / list_registrations — created/updated date-filter wiring
 * (July 21, 2026). Pins that the shared parseDateRangeFilters output lands in
 * the Prisma `where` (inclusive gte/lte) and that an invalid value is a tool
 * error (INVALID_DATE_FILTER), never a silently-dropped filter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    speaker: { findMany: vi.fn().mockResolvedValue([]) },
    registration: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn() }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));

import { SPEAKER_EXECUTORS } from "@/lib/agent/tools/speakers";
import { REGISTRATION_EXECUTORS } from "@/lib/agent/tools/registrations";

const ctx = { eventId: "ev1", organizationId: "org1", userId: "u1" } as never;

beforeEach(() => vi.clearAllMocks());

describe("list_speakers date filters", () => {
  it("threads updatedAfter/createdBefore into the where as inclusive bounds", async () => {
    await SPEAKER_EXECUTORS.list_speakers(
      { updatedAfter: "2026-07-20T00:00:00Z", createdBefore: "2026-07-01T00:00:00Z" },
      ctx,
    );
    expect(mockDb.speaker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          eventId: "ev1",
          updatedAt: { gte: new Date("2026-07-20T00:00:00Z") },
          createdAt: { lte: new Date("2026-07-01T00:00:00Z") },
        }),
      }),
    );
  });

  it("rejects an unparsable value with INVALID_DATE_FILTER (no query)", async () => {
    const r = (await SPEAKER_EXECUTORS.list_speakers({ updatedAfter: "last tuesday" }, ctx)) as Record<string, unknown>;
    expect(r.code).toBe("INVALID_DATE_FILTER");
    expect(mockDb.speaker.findMany).not.toHaveBeenCalled();
  });

  it("no date params → where carries no date keys (full-pull unchanged)", async () => {
    await SPEAKER_EXECUTORS.list_speakers({}, ctx);
    const where = mockDb.speaker.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.createdAt).toBeUndefined();
    expect(where.updatedAt).toBeUndefined();
  });
});

describe("list_registrations date filters", () => {
  it("threads the date bounds alongside the existing filters", async () => {
    await REGISTRATION_EXECUTORS.list_registrations(
      { status: "CONFIRMED", updatedAfter: "2026-07-21T05:00:00Z" },
      ctx,
    );
    expect(mockDb.registration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          eventId: "ev1",
          status: "CONFIRMED",
          updatedAt: { gte: new Date("2026-07-21T05:00:00Z") },
        }),
      }),
    );
  });

  it("rejects an unparsable value with INVALID_DATE_FILTER (no query)", async () => {
    const r = (await REGISTRATION_EXECUTORS.list_registrations({ createdAfter: "??" }, ctx)) as Record<string, unknown>;
    expect(r.code).toBe("INVALID_DATE_FILTER");
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
  });
});
