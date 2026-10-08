/**
 * What a Blueprint upload may be, decided from its first bytes, never from the
 * name or the browser's declared type.
 *
 * Every stored file is served with a sandboxing CSP (see the files route), so
 * an SVG carrying a script cannot run on our origin even when opened directly.
 */

/** nginx's client_max_body_size is the real ceiling (10 MB); the vendor page assumed 20. */
export const MAX_BLUEPRINT_FILE_BYTES = 10 * 1024 * 1024;

export interface SniffedType {
  contentType: string;
  ext: string;
}

const OFFICE: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const startsWith = (buf: Uint8Array, bytes: readonly number[], at = 0) => bytes.every((b, i) => buf[at + i] === b);

/** The file's real type, or null when it is not one the Blueprint accepts. */
export function sniffBlueprintFile(buf: Uint8Array, filename: string): SniffedType | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47])) return { contentType: "image/png", ext: "png" };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { contentType: "image/jpeg", ext: "jpg" };
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return { contentType: "image/gif", ext: "gif" };
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return { contentType: "image/webp", ext: "webp" };
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return { contentType: "application/pdf", ext: "pdf" };
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    // A ZIP is an Office file only if it carries the Office manifest near the
    // start, not because it is named .docx (review L12).
    const ext = filename.toLowerCase().split(".").pop() ?? "";
    const head = new TextDecoder("latin1").decode(buf.slice(0, 4096));
    return OFFICE[ext] && head.includes("[Content_Types].xml") ? { contentType: OFFICE[ext], ext } : null;
  }
  const head = new TextDecoder().decode(buf.slice(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return { contentType: "image/svg+xml", ext: "svg" };
  return null;
}

/** Images open in the page; documents download (Chrome's PDF viewer does not run in a sandboxed response, review L11). */
export function isInlineType(contentType: string): boolean {
  return contentType.startsWith("image/");
}
