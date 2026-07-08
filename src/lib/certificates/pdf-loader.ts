import { apiLogger } from "@/lib/logger";

/**
 * Load a certificate PDF's bytes from local disk OR a remote URL — the SINGLE
 * source of truth for the cert issue worker + the resend route (they used to
 * carry two copies, and the worker's copy had NO path-traversal / SSRF guard
 * while the resend copy did — a live security gap this consolidation closes).
 *
 * Defense-in-depth: `pdfUrl` is system-generated today (uploadCertificatePdf
 * writes `public/uploads/certificates/…`), but the column is read from multiple
 * places and the surface is permanent, so:
 *   - local path  → resolve() + assert the prefix is public/uploads/certificates/
 *   - remote URL  → must be https + hostname on the allowlist
 * Anything else throws (the caller maps it to a failure / PDF_MISSING). Every
 * rejection logs a distinct `cert-pdf:*` key so an operator can see WHY.
 */

const REMOTE_PDF_HOST_ALLOWLIST = [/\.supabase\.co$/i];

export interface PdfLoadLogContext {
  eventId?: string;
  certificateId?: string;
  userId?: string;
  runId?: string;
}

export async function loadCertificatePdfBytes(
  pdfUrl: string,
  logCtx: PdfLoadLogContext = {},
): Promise<Buffer> {
  if (pdfUrl.startsWith("/uploads/")) {
    const { readFile } = await import("fs/promises");
    const { join, resolve, sep } = await import("path");
    // Allowed prefix = public/uploads/certificates/ (every cert PDF lives there
    // per uploadCertificatePdf's storage convention). Trailing separator so
    // `/public/uploads/certificates-evil/` can't share the prefix.
    const allowedPrefix = resolve(process.cwd(), "public", "uploads", "certificates") + sep;
    const absPath = resolve(join(process.cwd(), "public", pdfUrl));
    if (!absPath.startsWith(allowedPrefix)) {
      apiLogger.warn({ msg: "cert-pdf:path-traversal", pdfUrl, absPath, allowedPrefix, ...logCtx });
      throw new Error(`PDF path escapes allowed prefix: ${pdfUrl}`);
    }
    return readFile(absPath);
  }

  // Remote — must be https + on the host allowlist.
  let url: URL;
  try {
    url = new URL(pdfUrl);
  } catch {
    apiLogger.warn({ msg: "cert-pdf:invalid-url", pdfUrl, ...logCtx });
    throw new Error(`Invalid pdfUrl (not a valid URL): ${pdfUrl}`);
  }
  if (url.protocol !== "https:") {
    apiLogger.warn({ msg: "cert-pdf:non-https", pdfUrl, protocol: url.protocol, ...logCtx });
    throw new Error(`Remote pdfUrl must use https: ${pdfUrl}`);
  }
  if (!REMOTE_PDF_HOST_ALLOWLIST.some((re) => re.test(url.hostname))) {
    apiLogger.warn({ msg: "cert-pdf:host-disallowed", pdfUrl, hostname: url.hostname, ...logCtx });
    throw new Error(`Remote pdfUrl host not on allowlist: ${url.hostname}`);
  }

  const res = await fetch(pdfUrl);
  if (!res.ok) {
    apiLogger.warn({ msg: "cert-pdf:fetch-failed", pdfUrl, status: res.status, ...logCtx });
    throw new Error(`Failed to fetch PDF: HTTP ${res.status} ${pdfUrl}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}
