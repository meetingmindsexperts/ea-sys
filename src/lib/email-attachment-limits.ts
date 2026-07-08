/**
 * Shared limits + allowed types for MANUAL email attachments — operator-picked
 * PDF/DOC/DOCX files added to a single-send email (currently the speaker
 * invitation). Client-safe: pure constants + pure helpers, no Node imports, so
 * the picker UI ([email-attachment-picker.tsx]) and the server validator
 * ([email-attachments.ts]) agree on ONE source of truth (no drift).
 */
export const MAX_MANUAL_ATTACHMENTS = 3;
export const MAX_MANUAL_ATTACHMENTS_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MB (decoded)

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
