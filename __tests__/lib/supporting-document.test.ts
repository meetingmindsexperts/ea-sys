/**
 * Per-registration-type supporting document — the rules that decide behaviour.
 *
 * Two things are pinned here and they are different in kind:
 *
 *  1. The POLICY helpers — the truth table for "does this type ask?" and "does
 *     a missing answer block?", plus parity with what the Aug 13 migration
 *     backfills. Note what is NOT here: see the note above
 *     `isSupportingDocumentPath` about why "a rename must not change
 *     behaviour" cannot be asserted at this layer.
 *
 *  2. The PATH validator, which is a security boundary rather than tidiness.
 *     `Registration.supportingDocumentUrl` is written from a PUBLIC,
 *     unauthenticated form field, and the staff download route later resolves
 *     that value against the filesystem. A stored `../../` is an
 *     arbitrary-file-read primitive.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_DOCUMENT_LABEL,
  isSupportingDocumentPath,
  requiresSupportingDocument,
  supportingDocumentBlocks,
  supportingDocumentInstructions,
  supportingDocumentLabel,
} from "@/lib/supporting-document";

/** What the Aug 13 migration backfills onto every previously-matching type. */
const BACKFILLED_RESIDENT = {
  requiresDocument: true,
  documentRequired: false,
  documentLabel: "Official Letter",
  documentInstructions:
    "Please upload an official letter from your current institution confirming your status as a Resident or Trainee.\n" +
    "The letter must be in English, printed on official letterhead, and signed and stamped by the relevant authority.",
};

describe("requiresSupportingDocument", () => {
  it("asks only when the organizer ticked the box", () => {
    expect(requiresSupportingDocument({ requiresDocument: true })).toBe(true);
    expect(requiresSupportingDocument({ requiresDocument: false })).toBe(false);
  });

  it("treats a missing or half-configured type as not asking", () => {
    // Typeless registrations are a real state (admin imports), and a row that
    // predates the columns reads them as undefined.
    expect(requiresSupportingDocument(null)).toBe(false);
    expect(requiresSupportingDocument(undefined)).toBe(false);
    expect(requiresSupportingDocument({})).toBe(false);
    expect(requiresSupportingDocument({ requiresDocument: null })).toBe(false);
  });

  it("only a literal true enables it", () => {
    // A truthy-but-not-true value is corrupt data, not consent.
    expect(requiresSupportingDocument({ requiresDocument: 1 as unknown as boolean })).toBe(false);
    expect(requiresSupportingDocument({ requiresDocument: "yes" as unknown as boolean })).toBe(false);
  });
});

describe("supportingDocumentBlocks", () => {
  it("blocks only when the organizer chose Required", () => {
    expect(supportingDocumentBlocks({ requiresDocument: true, documentRequired: true })).toBe(true);
  });

  it("collects without blocking when the organizer chose Optional", () => {
    // The two-boolean split exists for exactly this state. If they were one
    // tri-state enum, "ask but do not block" would be unrepresentable — and it
    // is the DEFAULT, because someone filling the form at 11pm without the
    // document to hand should still be able to register.
    expect(requiresSupportingDocument({ requiresDocument: true, documentRequired: false })).toBe(true);
    expect(supportingDocumentBlocks({ requiresDocument: true, documentRequired: false })).toBe(false);
  });

  it("never blocks a type that is not asking, even if the flag is stale", () => {
    // A leftover documentRequired on a type whose box was later unticked must
    // not refuse registrations for a field the form no longer renders.
    expect(supportingDocumentBlocks({ requiresDocument: false, documentRequired: true })).toBe(false);
  });

  it("fails OPEN on anything half-configured", () => {
    // Deliberately the opposite polarity to group registration, which fails
    // closed. Wrongly requiring costs a lost registration; wrongly not
    // requiring costs an email chasing a document.
    expect(supportingDocumentBlocks(null)).toBe(false);
    expect(supportingDocumentBlocks({})).toBe(false);
    expect(supportingDocumentBlocks({ requiresDocument: true })).toBe(false);
  });
});

describe("labels and instructions", () => {
  it("uses the organizer's words", () => {
    expect(supportingDocumentLabel({ documentLabel: "Membership Card" })).toBe("Membership Card");
    expect(supportingDocumentInstructions({ documentInstructions: "Bring the card." })).toBe(
      "Bring the card.",
    );
  });

  it("falls back to a neutral label rather than a blank heading", () => {
    expect(supportingDocumentLabel({})).toBe(DEFAULT_DOCUMENT_LABEL);
    expect(supportingDocumentLabel({ documentLabel: null })).toBe(DEFAULT_DOCUMENT_LABEL);
    expect(supportingDocumentLabel({ documentLabel: "   " })).toBe(DEFAULT_DOCUMENT_LABEL);
    expect(supportingDocumentLabel(null)).toBe(DEFAULT_DOCUMENT_LABEL);
  });

  it("returns null for absent instructions so the caller renders nothing", () => {
    // An empty amber callout is worse than no callout.
    expect(supportingDocumentInstructions({})).toBeNull();
    expect(supportingDocumentInstructions({ documentInstructions: "" })).toBeNull();
    expect(supportingDocumentInstructions({ documentInstructions: "  \n " })).toBeNull();
    expect(supportingDocumentInstructions(null)).toBeNull();
  });
});

