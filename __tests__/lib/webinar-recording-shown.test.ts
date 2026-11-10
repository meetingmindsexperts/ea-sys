/**
 * The organiser's "Show the recording to attendees" switch (Oct 28, 2026): off unless turned on, and the
 * webinar email's {{recordingBlock}} that follows it. The route tests mock the helper, so the real one is
 * pinned here (review MED).
 */
import { describe, it, expect } from "vitest";
import { webinarRecordingBlock, webinarRecordingShown } from "@/lib/webinar";

describe("webinarRecordingShown", () => {
  it("is off unless the organiser switched it on", () => {
    expect(webinarRecordingShown(null)).toBe(false);
    expect(webinarRecordingShown({})).toBe(false);
    expect(webinarRecordingShown({ webinar: "x" })).toBe(false);
    expect(webinarRecordingShown({ webinar: {} })).toBe(false);
    expect(webinarRecordingShown({ webinar: { showRecording: false } })).toBe(false);
    expect(webinarRecordingShown({ webinar: { showRecording: "true" } })).toBe(false);
    expect(webinarRecordingShown({ webinar: { showRecording: true } })).toBe(true);
  });
});

describe("webinarRecordingBlock", () => {
  const url = "https://zoom.us/rec/play/abc";

  it("neither links nor promises the recording while it is not shown (the thank-you sends on its own)", () => {
    expect(webinarRecordingBlock(false, url, "html")).toBe("");
    expect(webinarRecordingBlock(false, url, "text")).toBe("");
    expect(webinarRecordingBlock(false, "", "html")).toBe("");
  });

  it("links the replay when shown and fetched, and says it is coming when shown but not yet fetched", () => {
    expect(webinarRecordingBlock(true, url, "html")).toContain(`href="${url}"`);
    expect(webinarRecordingBlock(true, url, "text")).toBe(`Watch replay: ${url}`);
    expect(webinarRecordingBlock(true, "", "html")).toContain("available shortly");
    expect(webinarRecordingBlock(true, "", "text")).toContain("available shortly");
  });

  it("with the person's replay page given, the coming-shortly line links it: the thank-you goes before a replay is uploaded (Nov 10, 2026)", () => {
    const page = "https://events.example.com/my-account/replay/evt-1";
    const html = webinarRecordingBlock(true, "", "html", page);
    expect(html).toContain("The recording will be available shortly. You can watch it here once it is ready.");
    expect(html).toContain(`href="${page}"`);
    expect(html).toContain("Open the replay page");
    expect(webinarRecordingBlock(true, "", "text", page)).toBe(`The recording will be available shortly. Watch it here once it is ready: ${page}`);
    // A replay there is: the button is the replay's, and the page link is not repeated.
    expect(webinarRecordingBlock(true, url, "html", page)).toContain(`href="${url}"`);
    expect(webinarRecordingBlock(true, url, "html", page)).not.toContain("Open the replay page");
    // Hidden stays empty.
    expect(webinarRecordingBlock(false, "", "html", page)).toBe("");
  });

  it("promises no follow-up email: none is sent", () => {
    for (const block of [webinarRecordingBlock(true, "", "html"), webinarRecordingBlock(true, "", "html", "https://x.example/p")]) {
      expect(block).not.toContain("send it to you");
    }
  });
});
