/**
 * Guards against the two Zoom misconfigurations that cost 2026-08-19.
 *
 * Both share a shape worth naming: the wrong value is ACCEPTED everywhere it is
 * entered, and only fails later, in a place we cannot see. Signing with a
 * Server-to-Server Client ID produces a perfectly well-formed signature and a
 * 200 from our own API; it is Zoom, inside the attendee's browser, that says
 * "Signature is invalid". Creating the anchor's Zoom object as a MEETING
 * succeeds outright and breaks panelists and analytics quietly afterwards.
 *
 * So neither can be caught by testing the happy path. The tests below pin the
 * refusals themselves.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("SDK key must not be the Server-to-Server Client ID", () => {
  const src = read("src/app/api/organization/zoom/credentials/route.ts");

  it("refuses the OAuth client id in either SDK key field", () => {
    expect(src).toContain("SDK_KEY_IS_OAUTH_CLIENT_ID");
    // Both fields, not just the one that happened to be wrong on the day.
    expect(src).toContain('["sdkKeyProd", validated.data.sdkKeyProd]');
    expect(src).toContain('["sdkKeyDev", validated.data.sdkKeyDev]');
  });

  it("compares against the client id being SAVED, not a stale stored one", () => {
    // A single request can set clientId and sdkKeyProd together. Comparing
    // against the previously stored value would wave that through.
    expect(src).toContain("const effectiveClientId = validated.data.clientId.trim()");
  });

  it("logs the refusal", () => {
    expect(src).toContain("zoom:credentials-sdk-key-is-oauth-client-id");
  });

  it("names the fix, not just the error", () => {
    // "Invalid credentials" would have sent someone back to the same wrong app.
    expect(src).toContain("General App with the Meeting SDK feature enabled");
  });
});

describe("the webinar anchor session must host a Webinar, not a Meeting", () => {
  const src = read("src/app/api/events/[eventId]/sessions/[sessionId]/zoom/route.ts");

  it("refuses MEETING on the anchor of a WEBINAR event", () => {
    expect(src).toContain("WEBINAR_ANCHOR_REQUIRES_WEBINAR");
    expect(src).toContain('event.eventType === "WEBINAR" && meetingTypeRequested === "MEETING"');
  });

  it("scopes the refusal to the ANCHOR session only", () => {
    // A webinar event may still hold ordinary meetings on other sessions, e.g.
    // a panelist rehearsal. Only the anchor is load-bearing.
    expect(src).toContain("webinar?.sessionId === sessionId");
  });

  it("logs the refusal", () => {
    expect(src).toContain("zoom:webinar-anchor-meeting-type-refused");
  });
});

describe("event Zoom default follows the event type", () => {
  const src = read("src/app/api/events/[eventId]/zoom/settings/route.ts");

  it("derives the default rather than hardcoding MEETING", () => {
    expect(src).toContain("function defaultMeetingTypeFor(");
    expect(src).toContain('eventType === "WEBINAR" ? "WEBINAR" : "MEETING"');
    // The old flat default is what armed the trap on every webinar event.
    expect(src).not.toContain('defaultMeetingType: zoom.defaultMeetingType || "MEETING"');
    expect(src).not.toContain('defaultMeetingType: validated.data.defaultMeetingType || "MEETING"');
  });

  it("still lets an explicit choice win", () => {
    // Derivation supplies the default; it must not override a stored value.
    expect(src).toContain("zoom.defaultMeetingType || defaultMeetingTypeFor(");
  });
});

describe("the browser failure report identifies which credentials were used", () => {
  it("accepts and logs a key prefix", () => {
    const src = read(
      "src/app/api/public/events/[slug]/sessions/[sessionId]/join-error/route.ts",
    );
    expect(src).toContain("sdkKeyPrefix");
    expect(src).toContain("sdkKeyPrefix: parsed.data.sdkKeyPrefix");
  });

  it("is sent by the session page", () => {
    // The server's own zoom:signature-generated line is INFO, and only warn+
    // reaches SystemLog on EC2 — so without this the prefix never reaches /logs.
    const src = read("src/app/e/[slug]/session/[sessionId]/page.tsx");
    expect(src).toContain("sdkKeyPrefix: joinInfo.sdkKey?.slice(0, 6)");
  });
});
