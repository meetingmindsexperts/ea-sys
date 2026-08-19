/**
 * Every uploads prefix, in one place.
 *
 * A leaf module by design: it imports nothing, so `storage.ts`, the public
 * `/uploads` catch-all, and every route that reads or writes a file can all
 * depend on it without a cycle.
 *
 * Before this, `/uploads/speaker-docs/` appeared as a string literal in four
 * files, `/uploads/crm-deal-docs/` in four, `"uploads", "agreements"` in five,
 * and so on. That duplication is not cosmetic: the writer, the authenticated
 * reader, and the public catch-all each had to agree, and the catch-all's own
 * comments already record the failure mode of them drifting apart.
 *
 * ## The public/private split is the security boundary
 *
 * {@link PUBLIC_UPLOAD_SEGMENTS} is an ALLOW-list. Anything absent from it is
 * private and must never be served by the public catch-all. That direction is
 * deliberate: the catch-all used to carry a deny-list of five named private
 * prefixes, which fails open. Add a sixth private prefix, forget to edit that
 * one file, and it is world-readable with no test failing. An allow-list makes
 * the same mistake fail closed instead.
 *
 * ## "Public" here means one specific thing
 *
 * It means "the catch-all will serve this to an unauthenticated request that
 * knows the URL". It does NOT mean the content is non-sensitive, and it is a
 * different axis from where the bytes are stored.
 *
 * Certificates and Stripe receipts are on the public list because that is how
 * they are delivered: the recipient gets a link by email and is not signed in
 * to anything. Their protection is an unguessable path, not an access check.
 * Moving them off this list would break every link already sent.
 *
 * So a file can be public here and still be stored in an encrypted,
 * non-world-listable bucket. The two questions are independent, and conflating
 * them is how someone eventually breaks certificate delivery while trying to
 * improve privacy.
 */

/** Directory name beneath `public/uploads/`. */
export const UPLOAD_SEGMENT = {
  // Public: served by the /uploads catch-all.
  photos: "photos",
  media: "media",
  agreements: "agreements",
  certificates: "certificates",
  stripeReceipts: "stripe-receipts",

  // Private: refused by the catch-all, streamed only through an authenticated
  // route that binds the file to a row the caller is allowed to see.
  speakerDocs: "speaker-docs",
  reimbursements: "reimbursements",
  crmDealDocs: "crm-deal-docs",
  crmEmailAttachments: "crm-email-attachments",
  /**
   * Supporting documents for a registration type that requires one.
   *
   * The segment is still `resident-letters` because it is a KEY, not a label.
   * The feature was generalised away from "resident letter" on Aug 13, 2026 but
   * the storage prefix deliberately did not follow: renaming it would orphan
   * every path already in the database. Do not "tidy" this.
   */
  supportingDocuments: "resident-letters",
} as const;

export type UploadSegment = (typeof UPLOAD_SEGMENT)[keyof typeof UPLOAD_SEGMENT];

/** `/uploads/{segment}/` — the form `readStoredFile` and friends expect. */
export function uploadPrefix(segment: UploadSegment): string {
  return `/uploads/${segment}/`;
}

export const UPLOAD_PREFIX = {
  photos: uploadPrefix(UPLOAD_SEGMENT.photos),
  media: uploadPrefix(UPLOAD_SEGMENT.media),
  agreements: uploadPrefix(UPLOAD_SEGMENT.agreements),
  certificates: uploadPrefix(UPLOAD_SEGMENT.certificates),
  stripeReceipts: uploadPrefix(UPLOAD_SEGMENT.stripeReceipts),
  speakerDocs: uploadPrefix(UPLOAD_SEGMENT.speakerDocs),
  reimbursements: uploadPrefix(UPLOAD_SEGMENT.reimbursements),
  crmDealDocs: uploadPrefix(UPLOAD_SEGMENT.crmDealDocs),
  crmEmailAttachments: uploadPrefix(UPLOAD_SEGMENT.crmEmailAttachments),
  supportingDocuments: uploadPrefix(UPLOAD_SEGMENT.supportingDocuments),
} as const;

/**
 * The ONLY segments the public `/uploads/[...path]` route may serve.
 *
 * Adding a segment here publishes it to the open internet. Everything not
 * listed is refused, so a new private prefix is safe by default.
 */
export const PUBLIC_UPLOAD_SEGMENTS: readonly string[] = [
  UPLOAD_SEGMENT.photos,
  UPLOAD_SEGMENT.media,
  UPLOAD_SEGMENT.agreements,
  UPLOAD_SEGMENT.certificates,
  UPLOAD_SEGMENT.stripeReceipts,
];

export function isPublicUploadSegment(segment: string): boolean {
  return PUBLIC_UPLOAD_SEGMENTS.includes(segment);
}
