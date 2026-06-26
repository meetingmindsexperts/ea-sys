/**
 * displayRegistrationType — the registration type shown in the registrations
 * list / detail / CSV. A faculty companion sits on the hidden "Faculty" ticket
 * type, so the raw ticket-type name reads "Faculty" (a badge/role, not a
 * profession). This helper shows the person's profession instead, never the
 * literal "Faculty".
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

  it("faculty whose attendee type is still literally 'Faculty': shows '—', never 'Faculty'", () => {
    expect(displayRegistrationType({ ticketTypeName: "Faculty", isFaculty: true, attendeeRegistrationType: "Faculty" })).toBe("—");
  });

  it("faculty with no recorded profession: shows '—'", () => {
    expect(displayRegistrationType({ ticketTypeName: "Faculty", isFaculty: true, attendeeRegistrationType: null })).toBe("—");
  });

  it("honours a custom empty label (e.g. '' for CSV cells)", () => {
    expect(displayRegistrationType({ ticketTypeName: "Faculty", isFaculty: true, attendeeRegistrationType: null }, "")).toBe("");
    expect(displayRegistrationType({ ticketTypeName: null, isFaculty: false, attendeeRegistrationType: null }, "")).toBe("");
  });

  it("delegate with a null ticket type: falls back to the empty label", () => {
    expect(displayRegistrationType({ ticketTypeName: null, isFaculty: false, attendeeRegistrationType: "Physician" })).toBe("—");
  });
});
