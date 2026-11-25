/**
 * The words on an RSVP's page (owner, Nov 25, 2026): the organiser's own when they wrote some,
 * otherwise the built-in wording; and the title in the thank-you's greeting, read from the person's
 * own record on the event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { speaker: { findFirst: vi.fn() }, registration: { findFirst: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant/event-tenant", () => ({ findGatedEvent: vi.fn() }));

import {
  defaultRsvpQuestion,
  defaultRsvpQuestionHelp,
  rsvpQuestionHelpText,
  rsvpQuestionText,
  rsvpThankYouText,
} from "@/lib/rsvp/question-wording";
import { loadInviteeTitle } from "@/lib/rsvp/server";

describe("the question, its line and the thank-you", () => {
  it("the built-in wording follows the RSVP's shape", () => {
    expect(defaultRsvpQuestion(false, false)).toBe("Will you be attending?");
    expect(defaultRsvpQuestion(true, true)).toBe("Which one will you attend?");
    expect(defaultRsvpQuestion(true, false)).toBe("Which of these will you attend?");
    expect(defaultRsvpQuestionHelp(false, false)).toContain("Tick the box if you’ll join");
    expect(defaultRsvpQuestionHelp(true, true)).toContain("Choose one option");
    expect(defaultRsvpQuestionHelp(true, false)).toContain("Tick everything you’ll join");
  });

  it("the organiser's own words win; nothing, or only spaces, means the built-in wording", () => {
    const own = { name: "Dinner RSVP", questionText: "Will you join us?", questionHelpText: "One tick is enough.", thankYouText: "See you there." };
    expect(rsvpQuestionText(own, false, false)).toBe("Will you join us?");
    expect(rsvpQuestionHelpText(own, false, false)).toBe("One tick is enough.");
    expect(rsvpThankYouText(own)).toBe("See you there.");
    const empty = { name: "Dinner RSVP", questionText: null, questionHelpText: "   ", thankYouText: "" };
    expect(rsvpQuestionText(empty, false, false)).toBe("Will you be attending?");
    expect(rsvpQuestionHelpText(empty, false, false)).toBe(defaultRsvpQuestionHelp(false, false));
    expect(rsvpThankYouText(empty)).toBe(
      "Your response to Dinner RSVP has been recorded. You can revisit this link to change it any time before the deadline.",
    );
  });
});

describe("the title in the thank-you's greeting", () => {
  const invite = { eventId: "ev1", inviteeEmail: "Hadeel_Ammar@Example.com", registrationId: null as string | null, speakerId: null as string | null };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.speaker.findFirst.mockResolvedValue(null);
    mockDb.registration.findFirst.mockResolvedValue(null);
  });

  it("comes from the speaker the invite was imported from, on this event only", async () => {
    mockDb.speaker.findFirst.mockResolvedValueOnce({ title: "DR" });
    expect(await loadInviteeTitle({ ...invite, speakerId: "sp1" })).toBe("DR");
    expect(mockDb.speaker.findFirst.mock.calls[0][0].where).toEqual({ id: "sp1", eventId: "ev1" });
    // Found on the linked record: no search by address.
    expect(mockDb.speaker.findFirst).toHaveBeenCalledTimes(1);
  });

  it("or from the linked registration, never a cancelled one", async () => {
    mockDb.registration.findFirst.mockResolvedValueOnce({ attendee: { title: "PROF" } });
    expect(await loadInviteeTitle({ ...invite, registrationId: "r1" })).toBe("PROF");
    expect(mockDb.registration.findFirst.mock.calls[0][0].where).toEqual({ id: "r1", eventId: "ev1", status: { not: "CANCELLED" } });
  });

  it("an invitee typed by hand is matched on their exact address, on this event (an underscore is not a wildcard)", async () => {
    mockDb.speaker.findFirst.mockResolvedValueOnce({ title: "DR" });
    expect(await loadInviteeTitle(invite)).toBe("DR");
    const where = mockDb.speaker.findFirst.mock.calls[0][0].where;
    expect(where.eventId).toBe("ev1");
    expect(where.email).toEqual({ equals: "Hadeel\\_Ammar@Example.com", mode: "insensitive" });
  });

  it("nobody on the event has that address, or their record has no title: no title", async () => {
    expect(await loadInviteeTitle(invite)).toBeNull();
    mockDb.speaker.findFirst.mockResolvedValueOnce({ title: null });
    expect(await loadInviteeTitle({ ...invite, speakerId: "sp1" })).toBeNull();
  });
});
