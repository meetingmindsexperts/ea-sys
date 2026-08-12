/**
 * Resident/trainee official letter — the three rules that decide behaviour.
 *
 * The path validator is the load-bearing one. `Registration.residentLetterUrl`
 * is written from a PUBLIC, unauthenticated form field, and the staff download
 * route later resolves that value against the filesystem. A stored `../../` is
 * therefore an arbitrary-file-read primitive, so the traversal cases below are
 * a security boundary, not tidiness.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_RESIDENT_LETTER_SETTINGS,
  isResidentLetterPath,
  readResidentLetterSettings,
  requiresResidentLetter,
} from "@/lib/resident-letter";

describe("requiresResidentLetter", () => {
  it("matches the resident/trainee rates that exist on prod today", () => {
    // Every one of these is a real TicketType.name in production.
    expect(requiresResidentLetter("Resident")).toBe(true);
    expect(requiresResidentLetter("Student/Resident")).toBe(true);
    expect(requiresResidentLetter("Trainee / Student")).toBe(true);
  });

  it("is case-insensitive and tolerates decoration in the name", () => {
    // An organizer naming a type "Resident (In-Training)" should not have to
    // know this rule exists.
    expect(requiresResidentLetter("resident")).toBe(true);
    expect(requiresResidentLetter("RESIDENT")).toBe(true);
    expect(requiresResidentLetter("Resident (In-Training)")).toBe(true);
    expect(requiresResidentLetter("Junior Trainee Rate")).toBe(true);
  });

  it("leaves every other rate alone", () => {
    expect(requiresResidentLetter("Physician")).toBe(false);
    expect(requiresResidentLetter("Student")).toBe(false);
    expect(requiresResidentLetter("Allied Health")).toBe(false);
    expect(requiresResidentLetter("Faculty")).toBe(false);
    expect(requiresResidentLetter("Nurse")).toBe(false);
  });

  it("treats a missing ticket type as not requiring one", () => {
    // Typeless registrations are a real state (admin imports), and they are
    // claiming no discounted rate.
    expect(requiresResidentLetter(null)).toBe(false);
    expect(requiresResidentLetter(undefined)).toBe(false);
    expect(requiresResidentLetter("")).toBe(false);
  });
});

describe("readResidentLetterSettings", () => {
  it("reads an explicit organizer opt-in", () => {
    expect(readResidentLetterSettings({ residentLetter: { required: true } })).toEqual({
      required: true,
    });
  });

  it("defaults to NOT required, so an untouched event is unchanged", () => {
    expect(readResidentLetterSettings({ residentLetter: { required: false } })).toEqual({
      required: false,
    });
    expect(readResidentLetterSettings({})).toEqual(DEFAULT_RESIDENT_LETTER_SETTINGS);
    expect(readResidentLetterSettings({ other: "keys" })).toEqual(DEFAULT_RESIDENT_LETTER_SETTINGS);
  });

  it("fails OPEN on a corrupt blob", () => {
    // Deliberately the opposite polarity to group registration, which fails
    // closed. Wrongly requiring costs a lost registration; wrongly not
    // requiring costs an email chasing a letter.
    expect(readResidentLetterSettings(null)).toEqual({ required: false });
    expect(readResidentLetterSettings(undefined)).toEqual({ required: false });
    expect(readResidentLetterSettings("nonsense")).toEqual({ required: false });
    expect(readResidentLetterSettings({ residentLetter: "nonsense" })).toEqual({ required: false });
    expect(readResidentLetterSettings({ residentLetter: null })).toEqual({ required: false });
  });

  it("only a literal true enables it", () => {
    // A truthy-but-not-true value ("yes", 1) is corrupt data, not consent.
    expect(readResidentLetterSettings({ residentLetter: { required: "yes" } })).toEqual({
      required: false,
    });
    expect(readResidentLetterSettings({ residentLetter: { required: 1 } })).toEqual({
      required: false,
    });
  });
});

describe("isResidentLetterPath", () => {
  const valid = "/uploads/resident-letters/cmev123abc/3f8b21ca-9d44-4e11-8a20-1f0b7c6d5e33.pdf";

  it("accepts what our own upload route produces", () => {
    expect(isResidentLetterPath(valid)).toBe(true);
    expect(isResidentLetterPath(valid.replace(".pdf", ".jpg"))).toBe(true);
    expect(isResidentLetterPath(valid.replace(".pdf", ".png"))).toBe(true);
  });

  it("rejects path traversal", () => {
    expect(isResidentLetterPath("/uploads/resident-letters/../../../etc/passwd")).toBe(false);
    expect(isResidentLetterPath("/uploads/resident-letters/evt/../../.env")).toBe(false);
    expect(isResidentLetterPath("../../.env")).toBe(false);
  });

  it("rejects a NUL byte", () => {
    // Truncates the path in some filesystem layers — a classic way to smuggle
    // one extension past a check and read another file.
    expect(isResidentLetterPath(`${valid}\0.txt`)).toBe(false);
  });

  it("rejects a path pointing at any OTHER private upload directory", () => {
    // The whole point: the download route resolves this value, so a stored
    // path into speaker-docs or reimbursements would read a passport scan.
    expect(isResidentLetterPath("/uploads/speaker-docs/evt/abc.pdf")).toBe(false);
    expect(isResidentLetterPath("/uploads/reimbursements/evt/abc.pdf")).toBe(false);
    expect(isResidentLetterPath("/uploads/photos/2026/04/abc.png")).toBe(false);
  });

  it("rejects a prefix that merely LOOKS like ours", () => {
    // The same dot-anchoring lesson as hostname suffix matching: a bare
    // startsWith on the directory name is not containment.
    expect(isResidentLetterPath("/uploads/resident-letters-evil/evt/abc.pdf")).toBe(false);
  });

  it("rejects an absolute or remote URL", () => {
    expect(isResidentLetterPath("https://evil.example/x.pdf")).toBe(false);
    expect(isResidentLetterPath("file:///etc/passwd")).toBe(false);
    expect(isResidentLetterPath("//evil.example/x.pdf")).toBe(false);
  });

  it("rejects an extension we never store", () => {
    // The upload route derives the extension from verified magic bytes, so a
    // .svg / .html here did not come from us — and both are XSS vectors when
    // served inline.
    expect(isResidentLetterPath("/uploads/resident-letters/evt/abc.svg")).toBe(false);
    expect(isResidentLetterPath("/uploads/resident-letters/evt/abc.html")).toBe(false);
    expect(isResidentLetterPath("/uploads/resident-letters/evt/abc")).toBe(false);
  });

  it("rejects extra nesting below the event directory", () => {
    expect(isResidentLetterPath("/uploads/resident-letters/evt/sub/abc.pdf")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isResidentLetterPath("")).toBe(false);
  });
});
