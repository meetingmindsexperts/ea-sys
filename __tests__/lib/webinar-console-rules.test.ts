/**
 * The Webinar Console's tab and room-button rules (review of c1b4ae83), pinned
 * by behaviour: the first version's test only read the page's source, and a
 * broken rule would have passed it.
 */
import { describe, it, expect } from "vitest";
import {
  consoleActiveTab,
  consoleOpeningTab,
  consoleTabs,
  roomReopens,
  webinarStatusFromTimes,
} from "@/lib/webinar/console-rules";

describe("consoleTabs", () => {
  it("a Zoom webinar in Zoom embed mode: no viewer tabs", () => {
    expect(consoleTabs({ partner: false, viewerTabs: false })).toEqual(["setup", "panelists", "recording", "branding", "settings"]);
  });

  it("a partner's webinar has no Panelists (they are Zoom's) and has our player's tabs", () => {
    expect(consoleTabs({ partner: true, viewerTabs: true })).toEqual([
      "setup",
      "recording",
      "qa",
      "polls",
      "chat",
      "branding",
      "settings",
    ]);
  });
});

describe("consoleOpeningTab", () => {
  it("an ended webinar opens on Recording (its reports are on the event's Analytics page), anything else on Setup", () => {
    expect(consoleOpeningTab("ended")).toBe("recording");
    expect(consoleOpeningTab("live")).toBe("setup");
    expect(consoleOpeningTab("scheduled")).toBe("setup");
  });
});

describe("consoleActiveTab", () => {
  const zoomEmbed = consoleTabs({ partner: false, viewerTabs: false });
  const customStream = consoleTabs({ partner: false, viewerTabs: true });

  it("keeps the picked tab, so closing the room never moves the producer off Setup", () => {
    // The page sets the pick once, from consoleOpeningTab, when the data arrives; a later "ended"
    // status changes nothing here.
    expect(consoleActiveTab("setup", customStream)).toBe("setup");
    expect(consoleActiveTab("recording", customStream)).toBe("recording");
    // A tab remembered from before the reports moved (Nov 23, 2026) is no longer there: Setup.
    expect(consoleActiveTab("analytics", customStream)).toBe("setup");
  });

  it("a picked tab that disappeared (Q&A after a switch to Zoom embed) falls back to Setup", () => {
    expect(consoleActiveTab("qa", customStream)).toBe("qa");
    expect(consoleActiveTab("qa", zoomEmbed)).toBe("setup");
    expect(consoleActiveTab("panelists", consoleTabs({ partner: true, viewerTabs: true }))).toBe("setup");
  });

  it("before anything is picked (data still loading): Setup", () => {
    expect(consoleActiveTab(null, zoomEmbed)).toBe("setup");
  });
});

describe("roomReopens", () => {
  it("a room opened and closed after the start re-opens (confirmed)", () => {
    expect(roomReopens({ roomOpen: false, ended: true, anchorStatus: "COMPLETED", pastLateStart: false })).toBe(true);
  });

  it("a room never opened by the end of its slot is a late start: the ordinary Open, while the overdue alert shows", () => {
    expect(roomReopens({ roomOpen: false, ended: true, anchorStatus: "SCHEDULED", pastLateStart: false })).toBe(false);
  });

  it("past the late-start window a never-opened room is confirmed too, not one red click (review of fbaf43f2)", () => {
    expect(roomReopens({ roomOpen: false, ended: true, anchorStatus: "SCHEDULED", pastLateStart: true })).toBe(true);
  });

  it("never while the room is open, and never before the end", () => {
    expect(roomReopens({ roomOpen: true, ended: false, anchorStatus: "LIVE", pastLateStart: true })).toBe(false);
    expect(roomReopens({ roomOpen: false, ended: false, anchorStatus: "COMPLETED", pastLateStart: false })).toBe(false);
  });
});

describe("webinarStatusFromTimes", () => {
  it("the room decides first, then the clock", () => {
    const past = { start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z" };
    expect(webinarStatusFromTimes(past.start, past.end, "LIVE")).toBe("live");
    expect(webinarStatusFromTimes(past.start, past.end, "COMPLETED")).toBe("ended");
    expect(webinarStatusFromTimes(past.start, past.end)).toBe("ended");
    expect(webinarStatusFromTimes(undefined, undefined)).toBe("scheduled");
  });
});
