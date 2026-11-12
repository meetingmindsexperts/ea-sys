/**
 * displayRegistrationType: how a registration's type is NAMED on every surface
 * (the Registrations list and sheet, the speaker page, the exports, the shared
 * views, and through speakerApiRegistrationType the speakers API).
 *
 * Owner, Nov 12, 2026: "short faculty everywhere" and "they should not
 * diverge". A Faculty registration is the plain word "Faculty". Until that day
 * it showed the attendee's recorded profession, so one person read "Physician"
 * on the speaker page and "Faculty" on the registration sheet, and the API
 * said something else again. The profession is the Role column's.
 */
import { describe, it, expect } from "vitest";
import { SPEAKERS_TYPE_LABEL, displayRegistrationType, isFacultyLookalikeName } from "@/lib/faculty-filter";

describe("displayRegistrationType", () => {
  it("a delegate: the type's own name", () => {
    expect(displayRegistrationType({ ticketTypeName: "Physician", isFaculty: false, attendeeRegistrationType: "Physician" })).toBe("Physician");
    expect(displayRegistrationType({ ticketTypeName: "Nurse", isFaculty: false })).toBe("Nurse");
  });

  it("a Faculty registration: Faculty, whatever profession the attendee carries", () => {
    for (const profession of ["Nurse", "Physician", "Faculty", "faculty", "", null, undefined]) {
      expect(displayRegistrationType({ ticketTypeName: "Faculty", isFaculty: true, attendeeRegistrationType: profession })).toBe("Faculty");
    }
  });

  it("a Faculty registration: Faculty, whatever the type row is called", () => {
    // Production held "Faculty" 33 times and "Faculty." once; the word shown is one.
    for (const name of ["Faculty.", "Faculty (speakers)", "Speakers", "  ", null]) {
      expect(displayRegistrationType({ ticketTypeName: name, isFaculty: true })).toBe("Faculty");
    }
    expect(displayRegistrationType({ ticketTypeName: "Faculty.", isFaculty: true }, "")).toBe("Faculty");
  });

  it("the picker uses the same word", () => {
    expect(SPEAKERS_TYPE_LABEL).toBe("Faculty");
    expect(SPEAKERS_TYPE_LABEL).toBe(displayRegistrationType({ ticketTypeName: "anything", isFaculty: true }));
  });

  it("honours a custom empty label for a delegate with no type (e.g. '' for CSV cells)", () => {
    expect(displayRegistrationType({ ticketTypeName: null, isFaculty: false, attendeeRegistrationType: null }, "")).toBe("");
  });

  it("a delegate with no type falls back to the empty label, never to the attendee's text", () => {
    expect(displayRegistrationType({ ticketTypeName: null, isFaculty: false, attendeeRegistrationType: "Physician" })).toBe("—");
  });
});

// With the bracket gone from the picker's label, an ORDINARY type called
// "Faculty" would sit beside the real choice under the same word.
describe("isFacultyLookalikeName", () => {
  it("is the Faculty word itself, in any case and with spaces around it", () => {
    expect(["Faculty", "faculty", " FACULTY "].map(isFacultyLookalikeName)).toEqual([true, true, true]);
  });

  it("is nothing else", () => {
    expect(["Faculty.", "Invited Faculty", "Speaker", "Physician", "", null, undefined].map(isFacultyLookalikeName)).toEqual(Array(7).fill(false));
  });
});
