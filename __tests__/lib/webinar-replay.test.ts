/**
 * Which replay an attendee is offered (webinar/replay.ts, Nov 10, 2026): the organiser's uploaded
 * one, Zoom's recording, or none. The routes, the emails and My events all ask this one rule, so
 * its edges are pinned here against the real settings readers.
 */
import { describe, it, expect } from "vitest";
import { replayEmailUrl, replayPageUrl, sessionlessReplay, sessionReplayKind, uploadedReplay } from "@/lib/webinar/replay";

const NOW = new Date("2026-11-10T12:00:00Z");
const VIMEO = "https://vimeo.com/123456789/abcdef1234";
const START = new Date("2026-11-10T07:30:00Z");
const over = { id: "anchor", status: "COMPLETED", startTime: START, endTime: new Date("2026-11-10T08:30:00Z") };
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
    const tomorrow = { startTime: new Date("2026-11-11T07:30:00Z"), endTime: new Date("2026-11-11T08:30:00Z") };
    expect(kind({ session: { id: "anchor", status: "SCHEDULED", ...tomorrow } })).toBeNull();
    expect(kind({ session: { id: "anchor", status: "DRAFT", ...tomorrow } })).toBeNull();
    // Live, even running past its scheduled end.
    expect(kind({ session: { ...over, status: "LIVE" } })).toBeNull();
    // Never opened in the system and past its end: over.
    expect(kind({ session: { ...over, status: "SCHEDULED" } })).toBe("embed");
  });

  it("is the page's own rule for 'ended' (webinarRoomEnded), rehearsal included", () => {
    // Closed by the producer after the scheduled start, before the scheduled end: over.
    const running = { startTime: new Date("2026-11-10T11:30:00Z"), endTime: new Date("2026-11-10T13:00:00Z") };
    expect(kind({ session: { id: "anchor", status: "COMPLETED", ...running } })).toBe("embed");
    // Opened and closed the day BEFORE, to test the stream: a rehearsal, so the waiting room stays.
    const tomorrow = { startTime: new Date("2026-11-11T07:30:00Z"), endTime: new Date("2026-11-11T08:30:00Z") };
    expect(kind({ session: { id: "anchor", status: "COMPLETED", ...tomorrow } })).toBeNull();
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

describe("sessionlessReplay: a webinar run outside the EA-SYS room has no session to ask", () => {
  const ended = new Date("2026-11-01T18:00:00Z");
  const upcoming = new Date("2026-12-01T18:00:00Z");
  const on = { webinar: { showRecording: true, replayUrl: VIMEO } };
  const ask = (settings: unknown, status: string, endDate: Date) => sessionlessReplay({ settings, event: { status, endDate }, now: NOW });

  it("plays once the event is marked Completed, or its end date has passed", () => {
    expect(ask(on, "COMPLETED", upcoming)?.embedUrl).toBe("https://player.vimeo.com/video/123456789?h=abcdef1234&dnt=1");
    expect(ask(on, "PUBLISHED", ended)).not.toBeNull();
    expect(ask(on, "DRAFT", ended)).not.toBeNull();
  });

  it("not before the event is over, never while it is live, never when it was cancelled", () => {
    expect(ask(on, "PUBLISHED", upcoming)).toBeNull();
    expect(ask(on, "LIVE", ended)).toBeNull();
    expect(ask(on, "CANCELLED", ended)).toBeNull();
  });

  it("the organiser's switch and the Vimeo-only rule apply as everywhere", () => {
    expect(ask({ webinar: { replayUrl: VIMEO } }, "COMPLETED", ended)).toBeNull();
    expect(ask({ webinar: { showRecording: true } }, "COMPLETED", ended)).toBeNull();
    expect(ask({ webinar: { showRecording: true, replayUrl: "https://evil.example/x" } }, "COMPLETED", ended)).toBeNull();
    expect(ask(null, "COMPLETED", ended)).toBeNull();
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
