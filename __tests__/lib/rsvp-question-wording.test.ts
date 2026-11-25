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
  rsvpGreetingName,
  rsvpQuestionHelpText,
  rsvpQuestionText,
  rsvpThankYouText,
} from "@/lib/rsvp/question-wording";
import { loadInviteeTitle } from "@/lib/rsvp/server";
import { changedPageText } from "@/components/rsvp/page-text-dialog";

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

describe("the greeting's name", () => {
  it("the title goes before the name, and never twice", () => {
    expect(rsvpGreetingName("Dr.", "Hadeel Ammar")).toBe("Dr. Hadeel Ammar");
    expect(rsvpGreetingName("", "Hadeel Ammar")).toBe("Hadeel Ammar");
    expect(rsvpGreetingName(undefined, "Hadeel Ammar")).toBe("Hadeel Ammar");
    // Typed in by hand with a title already: kept exactly as typed.
    expect(rsvpGreetingName("Dr.", "Dr. Hadeel Ammar")).toBe("Dr. Hadeel Ammar");
    expect(rsvpGreetingName("Dr.", "Prof Hadeel Ammar")).toBe("Prof Hadeel Ammar");
    expect(rsvpGreetingName("Mr.", "dr hadeel ammar")).toBe("dr hadeel ammar");
    // A name that merely begins with those letters is not a title.
    expect(rsvpGreetingName("Dr.", "Drake Morgan")).toBe("Dr. Drake Morgan");
    expect(rsvpGreetingName("Ms.", "Msgana Tesfaye")).toBe("Ms. Msgana Tesfaye");
  });
});

describe("the console sends only the boxes that changed (review of 3b8d4f365)", () => {
  const opened = { description: "Black tie.", questionText: "", questionHelpText: "", thankYouText: "See you there." };

  it("nothing changed, or only spaces added: nothing to send", () => {
    expect(changedPageText(opened, { ...opened })).toEqual({});
    expect(changedPageText(opened, { ...opened, description: "Black tie.  " })).toEqual({});
  });

  it("a changed box is sent trimmed; a cleared box is sent empty (back to the built-in wording); the rest are left out", () => {
    expect(changedPageText(opened, { ...opened, questionText: " Will you join us? " })).toEqual({ questionText: "Will you join us?" });
    expect(changedPageText(opened, { ...opened, thankYouText: "" })).toEqual({ thankYouText: "" });
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
    // Bound to this event, and to the invitee's own address: an id alone is never trusted.
    expect(mockDb.speaker.findFirst.mock.calls[0][0].where).toEqual({
      id: "sp1",
      eventId: "ev1",
      email: { equals: "Hadeel\\_Ammar@Example.com", mode: "insensitive" },
    });
    // Found on the linked record: no search by address.
    expect(mockDb.speaker.findFirst).toHaveBeenCalledTimes(1);
  });

  it("or from the linked registration, never a cancelled one", async () => {
    mockDb.registration.findFirst.mockResolvedValueOnce({ attendee: { title: "PROF" } });
    expect(await loadInviteeTitle({ ...invite, registrationId: "r1" })).toBe("PROF");
    expect(mockDb.registration.findFirst.mock.calls[0][0].where).toEqual({
      id: "r1",
      eventId: "ev1",
      status: { not: "CANCELLED" },
      attendee: { email: { equals: "Hadeel\\_Ammar@Example.com", mode: "insensitive" } },
    });
  });

  it("an invitee typed by hand is matched on their exact address, on this event (an underscore is not a wildcard)", async () => {
    mockDb.speaker.findFirst.mockResolvedValueOnce({ title: "DR" });
    expect(await loadInviteeTitle(invite)).toBe("DR");
    const where = mockDb.speaker.findFirst.mock.calls[0][0].where;
    expect(where.eventId).toBe("ev1");
    expect(where.email).toEqual({ equals: "Hadeel\\_Ammar@Example.com", mode: "insensitive" });
    // The registration search by address never reads a cancelled one either.
    const regWhere = mockDb.registration.findFirst.mock.calls[0][0].where;
    expect(regWhere).toMatchObject({ eventId: "ev1", status: { not: "CANCELLED" } });
    expect(regWhere.attendee.email).toEqual({ equals: "Hadeel\\_Ammar@Example.com", mode: "insensitive" });
  });

  it("nobody on the event has that address, or their record has no title: no title", async () => {
    expect(await loadInviteeTitle(invite)).toBeNull();
    mockDb.speaker.findFirst.mockResolvedValueOnce({ title: null });
    expect(await loadInviteeTitle({ ...invite, speakerId: "sp1" })).toBeNull();
  });
});
