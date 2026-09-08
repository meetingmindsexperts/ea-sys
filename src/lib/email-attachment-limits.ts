/**
 * Shared limits + allowed types for MANUAL email attachments — operator-picked
 * PDF/DOC/DOCX files added to a single-send email (currently the speaker
 * invitation). Client-safe: pure constants + pure helpers, no Node imports, so
 * the picker UI ([email-attachment-picker.tsx]) and the server validator
 * ([email-attachments.ts]) agree on ONE source of truth (no drift).
 */
export const MAX_MANUAL_ATTACHMENTS = 3;
/**
 * Per FILE (owner, Sep 8, 2026: "increase the limits to 5mb"). Three files is
 * 15 MB decoded, about 20 MB as MIME, under SESv2's 40 MB raw ceiling. The
 * old "10 MB total" was never reachable: files rode inline as base64 in a JSON
 * body the middleware caps at 1 MB, so anything past ~750 KB was a bare 413.
 */
export const MAX_MANUAL_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_MANUAL_ATTACHMENT_MB = 5;

/**
 * What a send body carries since Sep 8, 2026: a REFERENCE to a file the
 * operator already uploaded to storage (S3 on prod) via
 * POST /api/events/[eventId]/email-attachments, never the bytes. The send
 * routes read the bytes back at send time (src/lib/email-attachments.ts).
 */
export interface StoredAttachmentRef {
  storedPath: string;
  name: string;
  contentType: string;
}

/** contentType → user-facing extension label (also defines display order). */
export const ALLOWED_MANUAL_ATTACHMENT_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
};

export const ALLOWED_MANUAL_ATTACHMENT_MIME = Object.keys(ALLOWED_MANUAL_ATTACHMENT_TYPES);

/** `<input accept>` value covering both extensions and MIME types. */
export const MANUAL_ATTACHMENT_ACCEPT =
  ".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/**
 * Resolve the MIME type to send for a picked file. Some OSes report an empty
 * `File.type` for .doc/.docx, so fall back to the extension. Returns null when
 * the file isn't an allowed PDF/DOC/DOCX. Used by BOTH the picker's validation
 * and the send handlers' payload build so the two never disagree.
 */
export function resolveAttachmentMime(file: { name: string; type?: string }): string | null {
  if (file.type && ALLOWED_MANUAL_ATTACHMENT_MIME.includes(file.type)) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return (ext && EXT_TO_MIME[ext]) || null;
}
