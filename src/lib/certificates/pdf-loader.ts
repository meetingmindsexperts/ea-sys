import { apiLogger } from "@/lib/logger";
import { readStoredFile, StorageError } from "@/lib/storage";
import { UPLOAD_PREFIX } from "@/lib/upload-prefixes";

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

/**
 * WRITE-side validator for `CertificateTemplate.backgroundPdfUrl` — the same
 * constraint the READ-side loader below enforces, applied at persist time so a
 * bad value can never be stored in the first place. Used by the REST template
 * POST/PATCH routes and the MCP create/update tools.
 *
 * Every URL the system itself generates satisfies this (uploadCertificatePdf
 * writes `/uploads/certificates/{eventId}/…` locally, or a Supabase https URL),
 * so tightening rejects only attacker-shaped input:
 *   - local  → must start with /uploads/certificates/ and contain no `..`
 *              segment or NUL (readFile does not percent-decode, so encoded
 *              dots are literal filename chars, not traversal)
 *   - remote → https + hostname on the Supabase allowlist
 */
export function validateBackgroundPdfUrl(
  url: string,
): { ok: true } | { ok: false; reason: string } {
  if (url.length === 0 || url.length > 500) {
    return { ok: false, reason: "must be 1-500 characters" };
  }
  if (url.includes("\0")) {
    return { ok: false, reason: "contains a NUL byte" };
  }
  if (url.startsWith("/")) {
    if (!url.startsWith("/uploads/certificates/")) {
      return { ok: false, reason: "local path must be under /uploads/certificates/" };
    }
    if (url.split("/").some((seg) => seg === "..")) {
      return { ok: false, reason: "path traversal segment (..) not allowed" };
    }
    return { ok: true };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "not a valid absolute URL or /uploads/certificates/ path" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "remote URL must use https" };
  }
  if (!REMOTE_PDF_HOST_ALLOWLIST.some((re) => re.test(parsed.hostname))) {
    return { ok: false, reason: `remote host not allowed: ${parsed.hostname}` };
  }
  return { ok: true };
}

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
    // The traversal + prefix guards this function has carried since the June
    // 2026 BLOCKER fix now live in readStoredFile, which enforces the same two
    // rules: the stored path must sit under /uploads/certificates/, and the
    // symlink-resolved path must still be inside that root. The trailing
    // separator that stops /uploads/certificates-evil/ sharing the prefix is
    // part of the prefix contract there and is covered by its own test.
    try {
      return await readStoredFile(pdfUrl, UPLOAD_PREFIX.certificates);
    } catch (err) {
      if (err instanceof StorageError && err.reason !== "not-found") {
        apiLogger.warn({ msg: "cert-pdf:path-traversal", pdfUrl, reason: err.reason, ...logCtx });
        throw new Error(`PDF path escapes allowed prefix: ${pdfUrl}`);
      }
      throw err;
    }
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

  // 15s ceiling — a hung storage fetch must not stall a worker tick forever.
  const res = await fetch(pdfUrl, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    apiLogger.warn({ msg: "cert-pdf:fetch-failed", pdfUrl, status: res.status, ...logCtx });
    throw new Error(`Failed to fetch PDF: HTTP ${res.status} ${pdfUrl}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}
