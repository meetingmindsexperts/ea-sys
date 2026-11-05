import { describe, it, expect } from "vitest";
import { isWebinarOver, webinarBackgroundStyle, webinarRoomEnded, webinarVideoLayout } from "@/lib/webinar-page-layout";

describe("webinarVideoLayout", () => {
  it("Q&A + panelists: three columns from xl, panelists left and under the video below xl", () => {
    const l = webinarVideoLayout({ showQa: true, showPanelists: true });
    expect(l.grid).toContain("xl:grid-cols-[272px_minmax(0,1fr)_340px]");
    expect(l.grid).toContain("lg:grid-cols-[minmax(0,1fr)_292px]");
    expect([l.videoCol, l.qaCol, l.panelistsCol]).toEqual(["order-1 xl:order-2", "order-2 xl:order-3", "order-3 xl:order-1"]);
  });

  it("Q&A only: video beside Q&A, no reordering", () => {
    const l = webinarVideoLayout({ showQa: true, showPanelists: false });
    expect(l.grid).toContain("xl:grid-cols-[minmax(0,1fr)_340px]");
    expect([l.videoCol, l.qaCol, l.panelistsCol]).toEqual(["", "", ""]);
  });

  it("panelists only (Zoom mode): the side column waits for xl so the embed keeps a laptop's width", () => {
    const l = webinarVideoLayout({ showQa: false, showPanelists: true });
    expect(l.grid).toContain("xl:grid-cols-[272px_minmax(0,1fr)]");
    expect(l.grid).not.toContain("lg:grid-cols");
    expect([l.videoCol, l.panelistsCol]).toEqual(["order-1 xl:order-2", "order-2 xl:order-1"]);
  });

  it("neither: no grid", () => {
    expect(webinarVideoLayout({ showQa: false, showPanelists: false }).grid).toBeUndefined();
  });
});

describe("webinarBackgroundStyle", () => {
  it("quotes the URL without re-encoding an already-encoded one", () => {
    expect(webinarBackgroundStyle("https://cdn.example.com/a%20b.jpg")).toEqual({ backgroundImage: 'url("https://cdn.example.com/a%20b.jpg")' });
  });

  it("escapes a quote so the value cannot leave the CSS string", () => {
    expect(webinarBackgroundStyle('/uploads/x".jpg')?.backgroundImage).toBe('url("/uploads/x\\".jpg")');
  });

  it("no URL, no style", () => {
    expect(webinarBackgroundStyle(null)).toBeUndefined();
  });
});

describe("isWebinarOver (when the exit screen and end-of-webinar survey appear)", () => {
  const base = { hostEnded: false, roomOpen: true, lobbyEnded: false };
  it("is false while the room is open, even after the scheduled end (an overrun)", () => {
    expect(isWebinarOver(base)).toBe(false);
    expect(isWebinarOver({ ...base, lobbyEnded: true })).toBe(false);
  });
  it("is false before the room ever opens (pre-start waiting room)", () => {
    expect(isWebinarOver({ ...base, roomOpen: false })).toBe(false);
  });
  it("is true when the host ends it in Zoom", () => {
    expect(isWebinarOver({ ...base, hostEnded: true })).toBe(true);
  });
  it("a room closed BEFORE the scheduled end is the end, not a pause (owner, Nov 5 2026)", () => {
    // lobby-status reports ended once the close marks the session COMPLETED.
    expect(isWebinarOver({ ...base, roomOpen: false, lobbyEnded: true })).toBe(true);
  });
});

describe("webinarRoomEnded (lobby-status and the end-survey submit)", () => {
  const start = Date.UTC(2026, 10, 5, 8, 30);
  const end = Date.UTC(2026, 10, 5, 9, 30);
  const at = (status: string, now: number) => webinarRoomEnded({ status, startMs: start, endMs: end, now });
  it("closed after the start, before the scheduled end: ended (an early close)", () => {
    expect(at("COMPLETED", start + 25 * 60_000)).toBe(true);
  });
  it("COMPLETED before the start is a rehearsal, not the end (review of 66d8ef6e, HIGH)", () => {
    expect(at("COMPLETED", start - 86_400_000)).toBe(false);
    expect(at("COMPLETED", start - 60_000)).toBe(false);
  });
  it("never while LIVE, even past the scheduled end (an overrun)", () => {
    expect(at("LIVE", end + 600_000)).toBe(false);
  });
  it("past the scheduled end without being live: ended", () => {
    expect(at("SCHEDULED", end + 1)).toBe(true);
  });
  it("scheduled and not yet started: not ended", () => {
    expect(at("SCHEDULED", start - 60_000)).toBe(false);
  });
});
