/**
 * The CRM email's event tokens (Oct 27, 2026): dates in the EVENT's timezone,
 * empty (never "TBA") without an event, and one token list the regex and the
 * dialogs share.
 */
import { describe, it, expect } from "vitest";
import {
  CRM_EMAIL_TOKENS,
  CRM_EMAIL_TOKEN_KEYS,
  CRM_EMAIL_TOKEN_RE,
  crmEventVars,
  startsWithGreeting,
} from "@/crm/lib/crm-email-tokens";

const EVENT = {
  name: "MEHFC 2027",
  // 01:00 Dubai on Feb 5 is still Feb 4 in UTC: the date must follow the event.
  startDate: new Date("2027-02-04T21:00:00Z"),
  endDate: new Date("2027-02-06T12:00:00Z"),
  timezone: "Asia/Dubai",
  venue: "Grand Hyatt",
  city: "Dubai",
  country: "United Arab Emirates",
};

describe("crmEventVars", () => {
  it("formats the event's dates in its own timezone", () => {
    expect(crmEventVars(EVENT)).toEqual({
      eventName: "MEHFC 2027",
      eventVenue: "Grand Hyatt",
      eventCity: "Dubai",
      eventCountry: "United Arab Emirates",
      eventStartDate: "Friday, February 5, 2027",
      eventEndDate: "Saturday, February 6, 2027",
      eventDates: expect.stringMatching(/^February 5\s*[–-]\s*6, 2027$/),
    });
  });

  it("is a single date for a one-day event", () => {
    const oneDay = { ...EVENT, endDate: new Date("2027-02-05T10:00:00Z") };
    expect(crmEventVars(oneDay).eventDates).toBe("February 5, 2027");
  });

  it("is empty, never a placeholder, for a deal with no event", () => {
    expect(Object.values(crmEventVars(null)).every((v) => v === "")).toBe(true);
  });

  it("blanks a missing venue rather than printing null", () => {
    expect(crmEventVars({ ...EVENT, venue: null }).eventVenue).toBe("");
  });

  it("covers every event token the list offers", () => {
    // (senderName / senderEmail come from the sender, not the event.)
    const eventKeys = CRM_EMAIL_TOKEN_KEYS.filter((k) => k.startsWith("event"));
    expect(CRM_EMAIL_TOKENS).toContain("{{organizerSignature}}");
    expect(Object.keys(crmEventVars(EVENT)).sort()).toEqual([...eventKeys].sort());
  });
});

describe("CRM_EMAIL_TOKEN_RE", () => {
  it("matches every offered token, with spaces inside the braces", () => {
    for (const k of CRM_EMAIL_TOKEN_KEYS) {
      expect(`{{ ${k} }}`.replace(CRM_EMAIL_TOKEN_RE, "X")).toBe("X");
    }
  });

  it("leaves tokens the CRM does not offer alone", () => {
    expect("{{registrationLink}}".replace(CRM_EMAIL_TOKEN_RE, "X")).toBe("{{registrationLink}}");
  });
});

describe("startsWithGreeting (Oct 27, 2026: no more \"Dear Saleh, Dear Saleh\")", () => {
  it("sees a greeting the message already opens with, through markup and spaces", () => {
    expect(startsWithGreeting("<p>Dear Saleh,</p><p>We would…</p>")).toBe(true);
    expect(startsWithGreeting("<p>&nbsp;<strong>Hi</strong> team</p>")).toBe(true);
    expect(startsWithGreeting("<p>Good morning Sohail</p>")).toBe(true);
    expect(startsWithGreeting("Hello,")).toBe(true);
  });

  it("does not mistake an ordinary opening line for a greeting", () => {
    expect(startsWithGreeting("<p>Thank you for your time</p>")).toBe(false);
    expect(startsWithGreeting("<p>Dearest partners</p>")).toBe(false);
    expect(startsWithGreeting("<p>Highlights of MEHFC 2027</p>")).toBe(false);
    expect(startsWithGreeting("<p>Hi-tech partners welcome</p>")).toBe(false);
  });
});
