/**
 * Zoom host-credential visibility (program/agenda review, BLOCKER B1).
 *
 * `startUrl` is the Zoom HOST start link — whoever holds it IS the host. It
 * must never reach an attendee role, and the sessions LIST GET has no
 * denyReviewer while buildEventAccessWhere grants org-null attendee roles
 * event access by linkage.
 */
import { describe, it, expect } from "vitest";
import {
  canViewZoomHostCredentials,
  redactZoomHostFields,
  redactZoomHostFieldsFromSessions,
  ZOOM_HOST_KEYS,
} from "@/lib/zoom-visibility";

describe("canViewZoomHostCredentials", () => {
  it.each(["SUPER_ADMIN", "ADMIN", "ORGANIZER"])("allows the host role %s", (role) => {
    expect(canViewZoomHostCredentials(role)).toBe(true);
  });

  it.each(["REGISTRANT", "SUBMITTER", "REVIEWER", "MEMBER", "ONSITE"])(
    "denies the non-host role %s",
    (role) => {
      expect(canViewZoomHostCredentials(role)).toBe(false);
    },
  );

  it("fails closed for unknown / missing roles", () => {
    expect(canViewZoomHostCredentials(null)).toBe(false);
    expect(canViewZoomHostCredentials(undefined)).toBe(false);
    expect(canViewZoomHostCredentials("")).toBe(false);
    expect(canViewZoomHostCredentials("SOME_FUTURE_ROLE")).toBe(false);
  });

  it("treats API-key callers as admin-equivalent (org-scoped key, null role)", () => {
    expect(canViewZoomHostCredentials(null, true)).toBe(true);
  });

  it("is NARROWER than finance visibility — desk roles record payments, they don't host webinars", () => {
    // MEMBER + ONSITE can see money but must not see host credentials.
    expect(canViewZoomHostCredentials("MEMBER")).toBe(false);
    expect(canViewZoomHostCredentials("ONSITE")).toBe(false);
  });
});

describe("redactZoomHostFields", () => {
  const session = () => ({
    id: "s1",
    name: "Keynote",
    zoomMeeting: {
      id: "z1",
      joinUrl: "https://zoom.us/j/123",
      startUrl: "https://zoom.us/s/123?zak=SECRET",
      passcode: "hunter2",
      streamKey: "rtmp-secret",
      streamStatus: "ACTIVE",
    },
  });

  it("nulls every host key and keeps the attendee joinUrl", () => {
    const out = redactZoomHostFields(session());
    expect(out.zoomMeeting.startUrl).toBeNull();
    expect(out.zoomMeeting.streamKey).toBeNull();
    expect(out.zoomMeeting.passcode).toBeNull();
    expect(out.zoomMeeting.joinUrl).toBe("https://zoom.us/j/123");
    expect(out.zoomMeeting.streamStatus).toBe("ACTIVE");
  });

  it("does not mutate the input", () => {
    const input = session();
    redactZoomHostFields(input);
    expect(input.zoomMeeting.startUrl).toBe("https://zoom.us/s/123?zak=SECRET");
  });

  it("covers exactly the documented host keys", () => {
    expect([...ZOOM_HOST_KEYS].sort()).toEqual(["passcode", "startUrl", "streamKey"]);
  });

  it("no-ops on a session with no zoomMeeting", () => {
    const s = { id: "s2", zoomMeeting: null };
    expect(redactZoomHostFields(s)).toEqual(s);
  });

  it("redacts a whole list", () => {
    const out = redactZoomHostFieldsFromSessions([session(), session()]);
    for (const s of out) {
      expect(s.zoomMeeting.startUrl).toBeNull();
      expect(s.zoomMeeting.streamKey).toBeNull();
    }
  });
});
