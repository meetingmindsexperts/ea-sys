/**
 * "Registration Type" on a speaker (owner report, Nov 12, 2026, 4th GCC
 * Hematology Hub). Three speakers imported as Physician at 150 had the
 * speaker's own dropdown set to "Faculty"; the registration stayed Physician
 * and Unpaid, because that dropdown wrote a label on the speaker and nothing
 * else. A speaker with a live registration now shows the registration's type.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { NO_TYPE_LABEL, speakerRegistrationTypeName, speakerRegistrationTypeView } from "@/lib/speaker-registration-type";
import { displayRegistrationType } from "@/lib/faculty-filter";

const PHYSICIAN = { name: "Physician", isFaculty: false };
const FACULTY = { name: "Faculty", isFaculty: true };

describe("speakerRegistrationTypeView", () => {
  it("shows the registration's type, not the speaker's own text, when the two disagree", () => {
    // Dr. Malallah, registration 043: the speaker said Faculty, the registration is Physician.
    const view = speakerRegistrationTypeView("Faculty", { serialId: 43, status: "PENDING", paymentStatus: "UNPAID", ticketType: PHYSICIAN });
    expect(view).toMatchObject({ kind: "registration", typeName: "Physician", isFaculty: false, serial: "043" });
  });

  it("says what a delegate type means for a speaker, with where the registration stands", () => {
    const view = speakerRegistrationTypeView("Faculty", { serialId: 43, status: "PENDING", paymentStatus: "UNPAID", ticketType: PHYSICIAN });
    if (view.kind !== "registration") throw new Error("expected a registration view");
    expect(view.note).toContain("counts as a delegate");
    expect(view.note).toContain("does not change this registration");
    expect(view.note).toContain("It is Pending, Unpaid now.");
  });

  it("has nothing to add for a registration on a Faculty type", () => {
    const view = speakerRegistrationTypeView("Physician", { serialId: 7, status: "CONFIRMED", paymentStatus: "COMPLIMENTARY", ticketType: FACULTY });
    expect(view).toEqual({ kind: "registration", typeName: "Faculty", isFaculty: true, facultyTypeName: null, serial: "007", note: null });
  });

  // Review of 4da1db66: the Registrations page names a Faculty registration by
  // the person's recorded profession. Printing the type's own name here put
  // the two pages out of step the other way round.
  it("names a Faculty registration the way the Registrations page does", () => {
    const reg = (profession: string | null) => ({ serialId: 7, status: "CONFIRMED", paymentStatus: "COMPLIMENTARY", ticketType: FACULTY, attendee: { registrationType: profession } });
    for (const profession of ["Physician", "Nurse", "Faculty", "faculty", "", null]) {
      const view = speakerRegistrationTypeView("whatever the speaker says", reg(profession));
      const onRegistrations = displayRegistrationType({ ticketTypeName: "Faculty", isFaculty: true, attendeeRegistrationType: profession });
      expect(view.typeName).toBe(onRegistrations);
    }
    expect(speakerRegistrationTypeView(null, reg("Physician"))).toMatchObject({ typeName: "Physician", isFaculty: true, facultyTypeName: "Faculty", note: null });
    expect(speakerRegistrationTypeView(null, reg("Faculty"))).toMatchObject({ typeName: "Faculty", facultyTypeName: null });
  });

  it("never reads a profession into a delegate type's name", () => {
    const view = speakerRegistrationTypeView(null, { status: "PENDING", paymentStatus: "UNPAID", ticketType: PHYSICIAN, attendee: { registrationType: "Faculty" } });
    expect(view).toMatchObject({ typeName: "Physician", isFaculty: false, facultyTypeName: null });
  });

  it("names a registration that has no type yet, and says where to give it one", () => {
    const view = speakerRegistrationTypeView("Faculty", { serialId: null, status: "PENDING", paymentStatus: "UNASSIGNED", ticketType: null });
    expect(view).toMatchObject({ kind: "registration", typeName: NO_TYPE_LABEL, isFaculty: false, serial: null });
    if (view.kind !== "registration") throw new Error("expected a registration view");
    expect(view.note).toContain("no type yet");
  });

  it("falls back to the speaker's own text only while there is no live registration", () => {
    expect(speakerRegistrationTypeView("Physician", null)).toEqual({ kind: "own", typeName: "Physician" });
    expect(speakerRegistrationTypeView("  ", undefined)).toEqual({ kind: "own", typeName: null });
    // A cancelled registration is not one the speaker stands on.
    expect(speakerRegistrationTypeView("Physician", { serialId: 9, status: "CANCELLED", paymentStatus: "UNPAID", ticketType: FACULTY })).toEqual({
      kind: "own",
      typeName: "Physician",
    });
  });

  it("gives the export the same answer in one line", () => {
    expect(speakerRegistrationTypeName("Faculty", { status: "PENDING", ticketType: PHYSICIAN })).toBe("Physician");
    expect(speakerRegistrationTypeName("Faculty", { status: "PENDING", ticketType: null })).toBe(NO_TYPE_LABEL);
    expect(speakerRegistrationTypeName("Faculty", null)).toBe("Faculty");
    expect(speakerRegistrationTypeName(null, null)).toBeNull();
  });
});

describe("the speaker screens and the export use the rule", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  // The dropdown wrote a label that looked like the registration's type. It
  // may come back only through the shared field, which hides it for a speaker
  // who has a live registration.
  it.each([
    "src/components/speakers/speaker-detail-sheet.tsx",
    "src/app/(dashboard)/events/[eventId]/speakers/[speakerId]/page.tsx",
  ])("%s shows the type through the shared field and row, never its own dropdown", (file) => {
    const src = read(file);
    expect(src).toContain("<SpeakerRegistrationTypeField");
    expect(src).toContain("<SpeakerRegistrationTypeRow");
    expect(src).not.toContain("RegistrationTypeSelect");
    // The speaker's own text is handed to the row, never printed directly.
    expect(src).not.toMatch(/>\s*\{speaker\.registrationType\}\s*</);
  });

  // Owner, Nov 12, 2026: Add Speaker showed "Faculty" in a dropdown of type
  // names while Add Registration showed "Faculty (speakers and committee)".
  // A new speaker's registration is a Faculty one whatever was picked, so the
  // form states it in the same words and offers nothing to pick.
  it("Add Speaker states the Faculty type in Add Registration's words, with no dropdown", () => {
    const src = read("src/app/(dashboard)/events/[eventId]/speakers/new/page.tsx");
    expect(src).toContain("{SPEAKERS_TYPE_LABEL}");
    expect(src).not.toContain("RegistrationTypeSelect");
    expect(read("src/app/(dashboard)/events/[eventId]/registrations/new/page.tsx")).toContain("{SPEAKERS_TYPE_LABEL}");
  });

  it("the speakers export prints the registration's type", () => {
    const src = read("src/lib/event-export/sheets.ts");
    expect(src).toContain("speakerRegistrationTypeName(s.registrationType, s.sourceRegistration)");
  });

  it("the speaker API hands the page the profession the Registrations page shows", () => {
    const src = read("src/app/api/events/[eventId]/speakers/[speakerId]/route.ts");
    expect(src).toMatch(/attendee: \{ select: \{ email: true, registrationType: true \} \}/);
  });
});
