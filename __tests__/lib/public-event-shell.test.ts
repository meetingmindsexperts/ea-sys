/**
 * getPublicEventShell — whether the public `[slug]` layout mounts the
 * analytics beacon. A slug with no event (a deleted event's old links) must
 * report `exists: false`, or every visit sends a beacon the ingest can only drop
 * and log as `analytics:track-unresolved-site` (986 warnings in one week from
 * EHSMHC2026). A failed lookup must report `exists: true`, so a database blip
 * never switches measurement off for a live event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger } = vi.hoisted(() => ({
  mockDb: { event: { findFirst: vi.fn() } },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "events.example.com" }),
}));
vi.mock("@/lib/public-event", () => ({
  publicEventWhereForHost: async (_host: string | null, slug: string) => ({ slug }),
}));

import { getPublicEventShell } from "@/lib/public-event-metadata";

beforeEach(() => {
  vi.clearAllMocks();
});

const EVENT_ROW = {
  status: "PUBLISHED",
  name: "Heart Failure 2027",
  startDate: new Date("2027-01-15T05:00:00.000Z"),
  endDate: new Date("2027-01-17T14:00:00.000Z"),
  timezone: "Asia/Dubai",
  venue: "Raffles Hotel",
  city: "Dubai",
  country: "United Arab Emirates",
  bannerImage: "/uploads/banner.jpg",
  bannerImageMobile: null,
  footerHtml: "<p>Organised by us</p>",
  supportEmail: "help@example.com",
  description: null,
  organization: { primaryColor: "#00aade" },
};

describe("getPublicEventShell", () => {
  it("reports a live event with its brand colour and its branding", async () => {
    mockDb.event.findFirst.mockResolvedValue(EVENT_ROW);
    await expect(getPublicEventShell("live-event")).resolves.toEqual({
      exists: true,
      brandColor: "#00aade",
      branding: {
        name: "Heart Failure 2027",
        startDate: "2027-01-15T05:00:00.000Z",
        endDate: "2027-01-17T14:00:00.000Z",
        timezone: "Asia/Dubai",
        venue: "Raffles Hotel",
        city: "Dubai",
        country: "United Arab Emirates",
        bannerImage: "/uploads/banner.jpg",
        bannerImageMobile: null,
        footerHtml: "<p>Organised by us</p>",
        supportEmail: "help@example.com",
      },
    });
  });

  // The branding is rendered on pages anyone can open (a mistyped agenda link,
  // an old form link). A draft's name and banner are not public yet, and a
  // cancelled event's are withdrawn.
  it.each(["DRAFT", "CANCELLED"])("hands no branding to the page for a %s event", async (status) => {
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT_ROW, status });
    const shell = await getPublicEventShell("hidden-event");
    expect(shell.exists).toBe(true);
    expect(shell.brandColor).toBe("#00aade");
    expect(shell.branding).toBeNull();
  });

  it.each(["PUBLISHED", "LIVE", "COMPLETED"])("brands the pages of a %s event", async (status) => {
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT_ROW, status });
    const shell = await getPublicEventShell("public-event");
    expect(shell.branding?.name).toBe("Heart Failure 2027");
  });

  it("reports a slug with no event as not existing, so no beacon is mounted", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    await expect(getPublicEventShell("deleted-event")).resolves.toEqual({
      exists: false,
      brandColor: null,
      branding: null,
    });
  });

  it("fails open on a lookup error and logs it", async () => {
    mockDb.event.findFirst.mockRejectedValue(new Error("db down"));
    await expect(getPublicEventShell("any-event")).resolves.toEqual({
      exists: true,
      brandColor: null,
      branding: null,
    });
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });
});
