/**
 * The browser half.
 *
 * The assertion that matters is that NOTHING is sent from a page we may not
 * measure. The server re-checks, so this is not the security boundary, but the
 * URL of a token-gated page should not leave the browser even to be refused.
 *
 * Everything else here is about not breaking a page: a visitor is filling in a
 * registration form, and measuring that must never throw.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { track, scrollDepthPercent, DEFAULT_ENDPOINT } from "@/analytics/core/beacon";
import type { BeaconPayload } from "@/analytics/core/beacon";

let sent: { endpoint: string; payload: BeaconPayload }[];
const send = (endpoint: string, payload: BeaconPayload) => {
  sent.push({ endpoint, payload });
};

const loc = (pathname: string, search = "") => ({ pathname, search });

beforeEach(() => {
  sent = [];
});

describe("what is reported", () => {
  it("sends a pageview from a measurable page", () => {
    const ok = track("hema-2026", "pageview", loc("/e/hema-2026/register"), {}, undefined, { send });
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].endpoint).toBe(DEFAULT_ENDPOINT);
    expect(sent[0].payload.path).toBe("/e/hema-2026/register");
    expect(sent[0].payload.name).toBe("pageview");
  });

  it("passes the query through for the server to filter", () => {
    // The client does not decide which parameters survive; the server keeps the
    // three utm keys and discards the rest. One place, not two.
    track("x", "pageview", loc("/e/x/register", "?utm_source=linkedin"), {}, undefined, { send });
    expect(sent[0].payload.query).toBe("?utm_source=linkedin");
  });

  it("sends a referring HOST, never the full referrer URL", () => {
    // A referring URL can carry a token or an email in its OWN query. That is
    // somebody else's sensitive data, and it should not leave the browser even
    // to be discarded by us. Reducing it server-side would have been too late.
    track(
      "x",
      "pageview",
      loc("/e/x/register"),
      {},
      "https://mail.example.com/inbox?token=SUPERSECRET&user=a@b.com",
      { send },
    );
    expect(sent[0].payload.referrerHost).toBe("mail.example.com");
    expect(JSON.stringify(sent[0].payload)).not.toMatch(/SUPERSECRET|a@b\.com|inbox/);
  });

  it("drops our own host, so internal navigation is not acquisition", () => {
    track(
      "x",
      "pageview",
      loc("/e/x/register"),
      {},
      "https://events.meetingmindsgroup.com/e/x",
      { send },
      ["events.meetingmindsgroup.com"],
    );
    expect(sent[0].payload.referrerHost).toBeUndefined();
  });

  it("carries engagement figures when given them", () => {
    track("x", "page_engagement", loc("/e/x"), { durationMs: 42_000, scrollDepth: 80 }, undefined, {
      send,
    });
    expect(sent[0].payload).toMatchObject({
      name: "page_engagement",
      durationMs: 42_000,
      scrollDepth: 80,
    });
  });
});

describe("what is never reported", () => {
  it("sends NOTHING from a token-gated page", () => {
    // Not "sends and is refused". Nothing leaves the browser.
    for (const path of [
      "/e/x/rsvp/secret-token",
      "/e/x/reimbursement/secret-token",
      "/e/x/speaker-form/secret-token",
      "/e/x/reset-password",
      "/e/x/confirmation",
      "/e/x/survey",
    ]) {
      const ok = track("x", "pageview", loc(path, "?token=secret"), {}, undefined, { send });
      expect(ok, path).toBe(false);
    }
    expect(sent).toHaveLength(0);
  });

  it("sends nothing from the dashboard", () => {
    expect(track("x", "pageview", loc("/dashboard"), {}, undefined, { send })).toBe(false);
    expect(track("x", "pageview", loc("/settings"), {}, undefined, { send })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("sends nothing without a site", () => {
    expect(track("", "pageview", loc("/e/x/register"), {}, undefined, { send })).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("never breaks the page", () => {
  it("returns false rather than throwing when the sender blows up", () => {
    const boom = () => {
      throw new Error("network on fire");
    };
    expect(() =>
      track("x", "pageview", loc("/e/x/register"), {}, undefined, { send: boom }),
    ).not.toThrow();
    expect(track("x", "pageview", loc("/e/x/register"), {}, undefined, { send: boom })).toBe(false);
  });

  it("survives a nonsense location", () => {
    expect(
      track("x", "pageview", { pathname: "", search: "" }, {}, undefined, { send }),
    ).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("scrollDepthPercent", () => {
  it("reports 100 for a page shorter than the viewport", () => {
    // Everything was visible, so it was all seen. The alternative is dividing
    // by zero and reporting NaN as engagement.
    expect(scrollDepthPercent({ scrollY: 0, innerHeight: 900, documentHeight: 600 })).toBe(100);
  });

  it("reports the fraction seen", () => {
    expect(scrollDepthPercent({ scrollY: 0, innerHeight: 500, documentHeight: 1000 })).toBe(50);
    expect(scrollDepthPercent({ scrollY: 500, innerHeight: 500, documentHeight: 1000 })).toBe(100);
  });

  it("clamps rubbish into range", () => {
    // Elastic scroll on iOS reports a negative scrollY past the top.
    expect(scrollDepthPercent({ scrollY: -200, innerHeight: 500, documentHeight: 1000 })).toBe(30);
    expect(scrollDepthPercent({ scrollY: 99_999, innerHeight: 500, documentHeight: 1000 })).toBe(100);
  });
});
