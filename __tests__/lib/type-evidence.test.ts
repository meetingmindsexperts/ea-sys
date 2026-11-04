/**
 * What a registration type asks a person to prove (type-evidence.ts, Nov 4,
 * 2026): the rules behind the abstract doors, the ID and document request link
 * and the Registrations list's "Missing ID or document" filter.
 */
import { describe, it, expect } from "vitest";
import {
  asksForEvidence,
  missingEvidenceFields,
  evidenceFieldLabel,
  MISSING_EVIDENCE_WHERE,
} from "@/lib/type-evidence";
import { evidenceRequestIdentifier, parseEvidenceRequestIdentifier } from "@/lib/evidence-request";

const STUDENT = {
  requiresStudentId: true,
  requiresStudentIdExpiry: true,
  requiresDocument: true,
  documentRequired: true,
  documentLabel: "Valid Student ID",
};
const NOTHING = { memberId: null, studentId: null, studentIdExpiry: null, supportingDocumentUrl: null };

describe("missingEvidenceFields", () => {
  it("lists everything a Student type asks for that the row does not hold", () => {
    expect(missingEvidenceFields(STUDENT, NOTHING)).toEqual(["studentId", "studentIdExpiry", "supportingDocument"]);
  });

  it("drops what is already on file", () => {
    expect(
      missingEvidenceFields(STUDENT, { ...NOTHING, studentId: "S1", studentIdExpiry: new Date("2027-06-30") }),
    ).toEqual(["supportingDocument"]);
  });

  it("counts a blank ID as missing", () => {
    expect(missingEvidenceFields(STUDENT, { ...NOTHING, studentId: "  " })).toContain("studentId");
  });

  it("asks for an ask-but-not-block document too: the organiser asked for it", () => {
    expect(missingEvidenceFields({ requiresDocument: true, documentRequired: false }, NOTHING)).toEqual(["supportingDocument"]);
  });

  it("ignores an expiry switch without the ID switch", () => {
    expect(missingEvidenceFields({ requiresStudentIdExpiry: true }, NOTHING)).toEqual([]);
  });

  it("asks nothing of a type with no switches", () => {
    expect(missingEvidenceFields({}, NOTHING)).toEqual([]);
    expect(missingEvidenceFields(null, NOTHING)).toEqual([]);
    expect(asksForEvidence({})).toBe(false);
    expect(asksForEvidence({ requiresMemberId: true })).toBe(true);
  });
});

describe("labels", () => {
  it("uses the organiser's document label", () => {
    expect(evidenceFieldLabel("supportingDocument", STUDENT)).toBe("Valid Student ID");
    expect(evidenceFieldLabel("studentIdExpiry", STUDENT)).toBe("Student ID expiry date");
  });
});

describe("MISSING_EVIDENCE_WHERE", () => {
  /**
   * The list route spreads a sponsor filter that is a top-level OR. This one
   * must sit inside AND, or the two would overwrite each other and the filter
   * would silently widen the result.
   */
  it("has no top-level OR, and never matches a cancelled registration", () => {
    expect(Object.keys(MISSING_EVIDENCE_WHERE)).toEqual(["AND"]);
    expect(JSON.stringify(MISSING_EVIDENCE_WHERE)).toContain('"status":{"not":"CANCELLED"}');
  });
});

describe("the request link's identifier", () => {
  it("round-trips and refuses other token kinds", () => {
    expect(parseEvidenceRequestIdentifier(evidenceRequestIdentifier("reg1"))).toBe("reg1");
    expect(parseEvidenceRequestIdentifier("survey:reg1")).toBeNull();
    expect(parseEvidenceRequestIdentifier("reg:reg1")).toBeNull();
    expect(parseEvidenceRequestIdentifier("evidence:")).toBeNull();
  });
});
