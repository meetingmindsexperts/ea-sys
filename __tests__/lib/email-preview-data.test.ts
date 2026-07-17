/**
 * buildRealPreviewOverrides — previews render ACTUAL event data (sessions,
 * Zoom passcode/recording, abstracts, a representative speaker's presentation
 * block) wherever a real source exists; keys are absent (samples stand) when
 * there's no real data; enrichment failure NEVER fails the preview.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockBuildSpeakerEmailContext, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    event: { findUnique: vi.fn() },
    speaker: { findFirst: vi.fn() },
  },
  mockBuildSpeakerEmailContext: vi.fn(),
  mockLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/speaker-agreement", () => ({
  buildSpeakerEmailContext: mockBuildSpeakerEmailContext,
}));

import { buildRealPreviewOverrides } from "@/lib/email-preview-data";

// 2026-03-05 14:00 UTC = 18:00 in Dubai (GMT+4).
const SESSION_START = new Date("2026-03-05T14:00:00Z");

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    slug: "cardio",
    timezone: "Asia/Dubai",
    eventSessions: [
      {
        id: "sess-1",
        name: "Opening Keynote",
        startTime: SESSION_START,
        location: "Main Hall",
        zoomMeeting: { passcode: "998877", recordingStatus: "NOT_REQUESTED", recordingUrl: null },
      },
    ],
    abstracts: [{ title: "Stents in 2026" }, { title: "Valve Repair" }],
    _count: { abstracts: 7 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.speaker.findFirst.mockResolvedValue(null);
});

describe("buildRealPreviewOverrides", () => {
  it("renders session name / start / joinUrl / webinar date+time from the real session", async () => {
    mockDb.event.findUnique.mockResolvedValue(eventRow());
    const o = await buildRealPreviewOverrides("evt-1");
    expect(o.sessionName).toBe("Opening Keynote");
    expect(String(o.sessionStart)).toContain("6:00 PM");
    expect(String(o.sessionStart)).toContain("GMT+4");
    expect(o.sessionDetails).toBe("Opening Keynote - Main Hall");
    // The gated session page — never the raw Zoom link.
    expect(String(o.joinUrl)).toContain("/e/cardio/session/sess-1");
    expect(String(o.webinarDate)).toContain("March 5, 2026");
    expect(String(o.webinarTime)).toContain("6:00 PM");
  });

  it("passcodeBlock carries the REAL passcode; recordingBlock the real coming-soon state", async () => {
    mockDb.event.findUnique.mockResolvedValue(eventRow());
    const o = await buildRealPreviewOverrides("evt-1");
    expect(String(o.passcodeBlock)).toContain("998877");
    expect(String(o.recordingBlock)).toContain("available shortly");
  });

  it("recordingBlock becomes the Watch Replay button when the recording is AVAILABLE", async () => {
    mockDb.event.findUnique.mockResolvedValue(
      eventRow({
        eventSessions: [
          {
            id: "sess-1",
            name: "Opening Keynote",
            startTime: SESSION_START,
            location: null,
            zoomMeeting: {
              passcode: null,
              recordingStatus: "AVAILABLE",
              recordingUrl: "https://zoom.us/rec/xyz",
            },
          },
        ],
      }),
    );
    const o = await buildRealPreviewOverrides("evt-1");
    expect(String(o.recordingBlock)).toContain("https://zoom.us/rec/xyz");
    expect(String(o.recordingBlock)).toContain("Watch Replay");
    // No passcode → honestly empty, exactly like the real send.
    expect(o.passcodeBlock).toBe("");
  });

  it("leaves the Zoom blocks ABSENT (samples stand) when the session has no Zoom meeting", async () => {
    mockDb.event.findUnique.mockResolvedValue(
      eventRow({
        eventSessions: [
          { id: "s", name: "Talk", startTime: SESSION_START, location: null, zoomMeeting: null },
        ],
      }),
    );
    const o = await buildRealPreviewOverrides("evt-1");
    expect(o.passcodeBlock).toBeUndefined();
    expect(o.recordingBlock).toBeUndefined();
  });

  it("renders real abstract titles + count", async () => {
    mockDb.event.findUnique.mockResolvedValue(eventRow());
    const o = await buildRealPreviewOverrides("evt-1");
    expect(o.abstractTitle).toBe("Stents in 2026");
    expect(o.abstractTitles).toBe("Stents in 2026; Valve Repair");
    expect(o.abstractCount).toBe(7);
  });

  it("uses a representative speaker's REAL presentation block when one exists", async () => {
    mockDb.event.findUnique.mockResolvedValue(eventRow());
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk-9" });
    mockBuildSpeakerEmailContext.mockResolvedValue({
      presentationDetails: "<table>real</table>",
      presentationDetailsText: "real",
    });
    const o = await buildRealPreviewOverrides("evt-1");
    expect(o.presentationDetails).toBe("<table>real</table>");
    expect(o.presentationDetailsText).toBe("real");
    expect(mockBuildSpeakerEmailContext).toHaveBeenCalledWith("evt-1", "spk-9");
  });

  it("omits session/abstract keys when the event has none (samples stand)", async () => {
    mockDb.event.findUnique.mockResolvedValue(
      eventRow({ eventSessions: [], abstracts: [], _count: { abstracts: 0 } }),
    );
    const o = await buildRealPreviewOverrides("evt-1");
    expect(o.sessionName).toBeUndefined();
    expect(o.joinUrl).toBeUndefined();
    expect(o.abstractTitle).toBeUndefined();
    expect(o.abstractCount).toBeUndefined();
    // The static-URL tokens are always real.
    expect(String(o.loginLink)).toContain("/e/cardio/login");
    expect(String(o.reviewLink)).toContain("my-reviews");
  });

  it("returns {} for an unknown event", async () => {
    mockDb.event.findUnique.mockResolvedValue(null);
    expect(await buildRealPreviewOverrides("nope")).toEqual({});
  });

  it("returns {} and warn-logs when enrichment throws — the preview must never fail", async () => {
    mockDb.event.findUnique.mockRejectedValue(new Error("pool timeout"));
    expect(await buildRealPreviewOverrides("evt-1")).toEqual({});
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
