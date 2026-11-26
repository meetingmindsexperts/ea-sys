import { describe, expect, it } from "vitest";
import {
  closesTheDesk,
  readRegistrationClosesAt,
  registrationCloseReminder,
  registrationClosesAtSchema,
  registrationClosedMessage,
  registrationClosedReason,
  settingsClosedReason,
  type AnchorSessionClock,
} from "@/lib/registration-closure";

const NOW = new Date("2026-11-25T16:30:00Z");
const start = new Date("2026-11-25T15:00:00Z");
const end = new Date("2026-11-25T16:15:00Z");

function webinar(settings: Record<string, unknown> = {}, endDate = end) {
  return { eventType: "WEBINAR", settings, endDate };
}
const conference = (settings: Record<string, unknown> = {}, endDate = end) => ({ eventType: "CONFERENCE", settings, endDate });
const clock = (status: string, over: Partial<AnchorSessionClock> = {}): AnchorSessionClock => ({
  status,
  startTime: start,
  endTime: end,
  ...over,
});

describe("registrationClosedReason", () => {
  it("is open by default", () => {
    expect(registrationClosedReason(conference({}, new Date("2026-12-01T00:00:00Z")), null, NOW)).toBeNull();
  });

  it("closes when the switch is off, before anything else", () => {
    expect(registrationClosedReason(webinar({ registrationOpen: false }), clock("COMPLETED"), NOW)).toBe("switched-off");
  });

  it("closes from the organiser's close date on, and not before", () => {
    const at = { registrationClosesAt: "2026-11-25T16:30:00.000Z" };
    expect(registrationClosedReason(conference(at, new Date("2026-12-01")), null, NOW)).toBe("closing-date-passed");
    expect(registrationClosedReason(conference(at, new Date("2026-12-01")), null, new Date("2026-11-25T16:29:59Z"))).toBeNull();
  });

  it("ignores a close date that is not a date", () => {
    expect(readRegistrationClosesAt({ registrationClosesAt: "soon" })).toBeNull();
    expect(readRegistrationClosesAt({ registrationClosesAt: null })).toBeNull();
    expect(readRegistrationClosesAt({ registrationClosesAt: "" })).toBeNull();
    expect(readRegistrationClosesAt(null)).toBeNull();
  });

  it("closes a webinar once its room has closed (Nov 25: the room closed at 16:19 UTC)", () => {
    expect(registrationClosedReason(webinar(), clock("COMPLETED"), NOW)).toBe("webinar-over");
  });

  it("keeps a webinar open while it is live, even past its scheduled end (an overrun)", () => {
    expect(registrationClosedReason(webinar(), clock("LIVE"), NOW)).toBeNull();
  });

  it("does not treat a rehearsal close the day before as the end", () => {
    const dayBefore = new Date("2026-11-24T12:00:00Z");
    expect(registrationClosedReason(webinar(), clock("COMPLETED"), dayBefore)).toBeNull();
  });

  it("closes a webinar past its scheduled end when the room is not live (never opened)", () => {
    expect(registrationClosedReason(webinar(), clock("SCHEDULED"), NOW)).toBe("webinar-over");
  });

  it("goes by the event's end for a webinar with no session of its own", () => {
    expect(registrationClosedReason(webinar(), null, NOW)).toBe("webinar-over");
    expect(registrationClosedReason(webinar(), null, new Date("2026-11-25T16:00:00Z"))).toBeNull();
  });

  it("never closes a conference just because it ended (only the switch or a date close it)", () => {
    expect(registrationClosedReason(conference(), null, NOW)).toBeNull();
  });
});

describe("settingsClosedReason", () => {
  it("reads only the switch and the date", () => {
    expect(settingsClosedReason({}, NOW)).toBeNull();
    expect(settingsClosedReason({ registrationOpen: false }, NOW)).toBe("switched-off");
    expect(settingsClosedReason({ registrationOpen: true, registrationClosesAt: "2026-11-25T00:00:00Z" }, NOW)).toBe(
      "closing-date-passed",
    );
  });
});

describe("registrationClosedMessage", () => {
  it("says the webinar has ended, and closed otherwise", () => {
    expect(registrationClosedMessage("webinar-over")).toMatch(/webinar has ended/);
    expect(registrationClosedMessage("switched-off")).toBe("Registration is closed for this event.");
    expect(registrationClosedMessage("closing-date-passed")).toBe("Registration is closed for this event.");
  });
});

describe("closesTheDesk", () => {
  it("lets the desk QR past the close date only (owner, Nov 26, 2026)", () => {
    expect(closesTheDesk("closing-date-passed")).toBe(false);
    expect(closesTheDesk("switched-off")).toBe(true);
    expect(closesTheDesk("webinar-over")).toBe(true);
  });
});

describe("registrationClosesAtSchema", () => {
  it("takes a full instant or empty, and refuses what the rule could not read", () => {
    expect(registrationClosesAtSchema.safeParse("2026-12-01T05:00:00.000Z").success).toBe(true);
    expect(registrationClosesAtSchema.safeParse("2026-12-01T09:00:00+04:00").success).toBe(true);
    expect(registrationClosesAtSchema.safeParse(null).success).toBe(true);
    expect(registrationClosesAtSchema.safeParse("").success).toBe(true);
    for (const bad of ["1 Dec", "2026-12-01", 1764565200000, true]) {
      expect(registrationClosesAtSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("registrationCloseReminder (the Overview's note)", () => {
  const later = new Date("2026-12-05T00:00:00Z");
  const live = (settings: Record<string, unknown> = {}, endDate = later, status = "PUBLISHED") => ({
    eventType: "CONFERENCE",
    settings,
    endDate,
    status,
  });

  it("reminds a published conference with no close date", () => {
    expect(registrationCloseReminder(live(), NOW)).toBe("no-close-date");
    expect(registrationCloseReminder(live({}, later, "LIVE"), NOW)).toBe("no-close-date");
  });

  it("is quiet once a close date is set, or the switch is off", () => {
    expect(registrationCloseReminder(live({ registrationClosesAt: "2026-12-01T05:00:00.000Z" }), NOW)).toBeNull();
    expect(registrationCloseReminder(live({ registrationOpen: false }), NOW)).toBeNull();
  });

  it("warns when the event has ended and the form is still open, even with a close date after the end", () => {
    expect(registrationCloseReminder(live({}, end), NOW)).toBe("ended-still-open");
    expect(registrationCloseReminder(live({ registrationClosesAt: "2027-01-01T00:00:00.000Z" }, end), NOW)).toBe("ended-still-open");
  });

  it("says nothing for a webinar (it closes itself) or an event the public cannot reach", () => {
    expect(registrationCloseReminder({ ...live(), eventType: "WEBINAR" }, NOW)).toBeNull();
    for (const status of ["DRAFT", "COMPLETED", "CANCELLED"]) {
      expect(registrationCloseReminder(live({}, end, status), NOW)).toBeNull();
    }
  });
});
