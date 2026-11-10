/**
 * Which replay an attendee is offered (webinar/replay.ts, Nov 10, 2026): the organiser's uploaded
 * one, Zoom's recording, or none. The routes, the emails and My events all ask this one rule, so
 * its edges are pinned here against the real settings readers.
 */
import { describe, it, expect } from "vitest";
import { replayEmailUrl, replayPageUrl, sessionReplayKind, uploadedReplay } from "@/lib/webinar/replay";

const NOW = new Date("2026-11-10T12:00:00Z");
const VIMEO = "https://vimeo.com/123456789/abcdef1234";
const over = { id: "anchor", status: "COMPLETED", endTime: new Date("2026-11-10T08:30:00Z") };
const settings = (webinar: Record<string, unknown>) => ({ webinar: { sessionId: "anchor", ...webinar } });
const kind = (over_: Partial<Parameters<typeof sessionReplayKind>[0]>) =>
  sessionReplayKind({ eventType: "WEBINAR", settings: settings({ showRecording: true, replayUrl: VIMEO }), session: over, recordingStatus: null, now: NOW, ...over_ });

describe("sessionReplayKind", () => {
  it("the uploaded replay plays in the page, and wins over Zoom's recording", () => {
    expect(kind({})).toBe("embed");
    expect(kind({ recordingStatus: "AVAILABLE" })).toBe("embed");
  });

  it("nothing is offered on a webinar while the organiser's switch is off, link or not", () => {
    expect(kind({ settings: settings({ replayUrl: VIMEO }) })).toBeNull();
    expect(kind({ settings: settings({ showRecording: false, replayUrl: VIMEO }), recordingStatus: "AVAILABLE" })).toBeNull();
    expect(kind({ settings: {} })).toBeNull();
    expect(kind({ settings: null })).toBeNull();
  });

  it("with no link, Zoom's recording once it is fetched, and nothing before", () => {
    const noLink = settings({ showRecording: true });
    expect(kind({ settings: noLink, recordingStatus: "AVAILABLE" })).toBe("zoom");
    for (const status of ["PENDING", "NOT_REQUESTED", "FAILED", "EXPIRED", null, undefined]) {
      expect(kind({ settings: noLink, recordingStatus: status })).toBeNull();
    }
  });

  it("an expired Zoom recording does not stop the uploaded replay", () => {
    expect(kind({ recordingStatus: "EXPIRED" })).toBe("embed");
  });

  it("a link saved early waits for the end: never over the waiting room or the live video", () => {
    const future = new Date("2026-11-11T08:30:00Z");
    expect(kind({ session: { id: "anchor", status: "SCHEDULED", endTime: future } })).toBeNull();
    expect(kind({ session: { id: "anchor", status: "DRAFT", endTime: future } })).toBeNull();
    // Live, even running past its scheduled end.
    expect(kind({ session: { id: "anchor", status: "LIVE", endTime: over.endTime } })).toBeNull();
    // Closed by the producer before the scheduled end: over.
    expect(kind({ session: { id: "anchor", status: "COMPLETED", endTime: future } })).toBe("embed");
    // Never opened in the system and past its end: over.
    expect(kind({ session: { id: "anchor", status: "SCHEDULED", endTime: over.endTime } })).toBe("embed");
  });

  it("the link belongs to the webinar's own session only", () => {
    expect(kind({ session: { ...over, id: "another" } })).toBeNull();
    expect(kind({ session: { ...over, id: "another" }, recordingStatus: "AVAILABLE" })).toBe("zoom");
    // No anchor recorded: the webinar's one session is taken as it.
    expect(kind({ settings: { webinar: { showRecording: true, replayUrl: VIMEO } }, session: { ...over, id: "any" } })).toBe("embed");
  });

  it("a stored link that is not a Vimeo video is ignored, whoever wrote it", () => {
    for (const replayUrl of ["https://evil.example/x", "javascript:alert(1)", "https://vimeo.com/showcase/123456", 42, null, ""]) {
      expect(kind({ settings: settings({ showRecording: true, replayUrl }) })).toBeNull();
    }
  });

  it("other event types have no switch and no uploaded replay: Zoom's recording as before", () => {
    const conference = { eventType: "CONFERENCE", settings: settings({ replayUrl: VIMEO }) };
    expect(kind({ ...conference, recordingStatus: "AVAILABLE" })).toBe("zoom");
    expect(kind({ ...conference, recordingStatus: "PENDING" })).toBeNull();
    expect(kind({ eventType: null, settings: {}, recordingStatus: "AVAILABLE" })).toBe("zoom");
  });
});

describe("uploadedReplay", () => {
  it("hands back the player address built from the stored link", () => {
    const question = { eventType: "WEBINAR", settings: settings({ replayUrl: VIMEO }), session: over, now: NOW };
    expect(uploadedReplay(question)?.embedUrl).toBe("https://player.vimeo.com/video/123456789?h=abcdef1234&dnt=1");
  });

  it("does not look at the switch: sessionReplayKind is the one that decides what is offered", () => {
    const question = { eventType: "WEBINAR", settings: settings({ showRecording: false, replayUrl: VIMEO }), session: over, now: NOW };
    expect(uploadedReplay(question)).not.toBeNull();
    expect(sessionReplayKind({ ...question, recordingStatus: null })).toBeNull();
  });
});

describe("replayEmailUrl", () => {
  const page = replayPageUrl("https://events.example.com", "evt-1");
  it("the replay page is the person's own, in their portal, by event", () => {
    expect(page).toBe("https://events.example.com/my-account/replay/evt-1");
  });
  it("an uploaded replay is linked through that page, never directly", () => {
    expect(replayEmailUrl("embed", page, "https://zoom.us/rec/play/x")).toBe(page);
  });
  it("Zoom's recording keeps its own link, and none means no link", () => {
    expect(replayEmailUrl("zoom", page, "https://zoom.us/rec/play/x")).toBe("https://zoom.us/rec/play/x");
    expect(replayEmailUrl("zoom", page, null)).toBe("");
    expect(replayEmailUrl(null, page, "https://zoom.us/rec/play/x")).toBe("");
  });
});
