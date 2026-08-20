/**
 * Bot detection and coarse device classification.
 *
 * Both err deliberately. isBot leans towards excluding, because an over-counted
 * bot is a rounding error while a crawler counted as a person is a number
 * somebody plans around. parseUserAgent leans towards coarse, because the
 * output is meant to answer "does the register page work on phones", not to
 * fingerprint anyone.
 */
import { describe, it, expect } from "vitest";
import { isBot } from "@/analytics/core/bots";
import { parseUserAgent } from "@/analytics/core/user-agent";

const CHROME_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

describe("isBot", () => {
  it("catches the obvious ones", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; AhrefsBot/7.0)",
      "Amazon-Route53-Health-Check-Service (ref 20c6ff28)",
      "curl/8.4.0",
      "python-requests/2.31.0",
      "Mozilla/5.0 HeadlessChrome/120.0.0.0",
      "UptimeRobot/2.0",
    ]) {
      expect(isBot(ua), ua).toBe(true);
    }
  });

  it("catches link-preview fetchers, which contain no bot-like word", () => {
    // These matter more here than on a typical site: event links circulate in
    // WhatsApp groups, and every share triggers a preview fetch that would
    // otherwise read as a visit to a registration page. facebookexternalhit
    // alone had already landed 45 hits on /e/ pages on prod in a fortnight.
    for (const ua of [
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "WhatsApp/2.23.20.0",
      "SkypeUriPreview Preview/0.5",
      "Embedly/0.2",
      "Iframely/1.3.1",
    ]) {
      expect(isBot(ua), ua).toBe(true);
      // Prove the point of the second list: none of these would be caught by a
      // naive check for the word "bot".
      expect(ua.toLowerCase()).not.toContain("bot");
    }
  });

  it("treats an absent user agent as a bot, not a person", () => {
    // Every real browser sends one. Its absence means a script, and defaulting
    // "unknown" to human is the wrong direction for a number people plan around.
    expect(isBot(undefined)).toBe(true);
    expect(isBot(null)).toBe(true);
    expect(isBot("")).toBe(true);
    expect(isBot("-")).toBe(true);
  });

  it("does not flag real browsers", () => {
    for (const ua of [CHROME_DESKTOP, SAFARI_IPHONE, CHROME_ANDROID]) {
      expect(isBot(ua), ua).toBe(false);
    }
  });
});

describe("parseUserAgent", () => {
  it("classifies the three device buckets", () => {
    expect(parseUserAgent(CHROME_DESKTOP).deviceType).toBe("desktop");
    expect(parseUserAgent(SAFARI_IPHONE).deviceType).toBe("mobile");
    expect(parseUserAgent(CHROME_ANDROID).deviceType).toBe("mobile");
  });

  it("does not call a tablet a phone", () => {
    // Android tablets say "android" WITHOUT "mobile". Testing phones first
    // silently reclassifies every one of them.
    const iPad =
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1";
    const androidTablet =
      "Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";
    expect(parseUserAgent(iPad).deviceType).toBe("tablet");
    expect(parseUserAgent(androidTablet).deviceType).toBe("tablet");
  });

  it("resolves browsers that impersonate each other", () => {
    // Edge contains "chrome" and "safari"; Chrome contains "safari". Test the
    // most specific claim first or everything collapses into Safari.
    expect(parseUserAgent("Mozilla/5.0 Chrome/120 Safari/537.36 Edg/120.0").browser).toBe("Edge");
    expect(parseUserAgent(CHROME_DESKTOP).browser).toBe("Chrome");
    expect(parseUserAgent(SAFARI_IPHONE).browser).toBe("Safari");
    expect(parseUserAgent("Mozilla/5.0 Firefox/121.0").browser).toBe("Firefox");
    expect(parseUserAgent("Mozilla/5.0 Chrome/120 OPR/106.0").browser).toBe("Opera");
  });

  it("puts iPad on iOS even though it claims to be a Mac", () => {
    const iPadOS =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/604.1 iPad";
    expect(parseUserAgent(iPadOS).os).toBe("iOS");
    expect(parseUserAgent(CHROME_ANDROID).os).toBe("Android");
    expect(parseUserAgent(CHROME_DESKTOP).os).toBe("Windows");
  });

  it("degrades to Unknown rather than guessing", () => {
    expect(parseUserAgent(null)).toEqual({ deviceType: "desktop", browser: "Unknown", os: "Unknown" });
    expect(parseUserAgent("wat").browser).toBe("Unknown");
  });

  it("stays low-cardinality, so it cannot become a fingerprint", () => {
    // Three coarse strings. If a version number ever appears here, that is a
    // different feature with a different privacy analysis.
    const info = parseUserAgent(CHROME_DESKTOP);
    expect(info.browser).not.toMatch(/\d/);
    expect(info.os).not.toMatch(/\d/);
  });
});
