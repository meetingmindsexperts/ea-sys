/**
 * Webinar feedback batch (Aug 3, 2026) — phase 1 pins.
 *
 * 1) Lobby holding-video embeds must carry the non-interactive + jsapi param
 *    set: the iframe is pointer-events-none (nothing on the provider player
 *    is clickable — no pause, no title bar, no "more videos", no copy link),
 *    so the waiting room's OWN unmute button drives audio via postMessage,
 *    which requires enablejsapi=1 on YouTube.
 * 2) calendar-links.ts — timezone-correct (UTC-encoded) Google/Outlook URLs +
 *    RFC 5545 ICS. These exist because mail clients auto-parsed the email's
 *    "Date:/Time:" text and minted WRONG calendar chips; explicit UTC
 *    artifacts are timezone-proof by construction.
 */
import { describe, it, expect } from "vitest";
import { parseLobbyVideo } from "@/lib/webinar/lobby-video";
import {
  utcStamp,
  googleCalendarUrl,
  outlookCalendarUrl,
  buildIcsContent,
  type CalendarEventInput,
} from "@/lib/calendar-links";

describe("lobby video embed params", () => {
  it("YouTube embed is muted-autoplay, chrome-less, and jsapi-enabled", () => {
    const v = parseLobbyVideo("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(v?.provider).toBe("youtube");
    const url = new URL(v!.embedUrl);
    expect(url.hostname).toBe("www.youtube-nocookie.com");
    for (const [k, val] of [
      ["autoplay", "1"],
      ["mute", "1"],
      ["controls", "0"],
      ["disablekb", "1"],
      ["fs", "0"],
      ["iv_load_policy", "3"],
      // The waiting room's own mute/unmute button needs the JS API.
      ["enablejsapi", "1"],
      ["rel", "0"],
    ] as const) {
      expect(url.searchParams.get(k), k).toBe(val);
    }
  });

  it("Vimeo embed stays background-mode (chrome-less, muted, looped)", () => {
    const v = parseLobbyVideo("https://vimeo.com/123456789");
    const url = new URL(v!.embedUrl);
    expect(url.searchParams.get("background")).toBe("1");
    expect(url.searchParams.get("muted")).toBe("1");
    expect(url.searchParams.get("loop")).toBe("1");
  });
});

const EV: CalendarEventInput = {
  title: "Best of EHA in CLL 2026",
  description: "Join: https://x.test/e/eha/session/s1\nPasscode: 123456",
  location: "https://x.test/e/eha/session/s1",
  // 10:00 Dubai (GMT+4) == 06:00 UTC — the exact class of bug this fixes.
  start: new Date("2026-09-01T06:00:00.000Z"),
  end: new Date("2026-09-01T07:30:00.000Z"),
};

describe("calendar-links", () => {
  it("utcStamp emits the UTC basic format", () => {
    expect(utcStamp(EV.start)).toBe("20260901T060000Z");
  });

  it("Google URL carries UTC start/end — clients localize correctly", () => {
    const u = new URL(googleCalendarUrl(EV));
    expect(u.hostname).toBe("calendar.google.com");
    expect(u.searchParams.get("dates")).toBe("20260901T060000Z/20260901T073000Z");
    expect(u.searchParams.get("text")).toBe(EV.title);
  });

  it("Outlook URL carries ISO UTC start/end", () => {
    const u = new URL(outlookCalendarUrl(EV));
    expect(u.searchParams.get("startdt")).toBe("2026-09-01T06:00:00.000Z");
    expect(u.searchParams.get("enddt")).toBe("2026-09-01T07:30:00.000Z");
  });

  it("ICS: CRLF lines, UTC DTSTART/DTEND, escaped text, stable UID", () => {
    const ics = buildIcsContent(EV, "uid-1@ea-sys");
    expect(ics).toContain("BEGIN:VCALENDAR\r\n");
    expect(ics).toContain("DTSTART:20260901T060000Z\r\n");
    expect(ics).toContain("DTEND:20260901T073000Z\r\n");
    expect(ics).toContain("UID:uid-1@ea-sys\r\n");
    // Newline in the description must be escaped per RFC 5545.
    expect(ics).toContain("DESCRIPTION:Join: https://x.test/e/eha/session/s1\\nPasscode: 123456");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("ICS escapes commas/semicolons in title + location", () => {
    const ics = buildIcsContent(
      { ...EV, title: "A, B; C", location: "Hall 1, Dubai" },
      "uid-2",
    );
    expect(ics).toContain("SUMMARY:A\\, B\\; C");
    expect(ics).toContain("LOCATION:Hall 1\\, Dubai");
  });
});
