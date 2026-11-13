/**
 * Registration.completedAt (docs/ONSITE_DESK_PLAN.md §3.1) and the shared supporting-document rule
 * (§3.3).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { completedAtOnCreate, completionWhereFor, isRegistrationFormCompleted, NOT_COMPLETED_WHERE } from "@/lib/registration-completion";
import { resolveSupportingDocument } from "@/lib/supporting-document";

describe("completedAtOnCreate", () => {
  const now = new Date("2026-10-28T10:00:00Z");
  it("is now for the self-service paths and the speaker companion", () => {
    for (const source of ["PUBLIC_REGISTER", "PUBLIC_SUBMITTER", "PUBLIC_COMPLETION_FORM", "GROUP_REGISTER", "SPEAKER_COMPANION", "FACULTY_ADMIN"] as const) {
      expect(completedAtOnCreate(source, now), source).toEqual(now);
    }
  });
  it("is null for rows an organiser or a tool created with partial details", () => {
    for (const source of ["ADMIN_DASHBOARD", "CSV_IMPORT", "MCP_AGENT", "OTHER"] as const) {
      expect(completedAtOnCreate(source, now), source).toBeNull();
    }
    expect(completedAtOnCreate(null, now)).toBeNull();
    expect(completedAtOnCreate(undefined, now)).toBeNull();
  });
});

describe("completionWhereFor", () => {
  it("pending: not completed and not cancelled, as one AND so it never overwrites a status or OR filter", () => {
    expect(completionWhereFor("pending")).toBe(NOT_COMPLETED_WHERE);
    // An account counts as completed too (review MED: the account sweeps link rows without stamping them).
    // Nor is anyone on the Faculty type pending (owner, Nov 13, 2026); a row with no type still is.
    expect(NOT_COMPLETED_WHERE).toEqual({
      AND: [
        { completedAt: null },
        { userId: null },
        { status: { not: "CANCELLED" } },
        { OR: [{ ticketTypeId: null }, { ticketType: { isFaculty: false } }] },
      ],
    });
    expect(Object.keys({ status: "CONFIRMED", ...completionWhereFor("pending") })).toEqual(["status", "AND"]);
  });
  it("done: completed; anything else filters nothing", () => {
    expect(completionWhereFor("done")).toEqual({
      AND: [{ OR: [{ completedAt: { not: null } }, { userId: { not: null } }, { ticketType: { isFaculty: true } }] }],
    });
    expect(completionWhereFor(null)).toEqual({});
    expect(completionWhereFor("bogus")).toEqual({});
  });
});

describe("isRegistrationFormCompleted: the one rule every reader asks", () => {
  it("is completed by the form, by an account, or by being on the Faculty type", () => {
    expect(isRegistrationFormCompleted({ completedAt: new Date(), userId: null, ticketType: { isFaculty: false } })).toBe(true);
    expect(isRegistrationFormCompleted({ completedAt: null, userId: "u-1", ticketType: { isFaculty: false } })).toBe(true);
    // Staff added them while "Faculty" was an ordinary type (ADMIN_DASHBOARD, nothing stamped):
    // 33 such rows on one production event read "Form not completed" with every detail present.
    expect(isRegistrationFormCompleted({ completedAt: null, userId: null, ticketType: { isFaculty: true } })).toBe(true);
  });
  it("is not completed otherwise: an ordinary type, no type, or a payload without the type", () => {
    expect(isRegistrationFormCompleted({ completedAt: null, userId: null, ticketType: { isFaculty: false } })).toBe(false);
    expect(isRegistrationFormCompleted({ completedAt: null, userId: null, ticketType: null })).toBe(false);
    expect(isRegistrationFormCompleted({ completedAt: null, userId: null })).toBe(false);
    expect(isRegistrationFormCompleted({})).toBe(false);
  });
  it("no reader decides it for itself: each one that reads completedAt to judge a row asks the rule", () => {
    // The files that used to write `completedAt || userId`. One that goes back to it would call a
    // Faculty row incomplete on its own surface while the others call it complete.
    const readers = [
      "src/app/(dashboard)/events/[eventId]/check-in/desk-panel.tsx",
      "src/app/(dashboard)/events/[eventId]/registrations/page.tsx",
      "src/app/(dashboard)/events/[eventId]/registrations/registration-detail-sheet.tsx",
      "src/app/api/events/[eventId]/registrations/[registrationId]/onsite-link/route.ts",
      "src/app/api/events/[eventId]/registrations/completion-status/route.ts",
      "src/app/api/public/events/[slug]/complete-registration/route.ts",
      "src/services/registration-form-service.ts",
    ];
    for (const file of readers) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).toContain("isRegistrationFormCompleted(");
      expect(source, file).not.toMatch(/completedAt\s*\|\|\s*\w+\.userId|userId\s*\|\|\s*\w+\.completedAt|!\w+\.userId\s*&&\s*!\w+\.completedAt/);
    }
  });
});

describe("resolveSupportingDocument (shared by the public and completion forms)", () => {
  const OURS = "/uploads/resident-letters/evt-1/0b1c2d3e-aaaa-bbbb-cccc-123456789abc.pdf";
  const ASKS = { requiresDocument: true, documentRequired: false };
  const REQUIRES = { requiresDocument: true, documentRequired: true };

  it("keeps our own upload for this event, trimming the filename", () => {
    expect(resolveSupportingDocument(ASKS, "evt-1", OURS, "  letter.pdf ")).toEqual({ url: OURS, filename: "letter.pdf", dropped: null, missingRequired: false });
  });
  it("drops another event's file or a crafted path", () => {
    expect(resolveSupportingDocument(ASKS, "evt-2", OURS, "x").dropped).toBe("not-our-upload");
    expect(resolveSupportingDocument(ASKS, "evt-1", "/uploads/resident-letters/evt-1/../../etc/passwd", "x").dropped).toBe("not-our-upload");
  });
  it("drops a document the type does not ask for", () => {
    expect(resolveSupportingDocument({ requiresDocument: false }, "evt-1", OURS, "x")).toMatchObject({ url: null, dropped: "type-does-not-ask" });
  });
  it("is missing only when the type both asks and requires", () => {
    expect(resolveSupportingDocument(REQUIRES, "evt-1", undefined, undefined).missingRequired).toBe(true);
    expect(resolveSupportingDocument(REQUIRES, "evt-2", OURS, "x").missingRequired).toBe(true);
    expect(resolveSupportingDocument(ASKS, "evt-1", undefined, undefined).missingRequired).toBe(false);
    expect(resolveSupportingDocument(null, "evt-1", undefined, undefined)).toEqual({ url: null, filename: null, dropped: null, missingRequired: false });
  });
});
