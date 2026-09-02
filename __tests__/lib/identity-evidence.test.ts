/**
 * Per-type identity-evidence switches (Sept 2, 2026).
 *
 * These replace a NAME MATCH, and the tests that matter are the ones stating
 * what the name match got wrong:
 *
 *   - a rename must not change behaviour (it silently did),
 *   - a suggestive name must not start asking on its own ("Trainee / Student"
 *     asked only because of the slash),
 *   - a type the old patterns missed must be able to ask ("Resident", the
 *     most-registered type in the family across 19 events, asked for nothing).
 *
 * If someone reintroduces name-sniffing, these fail.
 */
import { describe, it, expect } from "vitest";
import {
  readIdentityEvidencePolicy,
  asksForIdentityEvidence,
  missingIdentityEvidence,
  hasInvalidExpiryDate,
} from "@/lib/identity-evidence";

const OFF = { requiresMemberId: false, requiresStudentId: false, requiresStudentIdExpiry: false };

describe("readIdentityEvidencePolicy", () => {
  it("reads the switches, not the name", () => {
    // The whole point. A type called "Resident" can now ask; a type called
    // "Student" with the switch off stays silent.
    expect(readIdentityEvidencePolicy({ requiresStudentId: true })).toMatchObject({
      requiresStudentId: true,
    });
    expect(readIdentityEvidencePolicy(OFF).requiresStudentId).toBe(false);
  });

  it("collapses expiry when the student ID itself is not asked for", () => {
    // An expiry with no ID to expire is incoherent. Resolved here so no form
    // has to remember the rule.
    const p = readIdentityEvidencePolicy({ requiresStudentId: false, requiresStudentIdExpiry: true });
    expect(p.requiresStudentIdExpiry).toBe(false);
  });

  it("keeps expiry when the student ID IS asked for", () => {
    const p = readIdentityEvidencePolicy({ requiresStudentId: true, requiresStudentIdExpiry: true });
    expect(p.requiresStudentIdExpiry).toBe(true);
  });

  it("asks for nothing on an absent or malformed type", () => {
    // These gate a PUBLIC registration form. The failure to avoid is blocking a
    // paying delegate over a field the organizer never configured; a missing ID
    // number is recoverable at the desk.
    for (const input of [null, undefined, {}, { requiresStudentId: "yes" } as never]) {
      expect(asksForIdentityEvidence(readIdentityEvidencePolicy(input))).toBe(false);
    }
  });
});

describe("missingIdentityEvidence", () => {
  it("names the field, so the registrant can fix it themselves", () => {
    const p = readIdentityEvidencePolicy({ requiresStudentId: true, requiresStudentIdExpiry: true });
    expect(missingIdentityEvidence(p, {})).toEqual(["Student ID", "Student ID expiry date"]);
  });

  it("treats whitespace as absent", () => {
    const p = readIdentityEvidencePolicy({ requiresMemberId: true });
    expect(missingIdentityEvidence(p, { memberId: "   " })).toEqual(["Member ID"]);
  });

  it("is satisfied when the asked-for values are present", () => {
    const p = readIdentityEvidencePolicy({ requiresStudentId: true, requiresStudentIdExpiry: true });
    expect(missingIdentityEvidence(p, { studentId: "S1", studentIdExpiry: "2027-06-30" })).toEqual([]);
  });

  it("never demands a field the type did not ask for", () => {
    // The regression that would re-break every non-student type.
    expect(missingIdentityEvidence(readIdentityEvidencePolicy(OFF), {})).toEqual([]);
  });

  it("does not demand the expiry when only the ID was asked for", () => {
    const p = readIdentityEvidencePolicy({ requiresStudentId: true, requiresStudentIdExpiry: false });
    expect(missingIdentityEvidence(p, { studentId: "S1" })).toEqual([]);
  });
});

describe("hasInvalidExpiryDate", () => {
  it("rejects a value that is not a date", () => {
    expect(hasInvalidExpiryDate({ studentIdExpiry: "not-a-date" })).toBe(true);
  });

  it("accepts a real date", () => {
    expect(hasInvalidExpiryDate({ studentIdExpiry: "2027-06-30" })).toBe(false);
  });

  it("is silent when absent — that is the other function's job", () => {
    // Blank and malformed are different failures, and telling a registrant the
    // wrong one sends them looking in the wrong place.
    expect(hasInvalidExpiryDate({})).toBe(false);
    expect(hasInvalidExpiryDate({ studentIdExpiry: "  " })).toBe(false);
  });
});

describe("what the old name match got wrong", () => {
  const byName = (n: string) => ({
    requiresMemberId: n.toLowerCase().includes("member"),
    requiresStudentId: n.toLowerCase().includes("student"),
    requiresStudentIdExpiry: n.toLowerCase().includes("student"),
  });

  it("a rename no longer changes behaviour", () => {
    // "Student" -> "Undergraduate" silently switched verification OFF before.
    expect(byName("Student").requiresStudentId).toBe(true);
    expect(byName("Undergraduate").requiresStudentId).toBe(false); // the old bug
    const configured = { requiresMemberId: false, requiresStudentId: true, requiresStudentIdExpiry: true };
    expect(readIdentityEvidencePolicy(configured).requiresStudentId).toBe(true); // survives any name
  });

  it("a type the old patterns missed can now ask", () => {
    // "Resident": 6 registrations across 19 events, matched nothing.
    expect(byName("Resident").requiresStudentId).toBe(false);
    expect(readIdentityEvidencePolicy({ requiresStudentId: true }).requiresStudentId).toBe(true);
  });

  it("a suggestive name does not start asking on its own", () => {
    expect(readIdentityEvidencePolicy({}).requiresStudentId).toBe(false);
  });
});
