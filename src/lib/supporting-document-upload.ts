import { randomUUID } from "crypto";
import { uploadFile } from "@/lib/storage";
import { UPLOAD_SEGMENT } from "@/lib/upload-prefixes";
import { SUPPORTING_DOCUMENT_MAX_SIZE } from "@/lib/supporting-document";

/**
 * Validate and store one supporting document for an event: PDF / JPG / PNG
 * only, MAGIC-BYTE checked (a declared Content-Type is caller-supplied and
 * means nothing), 5MB, stored under a uuid name in the event's folder, which
 * the public /uploads catch-all blocks.
 *
 * Shared by the public registration form's upload and the onsite desk's
 * (docs/ONSITE_DESK_PLAN.md §4); each route keeps its own gate, rate limit
 * and logging. Server-only.
 */

const ALLOWED: Record<string, { ext: string; magic: number[][] }> = {
  "application/pdf": { ext: "pdf", magic: [[0x25, 0x50, 0x44, 0x46, 0x2d]] }, // %PDF-
  "image/jpeg": { ext: "jpg", magic: [[0xff, 0xd8, 0xff]] },
  "image/png": { ext: "png", magic: [[0x89, 0x50, 0x4e, 0x47]] },
};

function magicMatches(buf: Buffer, magics: number[][]): boolean {
  return magics.some((magic) => buf.length >= magic.length && magic.every((b, i) => buf[i] === b));
}

export type StoreSupportingDocumentResult =
  | { ok: true; url: string; filename: string; size: number; mimeType: string }
  | { ok: false; code: "NO_FILE" | "INVALID_MIME" | "TOO_LARGE" | "INVALID_MAGIC_BYTES"; error: string; claimedType?: string; size?: number };

export async function storeSupportingDocument(file: File | null, eventId: string): Promise<StoreSupportingDocumentResult> {
  if (!file) return { ok: false, code: "NO_FILE", error: "No file provided" };

  const allowed = ALLOWED[file.type];
  if (!allowed) {
    return { ok: false, code: "INVALID_MIME", error: "Only PDF, JPG and PNG files are accepted", claimedType: file.type };
  }
  if (file.size > SUPPORTING_DOCUMENT_MAX_SIZE) {
    return { ok: false, code: "TOO_LARGE", error: "File must be under 5MB", size: file.size };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!magicMatches(buffer, allowed.magic)) {
    // The declared type and the actual bytes disagree — either a renamed file
    // or a deliberate attempt to store something else under a safe extension.
    return { ok: false, code: "INVALID_MAGIC_BYTES", error: "File content does not match its declared type", claimedType: file.type };
  }

  // The stored name is a uuid, never the uploader's: their filename is
  // caller-controlled and would otherwise reach the filesystem.
  const url = await uploadFile(
    buffer,
    `${randomUUID()}.${allowed.ext}`,
    file.type,
    `${UPLOAD_SEGMENT.supportingDocuments}/${eventId}`,
  );
  return { ok: true, url, filename: file.name.slice(0, 255), size: file.size, mimeType: file.type };
}
