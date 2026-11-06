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

describe("getPublicEventShell", () => {
  it("reports a live event with its brand colour", async () => {
    mockDb.event.findFirst.mockResolvedValue({ organization: { primaryColor: "#00aade" } });
    await expect(getPublicEventShell("live-event")).resolves.toEqual({
      exists: true,
      brandColor: "#00aade",
    });
  });

  it("reports a slug with no event as not existing, so no beacon is mounted", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    await expect(getPublicEventShell("deleted-event")).resolves.toEqual({
      exists: false,
      brandColor: null,
    });
  });

  it("fails open on a lookup error and logs it", async () => {
    mockDb.event.findFirst.mockRejectedValue(new Error("db down"));
    await expect(getPublicEventShell("any-event")).resolves.toEqual({
      exists: true,
      brandColor: null,
    });
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });
});
