/**
 * What a file IS, from its first bytes (Nov 6, 2026). A declared content type
 * and a filename are both supplied by whoever sends the file, so neither
 * proves anything; the signature does.
 *
 * One table for the document and image types the app sends or stores. Today
 * the CRM's sponsor-email attachments use it; the older per-feature tables
 * (email-attachments.ts, supporting-document-upload.ts, speaker-agreement.ts)
 * are candidates to move onto it, one at a time, each with its own tests.
 *
 * Pure, server or client.
 */

interface Signature {
  /** Byte patterns at `offset` (default 0); any one matching is enough. */
  magic: { offset?: number; bytes: number[] }[];
  /** Filename extensions that may carry this type. */
  extensions: string[];
}

const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP = [0x50, 0x4b, 0x03, 0x04];

export const FILE_SIGNATURES: Record<string, Signature> = {
  "application/pdf": { magic: [{ bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }], extensions: ["pdf"] },
  "application/msword": { magic: [{ bytes: OLE2 }], extensions: ["doc"] },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { magic: [{ bytes: ZIP }], extensions: ["docx"] },
  "application/vnd.ms-powerpoint": { magic: [{ bytes: OLE2 }], extensions: ["ppt"] },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": { magic: [{ bytes: ZIP }], extensions: ["pptx"] },
  "image/png": { magic: [{ bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }], extensions: ["png"] },
  "image/jpeg": { magic: [{ bytes: [0xff, 0xd8, 0xff] }], extensions: ["jpg", "jpeg"] },
  "image/gif": { magic: [{ bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, { bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }], extensions: ["gif"] },
  // RIFF....WEBP
  "image/webp": { magic: [{ bytes: [0x52, 0x49, 0x46, 0x46] }], extensions: ["webp"] },
};

function matchesAt(buf: Uint8Array, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

/** True when the bytes carry the signature of `mimeType` (false for a type not in the table). */
export function signatureMatches(buf: Uint8Array, mimeType: string): boolean {
  const sig = FILE_SIGNATURES[mimeType];
  if (!sig) return false;
  // The PDF spec lets "%PDF-" sit anywhere in the first 1,024 bytes (some
  // generators write a byte-order mark or junk first).
  if (mimeType === "application/pdf") {
    const window = buf.subarray(0, 1024 + 5);
    for (let i = 0; i + 5 <= window.length; i++) if (matchesAt(window, sig.magic[0]!.bytes, i)) return true;
    return false;
  }
  if (!sig.magic.some((m) => matchesAt(buf, m.bytes, m.offset))) return false;
  // WebP shares RIFF with WAV and AVI: the format name sits at byte 8.
  if (mimeType === "image/webp") return matchesAt(buf, [0x57, 0x45, 0x42, 0x50], 8);
  return true;
}

/** The lowercased extension of a filename, or "" when it has none. */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** The type a filename's extension names, among the known ones; null when unknown or ambiguous. */
export function typeFromExtension(name: string): string | null {
  const ext = fileExtension(name);
  if (!ext) return null;
  const hits = Object.entries(FILE_SIGNATURES).filter(([, s]) => s.extensions.includes(ext)).map(([t]) => t);
  return hits.length === 1 ? hits[0]! : null;
}

/** Does the filename's extension belong to this type? */
export function extensionMatches(name: string, mimeType: string): boolean {
  return FILE_SIGNATURES[mimeType]?.extensions.includes(fileExtension(name)) ?? false;
}
