/**
 * The public/private upload boundary.
 *
 * This is a small file guarding a large mistake. Until Aug 19, 2026 the public
 * `/uploads` catch-all carried a DENY-list of five named private prefixes,
 * which fails open: any private prefix added afterwards was world-readable
 * until someone remembered to edit that one file, and no test would fail,
 * because a test asserting the OLD prefixes are refused stays green while a
 * NEW one is wide open.
 *
 * Inverted to an allow-list, the same mistake fails closed. These tests pin
 * that inversion, and in particular pin the membership of the public set, so
 * moving a private prefix onto it is a deliberate act with a failing test
 * rather than a one-line edit nobody notices.
 */
import { describe, it, expect } from "vitest";
import {
  UPLOAD_SEGMENT,
  UPLOAD_PREFIX,
  PUBLIC_UPLOAD_SEGMENTS,
  isPublicUploadSegment,
  uploadPrefix,
} from "@/lib/upload-prefixes";

describe("the private set", () => {
  // Named individually rather than looped, so adding one of these to the
  // public list produces a failure that names the file type that leaked.
  const PRIVATE = [
    ["speaker documents (passports, CVs)", UPLOAD_SEGMENT.speakerDocs],
    ["reimbursements (passports, bank details)", UPLOAD_SEGMENT.reimbursements],
    ["supporting documents (employer letters)", UPLOAD_SEGMENT.supportingDocuments],
    ["CRM deal documents (contracts, priced quotes)", UPLOAD_SEGMENT.crmDealDocs],
    ["CRM inbound email attachments", UPLOAD_SEGMENT.crmEmailAttachments],
  ] as const;

  it.each(PRIVATE)("%s is NOT publicly servable", (_label, segment) => {
    expect(isPublicUploadSegment(segment)).toBe(false);
    expect(PUBLIC_UPLOAD_SEGMENTS).not.toContain(segment);
  });
});

describe("the public set", () => {
  it("is exactly the five segments the old deny-list permitted", () => {
    // Pinned as a set, not a subset: the allow-list flip must be behaviour
    // preserving, so this catches both a prefix that stopped being served
    // (broken images) and one that started being served (a leak).
    expect([...PUBLIC_UPLOAD_SEGMENTS].sort()).toEqual(
      ["agreements", "certificates", "media", "photos", "stripe-receipts"].sort(),
    );
  });

  it("serves certificates, because that is how they are delivered", () => {
    // A recipient clicks a link in an email and is signed in to nothing. Their
    // protection is an unguessable path, not an access check. Moving this off
    // the list breaks every certificate link already sent.
    expect(isPublicUploadSegment(UPLOAD_SEGMENT.certificates)).toBe(true);
  });

  it("refuses an unknown segment", () => {
    // The fail-closed property itself: a prefix nobody classified is private.
    expect(isPublicUploadSegment("some-future-prefix")).toBe(false);
    expect(isPublicUploadSegment("")).toBe(false);
  });

  it("refuses a segment that merely starts with a public one", () => {
    expect(isPublicUploadSegment("photos-evil")).toBe(false);
    expect(isPublicUploadSegment("certificates2")).toBe(false);
  });
});

describe("prefix construction", () => {
  it("always ends with a slash", () => {
    // Load-bearing, not cosmetic: readStoredFile refuses a prefix without one,
    // because "/uploads/photos" would string-match "/uploads/photos-evil/x".
    for (const prefix of Object.values(UPLOAD_PREFIX)) {
      expect(prefix.startsWith("/uploads/")).toBe(true);
      expect(prefix.endsWith("/")).toBe(true);
    }
  });

  it("keeps the supporting-document segment as resident-letters", () => {
    // The feature was generalised away from "resident letter" on Aug 13, 2026
    // but the segment is a KEY, not a label. Renaming it would orphan every
    // path already stored in the database.
    expect(UPLOAD_SEGMENT.supportingDocuments).toBe("resident-letters");
    expect(uploadPrefix(UPLOAD_SEGMENT.supportingDocuments)).toBe("/uploads/resident-letters/");
  });
});
