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

  it("uses a real registration's padded serial for registrationId", () => {
    const v = buildEventPreviewVariables(
      { ...baseEvent, registrations: [{ id: "ckxyz12345678", serialId: 7 }] },
      USER,
    );
    expect(v.registrationId).toBe("007");
  });

  it("falls back to last-8 of the id when the registration has no serial", () => {
    const v = buildEventPreviewVariables(
      { ...baseEvent, registrations: [{ id: "ckabcdEFGH1234", serialId: null }] },
      USER,
    );
    expect(v.registrationId).toBe("EFGH1234");
  });

  it("falls back to the static \"9999\" when the event has no registrations", () => {
    expect(buildEventPreviewVariables(baseEvent, USER).registrationId).toBe("9999");
    expect(
      buildEventPreviewVariables({ ...baseEvent, registrations: [] }, USER).registrationId,
    ).toBe("9999");
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

  // {{presentationDetails}} / {{speakerName}} — before these samples existed,
  // renderTemplate left the LITERAL tokens in the previewed speaker templates
  // (unknown keys pass through unchanged).
  it("carries a sample presentationDetails block so speaker templates preview cleanly", () => {
    const v = buildEventPreviewVariables(baseEvent, USER);
    expect(String(v.presentationDetails)).toContain("<table");
    expect(String(v.presentationDetails)).toContain("Session");
    // Time window + duration, matching what buildPresentationBlocks renders
    // on real sends.
    expect(String(v.presentationDetails)).toContain("9:00 AM – 10:30 AM");
    expect(String(v.presentationDetails)).toContain("(1h 30m)");
    expect(String(v.presentationDetailsText)).toContain("Session:");
    expect(String(v.presentationDetailsText)).toContain("(1h 30m)");
  });

  it("greets {{speakerName}} with the signed-in user's name", () => {
    expect(buildEventPreviewVariables(baseEvent, USER).speakerName).toBe("Aisha Khan");
    // No user name at all → keep the sample speaker.
    expect(buildEventPreviewVariables(baseEvent, {}).speakerName).toBe("Dr. John Doe");
  });

  // {{organizerSignature}} — the preview must show what a real send from this
  // user renders: their profile signature, or NOTHING when they have none.
  it("uses the sender's real signature when the caller fetched one", () => {
    const v = buildEventPreviewVariables(baseEvent, {
      ...USER,
      emailSignature: "<p><strong>Dr. Aisha Khan</strong><br/>MMG</p>",
    });
    expect(v.organizerSignature).toBe("<p><strong>Dr. Aisha Khan</strong><br/>MMG</p>");
  });

  it("renders an empty signature (not the canned sample) when the sender has none", () => {
    const v = buildEventPreviewVariables(baseEvent, { ...USER, emailSignature: null });
    expect(v.organizerSignature).toBe("");
  });

  it("keeps the canned sample signature when the caller did not fetch it", () => {
    const v = buildEventPreviewVariables(baseEvent, USER);
    expect(String(v.organizerSignature)).toContain("Event Organizer");
  });
});
