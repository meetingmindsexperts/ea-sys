/** getLastZoomEndTime (Oct 1, 2026): when a webinar's last run ended, from Zoom's past-webinar record. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { zoomApiRequestSpy } = vi.hoisted(() => ({ zoomApiRequestSpy: vi.fn() }));
vi.mock("@/lib/zoom/client", () => ({ zoomApiRequest: zoomApiRequestSpy }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getLastZoomEndTime } from "@/lib/zoom/reports";

describe("getLastZoomEndTime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads end_time from the past-webinar record", async () => {
    zoomApiRequestSpy.mockResolvedValue({ end_time: "2026-10-01T10:58:00Z" });
    expect((await getLastZoomEndTime("org1", "999", "WEBINAR"))?.toISOString()).toBe("2026-10-01T10:58:00.000Z");
    expect(zoomApiRequestSpy).toHaveBeenCalledWith("org1", "GET", "/past_webinars/999", undefined, { expectedStatuses: [404] });
  });

  it("uses the past-meetings path for a plain meeting", async () => {
    zoomApiRequestSpy.mockResolvedValue({});
    await getLastZoomEndTime("org1", "123", "MEETING");
    expect(zoomApiRequestSpy.mock.calls[0][2]).toBe("/past_meetings/123");
  });

  it("not ended (404) is null; other errors still throw", async () => {
    zoomApiRequestSpy.mockRejectedValueOnce(new Error("Zoom API error: 404 Webinar not found (code: 3001)"));
    expect(await getLastZoomEndTime("org1", "999", "WEBINAR")).toBeNull();
    zoomApiRequestSpy.mockRejectedValueOnce(new Error("Zoom API error: 500 boom (code: N/A)"));
    await expect(getLastZoomEndTime("org1", "999", "WEBINAR")).rejects.toThrow("500");
    // A 400 (e.g. a missing past_webinar scope) must surface, not read as "not ended".
    zoomApiRequestSpy.mockRejectedValueOnce(new Error("Zoom API error: 400 Invalid access token, does not contain scopes (code: 4711)"));
    await expect(getLastZoomEndTime("org1", "999", "WEBINAR")).rejects.toThrow("400");
  });
});
