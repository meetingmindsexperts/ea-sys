/**
 * What an RSVP invitee answered (Oct 26, 2026): a "No" is RESPONDED with no
 * attending row; an option they were never offered reads blank, not "No"
 * (review of 0ba8d492).
 */
import { describe, it, expect } from "vitest";
import { isAttendingAny, rsvpAnswer, rsvpItemAnswer } from "@/lib/rsvp/answer";
import { isAttendingAny as isAttendingAnyFromRsvp } from "@/lib/rsvp/rsvp";

const answeredAt = "2026-10-20T10:00:00Z";
const yes = { status: "RESPONDED", respondedAt: answeredAt, responses: [{ itemId: "a", attending: true, guestCount: 1 }] };
const no = { status: "RESPONDED", respondedAt: answeredAt, responses: [] };
const pending = { status: "PENDING", respondedAt: null, responses: [] };

const open = { id: "a", createdAt: "2026-10-01T00:00:00Z", isActive: true, startsAt: "2026-11-01T18:00:00Z", rsvpDeadline: null };
const other = { ...open, id: "b" };

describe("rsvpAnswer", () => {
  it("reads attending, declined and pending", () => {
    expect(rsvpAnswer(yes)).toBe("ATTENDING");
    expect(rsvpAnswer(no)).toBe("DECLINED");
    expect(rsvpAnswer({ ...no, responses: [{ itemId: "a", attending: false, guestCount: 0 }] })).toBe("DECLINED");
    expect(rsvpAnswer(pending)).toBe("PENDING");
  });

  it("rsvp.ts re-exports the same isAttendingAny (one copy of the rule)", () => {
    expect(isAttendingAnyFromRsvp).toBe(isAttendingAny);
  });
});

describe("rsvpItemAnswer", () => {
  it("Yes / No for an option they were offered, blank while pending", () => {
    expect(rsvpItemAnswer(yes, open)).toBe("Yes");
    expect(rsvpItemAnswer(yes, other)).toBe("No");
    expect(rsvpItemAnswer(no, open)).toBe("No");
    expect(rsvpItemAnswer(pending, open)).toBe("");
  });

  it("blank for an option added after they answered", () => {
    expect(rsvpItemAnswer(no, { ...open, createdAt: "2026-10-21T00:00:00Z" })).toBe("");
  });

  it("blank for an option switched off, or closed before they answered", () => {
    expect(rsvpItemAnswer(no, { ...open, isActive: false })).toBe("");
    expect(rsvpItemAnswer(no, { ...open, rsvpDeadline: "2026-10-15T00:00:00Z" })).toBe("");
    // No deadline: it closes at its start, as on the public form.
    expect(rsvpItemAnswer(no, { ...open, startsAt: "2026-10-18T00:00:00Z" })).toBe("");
  });

  it("a yes always shows, even on an option since switched off", () => {
    expect(rsvpItemAnswer(yes, { ...open, isActive: false })).toBe("Yes");
  });

  it("unknown dates read as offered, so older rows keep their No", () => {
    expect(rsvpItemAnswer({ ...no, respondedAt: null }, open)).toBe("No");
    expect(rsvpItemAnswer(no, { id: "a" })).toBe("No");
  });
});
