/**
 * buildEventPreviewVariables — preview/test emails must reflect the REAL event
 * (name, dates, venue, organizer, ticket type) instead of the generic samples.
 */
import { describe, it, expect } from "vitest";
import { buildEventPreviewVariables } from "@/lib/email";

const USER = { firstName: "Aisha", lastName: "Khan", email: "aisha@org.com" };

const baseEvent = {
  name: "Cardiology Summit 2026",
  startDate: new Date("2026-09-10T08:00:00+04:00"),
  endDate: new Date("2026-09-10T18:00:00+04:00"),
  venue: "Madinat Jumeirah",
  address: "King Salman St",
  city: "Dubai",
  timezone: "Asia/Dubai",
  supportEmail: "info@cardiosummit.com",
  organization: { name: "Meeting Minds Group" },
  ticketTypes: [{ name: "Physician" }],
};

describe("buildEventPreviewVariables", () => {
  it("uses the real event name / venue / organizer, not the sample defaults", () => {
    const v = buildEventPreviewVariables(baseEvent, USER);
    expect(v.eventName).toBe("Cardiology Summit 2026");
    expect(v.eventName).not.toBe("Sample Conference 2026");
    expect(v.eventVenue).toBe("Madinat Jumeirah");
    expect(v.eventAddress).toBe("King Salman St, Dubai");
    expect(v.organizerName).toBe("Meeting Minds Group");
    expect(v.organizerEmail).toBe("info@cardiosummit.com");
    expect(v.ticketType).toBe("Physician");
  });

  it("greets the recipient (test goes to the signed-in user)", () => {
    const v = buildEventPreviewVariables(baseEvent, USER);
    expect(v.firstName).toBe("Aisha");
    expect(v.lastName).toBe("Khan");
  });

  it("formats a single-day event as one date, multi-day as a range", () => {
    const single = buildEventPreviewVariables(baseEvent, USER);
    expect(String(single.eventDate)).not.toContain("–");

    const multi = buildEventPreviewVariables(
      { ...baseEvent, endDate: new Date("2026-09-12T18:00:00+04:00") },
      USER,
    );
    expect(String(multi.eventDate)).toContain("–");
  });

  it("falls back to the user + defaults when event fields are absent", () => {
    const v = buildEventPreviewVariables(
      { name: "Bare Event", startDate: new Date("2026-09-10T08:00:00Z"), organization: null },
      USER,
    );
    expect(v.organizerName).toBe("Aisha Khan"); // org name absent → user
    expect(v.organizerEmail).toBe("aisha@org.com"); // supportEmail absent → user
    expect(v.eventVenue).toBe(""); // venue absent
    expect(v.ticketType).toBe("VIP Pass"); // no ticket types → sample default kept
  });

  it("keeps entity-specific samples (abstract/payment) that have no event source", () => {
    const v = buildEventPreviewVariables(baseEvent, USER);
    expect(v.abstractTitle).toBe("Sample Abstract Title");
    expect(v.amount).toBe("USD 100.00");
  });

  it("lets `extra` overrides win (custom subject/message from the bulk preview)", () => {
    const v = buildEventPreviewVariables(baseEvent, USER, { subject: "My Subject", message: "Hi" });
    expect(v.subject).toBe("My Subject");
    expect(v.message).toBe("Hi");
  });
});
