/**
 * The quote document's shape rules, pure: what bytes count as a quote file
 * (the declared type is the sender's word; the bytes are the fact) and a
 * filename safe to echo in a header.
 */
export const QUOTE_FILE_MAX_BYTES = 10 * 1024 * 1024;

export type QuoteFileKind = { mime: "application/pdf" | "image/png" | "image/jpeg"; ext: "pdf" | "png" | "jpg" };

export function sniffQuoteFile(buf: Buffer): QuoteFileKind | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  return null;
}

/** The last path segment, restricted to plain characters, never empty: it goes into a Content-Disposition header. */
export function safeQuoteFileName(name: string | null | undefined): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  return base.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "quote";
}
