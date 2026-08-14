/**
 * Who may download a registration's supporting document.
 *
 * This boundary matches NO existing role set, which is the point — it is a
 * predicate of its own rather than a borrowed allow-list. The tests below pin
 * the disagreements explicitly, because the failure mode here is somebody
 * later noticing it "looks like" the desk list and folding them together.
 */
import { describe, it, expect } from "vitest";
import { canViewSupportingDocument } from "@/lib/supporting-document-visibility";
import { canViewEntryBarcode } from "@/lib/barcode-visibility";
import { canViewFinance } from "@/lib/finance-visibility";

describe("canViewSupportingDocument", () => {
  it("admits the roles that make the entitlement judgement", () => {
    // Verifying that a Resident letter justifies a discounted rate is a
    // back-office decision, not a door task.
    for (const role of ["SUPER_ADMIN", "ADMIN", "ORGANIZER"]) {
      expect(canViewSupportingDocument(role), role).toBe(true);
    }
  });

  it("refuses ONSITE — temp staff, contractors and vendors", () => {
    // The Aug 12 guard admitted them on a "desk staff verify the letter at the
    // desk" rationale that does not survive contact with what the desk does.
    // Since Aug 13 an organizer can name the requested document anything,
    // including "Passport copy", so the content class is defined at runtime.
    expect(canViewSupportingDocument("ONSITE")).toBe(false);
  });

  it("refuses MEMBER — internal, but org-wide in reach", () => {
    // More trusted people than ONSITE, wider blast radius: MEMBER sees every
    // event in the org where ONSITE is assignment-gated. Neither dimension
    // dominates, so neither earns the grant.
    expect(canViewSupportingDocument("MEMBER")).toBe(false);
  });

  it("refuses WEBINARS and every restricted role", () => {
    for (const role of ["WEBINARS", "CRM_USER", "REVIEWER", "SUBMITTER", "REGISTRANT"]) {
      expect(canViewSupportingDocument(role), role).toBe(false);
    }
  });

  it("fails closed on an absent or unknown role", () => {
    expect(canViewSupportingDocument(null)).toBe(false);
    expect(canViewSupportingDocument(undefined)).toBe(false);
    expect(canViewSupportingDocument("")).toBe(false);
    expect(canViewSupportingDocument("SOME_FUTURE_ROLE")).toBe(false);
  });
});

describe("it deliberately disagrees with its neighbours", () => {
  // If a future edit makes any of these agree, the predicates have been folded
  // together and one of the three boundaries has silently moved.
  it("is NARROWER than the barcode boundary (which needs ONSITE for badges)", () => {
    expect(canViewEntryBarcode("ONSITE")).toBe(true);
    expect(canViewSupportingDocument("ONSITE")).toBe(false);
  });

  it("is NARROWER than the finance boundary (which needs MEMBER + ONSITE)", () => {
    expect(canViewFinance("MEMBER")).toBe(true);
    expect(canViewFinance("ONSITE")).toBe(true);
    expect(canViewSupportingDocument("MEMBER")).toBe(false);
    expect(canViewSupportingDocument("ONSITE")).toBe(false);
  });

  it("has no API-key escape hatch, unlike the barcode boundary", () => {
    // canViewEntryBarcode(role, isApiKey) returns true for a key. This one
    // takes no such argument at all, so a key in an n8n workflow cannot pull
    // passport scans. Adding it later must be a decision, not an inheritance.
    expect(canViewEntryBarcode(null, true)).toBe(true);
    expect(canViewSupportingDocument.length).toBe(1);
  });
});
