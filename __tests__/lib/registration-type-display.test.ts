/**
 * displayRegistrationType — the registration type shown in the registrations
 * list / detail / CSV. A faculty companion sits on the hidden "Faculty" ticket
 * type, so the raw ticket-type name reads "Faculty" (a badge/role, not a
 * profession). This helper shows the person's profession when one is recorded,
 * and the speakers' type's own name when not (owner, Oct 22, 2026; it used to
 * show a dash), so each organisation's wording shows through.
 */
import { describe, it, expect } from "vitest";
import { displayRegistrationType } from "@/lib/faculty-filter";

describe("displayRegistrationType", () => {
  it("delegate: shows the ticket-type name (which IS the professional category)", () => {
    expect(displayRegistrationType({ ticketTypeName: "Physician", isFaculty: false, attendeeRegistrationType: "Physician" })).toBe("Physician");
  });

  it("faculty with a recorded profession: shows the profession, not 'Faculty'", () => {
    expect(displayRegistrationType({ ticketTypeName: "Faculty", isFaculty: true, attendeeRegistrationType: "Nurse" })).toBe("Nurse");
  });

  it("faculty whose attendee type is literally 'Faculty': shows 'Faculty'", () => {
    expect(displayRegistrationType({ ticketTypeName: "Faculty", isFaculty: true, attendeeRegistrationType: "Faculty" })).toBe("Faculty");
  });

  it("faculty with no recorded profession: shows the type's own name, even with a custom empty label", () => {
    expect(displayRegistrationType({ ticketTypeName: "Faculty", isFaculty: true, attendeeRegistrationType: null })).toBe("Faculty");
    expect(displayRegistrationType({ ticketTypeName: "Faculty (speakers)", isFaculty: true, attendeeRegistrationType: "" }, "")).toBe("Faculty (speakers)");
  });

  it("follows an organisation's renamed speakers' type, treating a stored 'Faculty' as no profession", () => {
    expect(displayRegistrationType({ ticketTypeName: "Speakers", isFaculty: true, attendeeRegistrationType: "Faculty" })).toBe("Speakers");
    expect(displayRegistrationType({ ticketTypeName: "Speakers", isFaculty: true, attendeeRegistrationType: "speakers" })).toBe("Speakers");
    expect(displayRegistrationType({ ticketTypeName: "Speakers", isFaculty: true, attendeeRegistrationType: "Nurse" })).toBe("Nurse");
  });

  it("falls back to 'Faculty' only when the type has no name", () => {
    expect(displayRegistrationType({ ticketTypeName: null, isFaculty: true, attendeeRegistrationType: null })).toBe("Faculty");
    expect(displayRegistrationType({ ticketTypeName: "  ", isFaculty: true, attendeeRegistrationType: null })).toBe("Faculty");
  });

  it("honours a custom empty label for a delegate with no type (e.g. '' for CSV cells)", () => {
    expect(displayRegistrationType({ ticketTypeName: null, isFaculty: false, attendeeRegistrationType: null }, "")).toBe("");
  });

  it("delegate with a null ticket type: falls back to the empty label", () => {
    expect(displayRegistrationType({ ticketTypeName: null, isFaculty: false, attendeeRegistrationType: "Physician" })).toBe("—");
  });
});
