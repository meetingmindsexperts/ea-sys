/**
 * Operator-picked email attachments, server side.
 *
 * Since Sep 8, 2026 a send body carries REFERENCES to files already uploaded
 * to storage (POST /api/events/[eventId]/email-attachments), never the bytes.
 * Why: the bytes used to ride inline as base64 in a JSON body that the
 * middleware caps at 1 MB, so the picker advertised "10 MB" and anything past
 * ~750 KB was a bare 413 before the route ran. With the file in storage the
 * body is a few hundred bytes, the upload takes the multipart ceiling on its
 * own, and a queued send stores a path rather than a blob.
 *
 * Two guards live here and nowhere else:
 *   - {@link checkAttachmentBytes}: type allow-list + per-file size + magic
 *     bytes (a spoofed contentType must not smuggle another file type).
 *     Used by the upload route on the way in AND by the resolver on the way
 *     out, so a file swapped in storage is still refused at send time.
 *   - {@link resolveStoredAttachments}: the reference must sit under THIS
 *     event's prefix (a path from another event's upload is refused before
 *     any read), then the bytes are read through the storage layer's own
 *     prefix guard and re-checked.
 */
import { readStoredFile } from "./storage";
import { UPLOAD_PREFIX } from "./upload-prefixes";
import {
  ALLOWED_MANUAL_ATTACHMENT_TYPES,
  MAX_MANUAL_ATTACHMENTS,
  MAX_MANUAL_ATTACHMENT_BYTES,
  MAX_MANUAL_ATTACHMENT_MB,
  type StoredAttachmentRef,
} from "./email-attachment-limits";
import { apiLogger } from "./logger";

export interface ResolvedAttachment {
  name: string;
  content: string; // base64, the shape sendEmail takes
  contentType: string;
}

export type AttachmentCheck = { ok: true } | { ok: false; code: string; error: string };

export type StoredAttachmentResolution =
  | { ok: true; attachments: ResolvedAttachment[] }
  | { ok: false; code: string; error: string };

// Magic-byte signatures: defence against a spoofed contentType.
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

/** Display name only: strip any path, cap the length, force the extension. */
export function sanitizeAttachmentFilename(name: string, contentType: string): string {
  const base = (name.split(/[\\/]/).pop() || "").trim().slice(0, 200) || "attachment";
  const ext = ALLOWED_MANUAL_ATTACHMENT_TYPES[contentType]?.toLowerCase() ?? "";
  if (ext && !base.toLowerCase().endsWith(`.${ext}`)) return `${base}.${ext}`;
  return base;
}

/** Storage extension for an allowed type ("pdf" / "doc" / "docx"). */
export function attachmentExtension(contentType: string): string | null {
  const label = ALLOWED_MANUAL_ATTACHMENT_TYPES[contentType];
  return label ? label.toLowerCase() : null;
}

/** `/uploads/email-attachments/{eventId}/`: every reference must sit under it. */
export function emailAttachmentPathPrefix(eventId: string): string {
  return `${UPLOAD_PREFIX.emailAttachments}${eventId}/`;
}

export function checkAttachmentBytes(buf: Buffer, contentType: string, name: string): AttachmentCheck {
  const magic = MAGIC[contentType];
  if (!magic) {
    return {
      ok: false,
      code: "UNSUPPORTED_TYPE",
      error: `Unsupported file type for "${name}". Only PDF, DOC, and DOCX are allowed.`,
    };
  }
  if (buf.length === 0) {
    return { ok: false, code: "EMPTY_FILE", error: `The attachment "${name}" is empty or unreadable.` };
  }
  if (buf.length > MAX_MANUAL_ATTACHMENT_BYTES) {
    return {
      ok: false,
      code: "TOO_LARGE",
      error: `The attachment "${name}" is over the ${MAX_MANUAL_ATTACHMENT_MB} MB per-file limit.`,
    };
  }
  if (!hasPrefix(buf, magic)) {
    const label = ALLOWED_MANUAL_ATTACHMENT_TYPES[contentType];
    return {
      ok: false,
      code: "CONTENT_MISMATCH",
      error: `The attachment "${name}" doesn't look like a valid ${label} file.`,
    };
  }
  return { ok: true };
}

/**
 * Turn the references a send body carries into the bytes sendEmail needs.
 * Errors as values; every refusal names the file so the operator can act.
 */
export async function resolveStoredAttachments(
  refs: StoredAttachmentRef[] | undefined | null,
  eventId: string,
): Promise<StoredAttachmentResolution> {
  if (!refs || refs.length === 0) return { ok: true, attachments: [] };
  if (refs.length > MAX_MANUAL_ATTACHMENTS) {
    return { ok: false, code: "TOO_MANY_FILES", error: `You can attach at most ${MAX_MANUAL_ATTACHMENTS} files.` };
  }

  const prefix = emailAttachmentPathPrefix(eventId);
  const out: ResolvedAttachment[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    // Event binding first, before any read: a reference minted under another
    // event (or a hand-built path) is refused by shape, not by lookup.
    if (!ref.storedPath.startsWith(prefix) || ref.storedPath.includes("..")) {
      apiLogger.warn({ msg: "email-attachments:path-outside-event", eventId, storedPath: ref.storedPath });
      return { ok: false, code: "INVALID_ATTACHMENT", error: `The attachment "${ref.name}" is not valid for this event. Please re-add it.` };
    }
    if (seen.has(ref.storedPath)) continue; // the same file twice is one attachment
    seen.add(ref.storedPath);

    let buf: Buffer;
    try {
      buf = await readStoredFile(ref.storedPath, UPLOAD_PREFIX.emailAttachments);
    } catch (err) {
      apiLogger.warn({
        msg: "email-attachments:read-failed",
        eventId,
        storedPath: ref.storedPath,
        reason: (err as { reason?: string })?.reason ?? null,
        err,
      });
      return {
        ok: false,
        code: "ATTACHMENT_MISSING",
        error: `The attachment "${ref.name}" is no longer available. Please re-add it.`,
      };
    }

    const check = checkAttachmentBytes(buf, ref.contentType, ref.name);
    if (!check.ok) {
      apiLogger.warn({ msg: "email-attachments:bytes-rejected", eventId, storedPath: ref.storedPath, code: check.code });
      return check;
    }

    out.push({
      name: sanitizeAttachmentFilename(ref.name, ref.contentType),
      content: buf.toString("base64"),
      contentType: ref.contentType,
    });
  }
  return { ok: true, attachments: out };
}
