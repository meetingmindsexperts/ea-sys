import { describe, it, expect, vi, beforeEach } from "vitest";

const { zoomApiRequest, warn } = vi.hoisted(() => ({ zoomApiRequest: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/zoom/client", () => ({ zoomApiRequest }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn, error: vi.fn() } }));

import {
  createZoomMeeting,
  createZoomWebinar,
  createWebinarSeries,
  updateZoomMeeting,
  updateZoomWebinar,
} from "@/lib/zoom/meetings";
import { localWallTimeInTz } from "@/lib/event-time";

// What every caller passes: toISOString(), with milliseconds.
const UTC = "2026-11-10T07:30:00.000Z";
const UTC_WHOLE_SECONDS = "2026-11-10T07:30:00Z";
const base = { topic: "T", startTime: UTC, duration: 60, timezone: "Asia/Dubai" };
const sentBody = () => zoomApiRequest.mock.calls[0][3];

describe("Zoom start_time goes as the event's wall clock", () => {
  beforeEach(() => {
    zoomApiRequest.mockReset();
    warn.mockReset();
    zoomApiRequest.mockResolvedValue({ id: 1 });
  });

  it("createZoomWebinar: 07:30 UTC goes as 11:30 with Asia/Dubai", async () => {
    await createZoomWebinar("org", base);
    expect(sentBody().start_time).toBe("2026-11-10T11:30:00");
    expect(sentBody().timezone).toBe("Asia/Dubai");
  });

  it("createZoomMeeting", async () => {
    await createZoomMeeting("org", base);
    expect(sentBody().start_time).toBe("2026-11-10T11:30:00");
  });

  it("createWebinarSeries", async () => {
    await createWebinarSeries("org", { ...base, recurrence: { type: 1, repeat_interval: 1 } } as never);
    expect(sentBody().start_time).toBe("2026-11-10T11:30:00");
  });

  it("updateZoomWebinar and updateZoomMeeting (a session re-time)", async () => {
    await updateZoomWebinar("org", "1", { startTime: UTC, duration: 60, timezone: "Asia/Dubai" });
    expect(sentBody().start_time).toBe("2026-11-10T11:30:00");
    zoomApiRequest.mockClear();
    await updateZoomMeeting("org", "1", { startTime: UTC, duration: 60, timezone: "Asia/Dubai" });
    expect(sentBody().start_time).toBe("2026-11-10T11:30:00");
  });

  it("no timezone: UTC in whole seconds, never a wall clock with no zone, and no warning", async () => {
    await createZoomWebinar("org", { ...base, timezone: undefined });
    expect(sentBody().start_time).toBe(UTC_WHOLE_SECONDS);
    expect(sentBody().timezone).toBe("UTC");
    expect(warn).not.toHaveBeenCalled();
  });

  it("a timezone Intl does not know: UTC in whole seconds, logged, no throw", async () => {
    await createZoomWebinar("org", { ...base, timezone: "Mars/Olympus" });
    expect(sentBody().start_time).toBe(UTC_WHOLE_SECONDS);
    expect(warn).toHaveBeenCalledWith({ timezone: "Mars/Olympus" }, "zoom:start-time-unknown-timezone");
  });

  it("an update with no startTime sends no start_time", async () => {
    await updateZoomWebinar("org", "1", { topic: "New" });
    expect(sentBody()).not.toHaveProperty("start_time");
  });
});

describe("localWallTimeInTz", () => {
  it("crosses the date line with the zone", () => {
    expect(localWallTimeInTz(new Date("2026-11-09T22:15:05Z"), "Asia/Dubai")).toBe("2026-11-10T02:15:05");
  });
  it("midnight is 00, not 24", () => {
    expect(localWallTimeInTz(new Date("2026-11-09T20:00:00Z"), "Asia/Dubai")).toBe("2026-11-10T00:00:00");
  });
  it("follows daylight saving", () => {
    expect(localWallTimeInTz(new Date("2026-07-01T12:00:00Z"), "Europe/London")).toBe("2026-07-01T13:00:00");
    expect(localWallTimeInTz(new Date("2026-12-01T12:00:00Z"), "Europe/London")).toBe("2026-12-01T12:00:00");
  });
});
