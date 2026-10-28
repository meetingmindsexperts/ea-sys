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
});
