/**
 * Server-side validation for MANUAL email attachments (operator-picked
 * PDF/DOC/DOCX files on a single-send email). Enforces the shared limits from
 * [email-attachment-limits.ts] PLUS magic-byte checks so a spoofed
 * `contentType` can't smuggle a disallowed file past the MIME whitelist.
 *
 * Errors-as-values: returns `{ ok: false, code, error }` for the caller to map
 * to a 400. Never throws.
 */
import {
  MAX_MANUAL_ATTACHMENTS,
  MAX_MANUAL_ATTACHMENTS_TOTAL_BYTES,
  ALLOWED_MANUAL_ATTACHMENT_TYPES,
} from "./email-attachment-limits";

export interface RawManualAttachment {
  name: string;
  content: string; // base64 (no data: prefix)
  contentType: string;
}

export interface ValidatedManualAttachment {
  name: string;
  content: string;
  contentType: string;
}

export type ManualAttachmentValidation =
  | { ok: true; attachments: ValidatedManualAttachment[] }
  | { ok: false; code: string; error: string };

// Magic-byte signatures — defence against a spoofed contentType.
const MAGIC: Record<string, number[]> = {
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d], // "%PDF-"
  "application/msword": [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], // OLE2 (legacy .doc)
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [0x50, 0x4b, 0x03, 0x04], // ZIP (.docx)
};

function hasPrefix(buf: Buffer, magic: number[]): boolean {
  if (buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (buf[i] !== magic[i]) return false;
  return true;
}

/** Strip any path component, cap length, and force the expected extension. */
function sanitizeFilename(name: string, contentType: string): string {
  const base = (name.split(/[\\/]/).pop() || "").trim().slice(0, 200) || "attachment";
  const ext = ALLOWED_MANUAL_ATTACHMENT_TYPES[contentType]?.toLowerCase() ?? "";
  if (ext && !base.toLowerCase().endsWith(`.${ext}`)) return `${base}.${ext}`;
  return base;
}

export function validateManualAttachments(
  raw: RawManualAttachment[] | undefined | null,
): ManualAttachmentValidation {
  if (!raw || raw.length === 0) return { ok: true, attachments: [] };
  if (raw.length > MAX_MANUAL_ATTACHMENTS) {
    return { ok: false, code: "TOO_MANY_FILES", error: `You can attach at most ${MAX_MANUAL_ATTACHMENTS} files.` };
  }

  let totalBytes = 0;
  const out: ValidatedManualAttachment[] = [];

  for (const a of raw) {
    const magic = MAGIC[a.contentType];
    if (!magic) {
      return {
        ok: false,
        code: "UNSUPPORTED_TYPE",
        error: `Unsupported file type for "${a.name}". Only PDF, DOC, and DOCX are allowed.`,
      };
    }

    const buf = Buffer.from(a.content, "base64");
    if (buf.length === 0) {
      return { ok: false, code: "EMPTY_FILE", error: `The attachment "${a.name}" is empty or unreadable.` };
    }

    totalBytes += buf.length;
    if (totalBytes > MAX_MANUAL_ATTACHMENTS_TOTAL_BYTES) {
      return { ok: false, code: "TOO_LARGE", error: "Attachments exceed the 10 MB total limit." };
    }

    if (!hasPrefix(buf, magic)) {
      const label = ALLOWED_MANUAL_ATTACHMENT_TYPES[a.contentType];
      return {
        ok: false,
        code: "CONTENT_MISMATCH",
        error: `The attachment "${a.name}" doesn't look like a valid ${label} file.`,
      };
    }

    out.push({ name: sanitizeFilename(a.name, a.contentType), content: a.content, contentType: a.contentType });
  }

  return { ok: true, attachments: out };
}