describe("backfill parity — a Resident type behaves as it did before Aug 13", () => {
  // The migration must be a no-op from the registrant's point of view. These
  // assert against the copy that ACTUALLY shipped, not a paraphrase, because a
  // paraphrase would pass while the live form said something different.
  it("still asks, still optional by default", () => {
    expect(requiresSupportingDocument(BACKFILLED_RESIDENT)).toBe(true);
    expect(supportingDocumentBlocks(BACKFILLED_RESIDENT)).toBe(false);
  });

  it("still shows the same heading and the same two sentences", () => {
    expect(supportingDocumentLabel(BACKFILLED_RESIDENT)).toBe("Official Letter");
    const text = supportingDocumentInstructions(BACKFILLED_RESIDENT);
    expect(text).toContain(
      "Please upload an official letter from your current institution confirming your status as a Resident or Trainee.",
    );
    expect(text).toContain(
      "The letter must be in English, printed on official letterhead, and signed and stamped by the relevant authority.",
    );
  });

  it("an event that had the old switch ON keeps blocking", () => {
    // Backfill 2 copies Event.settings.residentLetter.required onto the type.
    expect(supportingDocumentBlocks({ ...BACKFILLED_RESIDENT, documentRequired: true })).toBe(true);
  });
});

// NOTE — "a rename must not change behaviour" is NOT assertable in this file,
// and three tests here used to pretend otherwise. `requiresSupportingDocument`
// takes a policy object and has no name parameter, so every "rename" case was
// really a fourth restatement of "true returns true". A test that cannot fail
// is worse than no test, because the commit message cited those three as the
// load-bearing ones.
//
// The property IS assertable one layer up, where a name exists: a ticket type
// literally called "Resident" with the box unticked must not block. That lives
// in __tests__/api/supporting-document-gate.test.ts against the real public
// register route.

describe("isSupportingDocumentPath", () => {
  const valid = "/uploads/resident-letters/cmev123abc/3f8b21ca-9d44-4e11-8a20-1f0b7c6d5e33.pdf";

  it("accepts what our own upload route produces", () => {
    // The prefix stays `resident-letters` after the generalisation, on
    // purpose: moving it would mean both validators accepting two prefixes for
    // the lifetime of the existing rows, and the prune job sweeping two
    // directories, for a path no organizer ever sees.
    expect(isSupportingDocumentPath(valid)).toBe(true);
    expect(isSupportingDocumentPath(valid.replace(".pdf", ".jpg"))).toBe(true);
    expect(isSupportingDocumentPath(valid.replace(".pdf", ".png"))).toBe(true);
  });

  it("rejects path traversal", () => {
    expect(isSupportingDocumentPath("/uploads/resident-letters/../../../etc/passwd")).toBe(false);
    expect(isSupportingDocumentPath("/uploads/resident-letters/evt/../../.env")).toBe(false);
    expect(isSupportingDocumentPath("../../.env")).toBe(false);
  });

  it("rejects a NUL byte", () => {
    // Truncates the path in some filesystem layers — a classic way to smuggle
    // one extension past a check and read another file.
    expect(isSupportingDocumentPath(`${valid}\0.txt`)).toBe(false);
  });

  it("rejects a path pointing at any OTHER private upload directory", () => {
    // The whole point: the download route resolves this value, so a stored
    // path into speaker-docs or reimbursements would read a passport scan.
    expect(isSupportingDocumentPath("/uploads/speaker-docs/evt/abc.pdf")).toBe(false);
    expect(isSupportingDocumentPath("/uploads/reimbursements/evt/abc.pdf")).toBe(false);
    expect(isSupportingDocumentPath("/uploads/photos/2026/04/abc.png")).toBe(false);
  });

  it("rejects a prefix that merely LOOKS like ours", () => {
    // The same dot-anchoring lesson as hostname suffix matching: a bare
    // startsWith on the directory name is not containment.
    expect(isSupportingDocumentPath("/uploads/resident-letters-evil/evt/abc.pdf")).toBe(false);
  });

  it("rejects an absolute or remote URL", () => {
    expect(isSupportingDocumentPath("https://evil.example/x.pdf")).toBe(false);
    expect(isSupportingDocumentPath("file:///etc/passwd")).toBe(false);
    expect(isSupportingDocumentPath("//evil.example/x.pdf")).toBe(false);
  });

  it("rejects an extension we never store", () => {
    // The upload route derives the extension from verified magic bytes, so a
    // .svg / .html here did not come from us — and both are XSS vectors when
    // served inline.
    expect(isSupportingDocumentPath("/uploads/resident-letters/evt/abc.svg")).toBe(false);
    expect(isSupportingDocumentPath("/uploads/resident-letters/evt/abc.html")).toBe(false);
    expect(isSupportingDocumentPath("/uploads/resident-letters/evt/abc")).toBe(false);
  });

  it("rejects extra nesting below the event directory", () => {
    expect(isSupportingDocumentPath("/uploads/resident-letters/evt/sub/abc.pdf")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isSupportingDocumentPath("")).toBe(false);
  });
});
