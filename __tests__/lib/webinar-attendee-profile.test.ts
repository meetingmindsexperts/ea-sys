/**
 * Who an attendee is, for the webinar's attendance files (Nov 25, 2026).
 */
import { describe, it, expect } from "vitest";
import { defaultPersonFields, readPersonFields } from "@/lib/person-fields";
import { ATTENDEE_PROFILE_HEADERS, ATTENDEE_PROFILE_SELECT, attendeeProfileCells } from "@/lib/webinar/attendee-profile";

const fields = defaultPersonFields();
const person = { role: "PHYSICIAN", specialty: "Hematology", organization: "SKMC", country: "United Arab Emirates" };

describe("attendeeProfileCells", () => {
  it("four cells in the headers' order, and what to select matches them", () => {
    expect(ATTENDEE_PROFILE_HEADERS).toEqual(["Role", "Specialty", "Organization", "Country"]);
    expect(Object.keys(ATTENDEE_PROFILE_SELECT)).toEqual(["role", "specialty", "customSpecialty", "organization", "country"]);
    expect(attendeeProfileCells(person, fields)).toEqual(["Physician", "Hematology", "SKMC", "United Arab Emirates"]);
  });

  it("Role is shown by the organisation's own label for the stored answer", () => {
    const own = readPersonFields({
      personFields: { role: { label: "Profession", options: [{ key: "PHYSICIAN", label: "Doctor" }], allowOther: false } },
    });
    expect(attendeeProfileCells(person, own)[0]).toBe("Doctor");
  });

  it("an answer that is not on the list is shown as stored, and nothing stored is blank", () => {
    expect(attendeeProfileCells({ role: "ASTRONAUT", specialty: "Space Medicine", organization: null, country: null }, fields)).toEqual([
      "ASTRONAUT",
      "Space Medicine",
      "",
      "",
    ]);
  });

  it("a specialty typed under Others is shown as typed; Others alone, or a typed one beside a listed answer, is not", () => {
    const cell = (specialty: string, customSpecialty: string | null) => attendeeProfileCells({ ...person, specialty, customSpecialty }, fields)[1];
    expect(cell("Others", " Sleep Medicine ")).toBe("Sleep Medicine");
    expect(cell("Others", null)).toBe("Others");
    expect(cell("Others", "  ")).toBe("Others");
    // A leftover typed value from an earlier answer never overrides the listed one.
    expect(cell("Hematology", "Sleep Medicine")).toBe("Hematology");
  });

  it("someone with no registration behind them (a Zoom guest) is four blanks, never a shifted row", () => {
    expect(attendeeProfileCells(null, fields)).toEqual(["", "", "", ""]);
    expect(attendeeProfileCells(undefined, fields)).toEqual(["", "", "", ""]);
  });
});
