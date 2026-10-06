import { describe, it, expect } from "vitest";
import { isWebinarOver, webinarBackgroundStyle, webinarVideoLayout } from "@/lib/webinar-page-layout";

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

describe("isWebinarOver (when the end-of-webinar survey may appear)", () => {
  const base = { hostEnded: false, roomOpen: true, pastScheduledEnd: false };
  it("is false while the webinar is live, even after the scheduled end (an overrun)", () => {
    expect(isWebinarOver(base)).toBe(false);
    expect(isWebinarOver({ ...base, pastScheduledEnd: true })).toBe(false);
  });
  it("a room closed BEFORE the scheduled end is a pause, not the end", () => {
    expect(isWebinarOver({ ...base, roomOpen: false })).toBe(false);
  });
  it("is true when the host ends it in Zoom", () => {
    expect(isWebinarOver({ ...base, hostEnded: true })).toBe(true);
  });
  it("is true when the room is closed and the scheduled end has passed (also on a later visit)", () => {
    expect(isWebinarOver({ ...base, roomOpen: false, pastScheduledEnd: true })).toBe(true);
  });
});
