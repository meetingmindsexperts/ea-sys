/** What an RSVP invitee answered (Oct 26, 2026): a "No" is RESPONDED with no attending row. */
import { describe, it, expect } from "vitest";
import { rsvpAnswer, rsvpItemAnswer } from "@/lib/rsvp/answer";

const yes = { status: "RESPONDED", responses: [{ itemId: "a", attending: true, guestCount: 1 }] };
const no = { status: "RESPONDED", responses: [] };
const pending = { status: "PENDING", responses: [] };

describe("rsvpAnswer", () => {
  it("reads attending, declined and pending", () => {
    expect(rsvpAnswer(yes)).toBe("ATTENDING");
    expect(rsvpAnswer(no)).toBe("DECLINED");
    expect(rsvpAnswer({ status: "RESPONDED", responses: [{ itemId: "a", attending: false, guestCount: 0 }] })).toBe("DECLINED");
    expect(rsvpAnswer(pending)).toBe("PENDING");
  });
});

describe("rsvpItemAnswer", () => {
  it("Yes / No once answered, blank while pending", () => {
    expect(rsvpItemAnswer(yes, "a")).toBe("Yes");
    expect(rsvpItemAnswer(yes, "b")).toBe("No");
    expect(rsvpItemAnswer(no, "a")).toBe("No");
    expect(rsvpItemAnswer(pending, "a")).toBe("");
  });
});
