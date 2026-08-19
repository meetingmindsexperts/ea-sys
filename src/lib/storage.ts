/**
 * Storage abstraction for EVERY uploaded file.
 *
 * Providers, selected via STORAGE_PROVIDER (defaults to "local"):
 *   - "local"    — writes to /public/uploads/... (EC2/Docker)
 *   - "supabase" — uploads to a Supabase Storage bucket (Vercel / serverless)
 *
 * ## The four primitives
 *
 *   uploadFile(buffer, filename, mimeType, subdirectory) -> storedPath
 *   readStoredFile(storedPath, requirePrefix)            -> Buffer
 *   deleteStoredFile(storedPath, requirePrefix)          -> void, never throws
 *
 * A "stored path" is always `/uploads/{subdirectory}/{filename}` and is what
 * gets persisted in the database. It is a logical identifier, not a filesystem
 * path: changing provider changes where those bytes actually live without
 * touching a single stored value.
 *
 * ## Why everything must go through here
 *
 * Until Phase 1 (Aug 2026) this module covered photos, media, certificate PDFs
 * and Stripe receipts only. Nine document routes wrote to disk directly and a
 * dozen read sites carried their own copy of the traversal guard — and those
 * were precisely the sensitive ones: passports, CVs, bank details, employer
 * letters. A storage change would have had to be applied correctly in twenty
 * places, where missing one leaves sensitive files behind while the change is
 * reported as done. New file handling belongs here, not in a route.
 *
 * See docs/UAE_DOCUMENT_RESIDENCY_PLAN.md.
 *
 * Supabase setup (unchanged):
 *   1. Create a bucket (name matches SUPABASE_STORAGE_BUCKET, default "photos")
 *   2. Allowed MIME types: image/jpeg, image/png, image/webp
 *   3. File size limit 2MB (profile photos are capped at 500KB in the API)
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { apiLogger } from "./logger";
import { safeFetchImage } from "./safe-fetch";
import { StorageError } from "./storage-errors";

// Re-exported so callers can keep importing from "@/lib/storage" and do not
// have to know the leaf-module split exists. See storage-errors.ts for why.
export { StorageError } from "./storage-errors";
export type { StorageFailureReason } from "./storage-errors";

const PROVIDER = (process.env.STORAGE_PROVIDER || "local") as "local" | "supabase";
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "photos";

// ── Supabase client (lazy init, same pattern as lib/email.ts) ────────────

let supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when STORAGE_PROVIDER=supabase"
      );
    }
    supabaseClient = createClient(url, key, {
      auth: { persistSession: false },
    });
  }
  return supabaseClient;
}

// ── Local filesystem provider ────────────────────────────────────────────

/**
 * Build a `YYYY/MM`-partitioned subdirectory.
 *
 * This used to live INSIDE `uploadLocal`/`uploadSupabase`, which meant every
 * caller silently got date partitioning whether or not it wanted it. That is
 * wrong for the document routes, which partition by event id instead, so the
 * partitioning is now the caller's explicit choice and the write primitives
 * do exactly what they are told. Existing path shapes are unchanged: the four
 * wrappers below apply it exactly where it was applied before.
 */
function datePartition(subdirectory: string): string {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  return `${subdirectory}/${year}/${month}`;
}

async function uploadLocal(buffer: Buffer, filename: string, subdirectory: string): Promise<string> {
  const { writeFile, mkdir } = await import("fs/promises");
  const { join } = await import("path");

  // `recursive: true` is idempotent, so the previous existsSync-then-mkdir
  // check was both redundant and a check-then-act pattern. Dropped.
  const uploadDir = join(process.cwd(), "public", "uploads", subdirectory);
  await mkdir(uploadDir, { recursive: true });

  const filepath = join(uploadDir, filename);
  await writeFile(filepath, buffer);
  apiLogger.info({ msg: "storage:file-written", filepath });

  return `/uploads/${subdirectory}/${filename}`;
}

// `deleteLocal` was removed in the Phase 1 consolidation. It joined straight
// onto `public/` with no containment check; `deleteStoredFile` below is the
// prefix-guarded replacement and every former caller now routes through it.

// ── Supabase Storage provider ────────────────────────────────────────────

async function uploadSupabase(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  subdirectory: string
): Promise<string> {
  const client = getSupabaseClient();

  const storagePath = `${subdirectory}/${filename}`;

  const { error } = await client.storage
    .from(SUPABASE_STORAGE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: mimeType,
      cacheControl: "31536000",
      upsert: false,
    });

  if (error) {
    throw new Error(`Supabase Storage upload failed: ${error.message}`);
  }

  const { data: urlData } = client.storage
    .from(SUPABASE_STORAGE_BUCKET)
    .getPublicUrl(storagePath);

  return urlData.publicUrl;
}

async function deleteSupabase(url: string): Promise<void> {
  const client = getSupabaseClient();

  // Extract storage path from full Supabase URL
  const marker = `/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) {
    apiLogger.warn({ msg: "Cannot parse Supabase Storage URL for deletion", url });
    return;
  }
  const storagePath = url.slice(idx + marker.length);

  const { error } = await client.storage
    .from(SUPABASE_STORAGE_BUCKET)
    .remove([storagePath]);

  if (error) {
    apiLogger.warn({ msg: "Failed to delete from Supabase Storage", storagePath, error: error.message });
  }
}

// ── Unified file API ─────────────────────────────────────────────────────
//
// Every upload, read and delete in the app funnels through these four
// functions. Before Phase 1 (Aug 2026) only photos, media, certificate PDFs
// and Stripe receipts used this module: NINE document routes hand-rolled
// `mkdir` + `writeFile`, and a dozen read sites hand-rolled their own
// traversal guard — including both paths a passport arrives through.
//
// Consolidating is what makes changing the backing store a one-file change
// rather than a twenty-file sweep in which a single missed site silently
// leaves sensitive files in the wrong jurisdiction while the claim says
// otherwise. See docs/UAE_DOCUMENT_RESIDENCY_PLAN.md.

const UPLOADS_URL_PREFIX = "/uploads/";

/**
 * Map a stored path (`/uploads/speaker-docs/{eventId}/{uuid}.pdf`) to an
 * absolute on-disk path, refusing anything outside `requirePrefix`.
 *
 * `requirePrefix` is REQUIRED rather than optional on purpose. It is the guard
 * every read site currently re-implements, and an optional argument is one
 * that someone eventually leaves out. Forcing each caller to name its own root
 * is the whole point of centralising this.
 */
async function resolveLocalReadPath(
  storedPath: string,
  requirePrefix: string,
): Promise<string> {
  const { resolve, sep } = await import("path");
  const { realpath } = await import("fs/promises");

  // A prefix that is itself malformed is a programming error, not user input.
  // Fail loudly rather than silently widening the guard to the whole disk.
  if (!requirePrefix.startsWith(UPLOADS_URL_PREFIX) || !requirePrefix.endsWith("/")) {
    throw new StorageError(
      "prefix-rejected",
      `requirePrefix must start with ${UPLOADS_URL_PREFIX} and end with "/": got ${requirePrefix}`,
    );
  }
  if (storedPath.includes("\0") || storedPath.includes("..")) {
    throw new StorageError("traversal-blocked", `Rejected stored path: ${storedPath}`);
  }
  if (!storedPath.startsWith(requirePrefix)) {
    throw new StorageError(
      "prefix-rejected",
      `Stored path is outside ${requirePrefix}: ${storedPath}`,
    );
  }

  const root = resolve(process.cwd(), "public", requirePrefix.slice(1));
  const abs = resolve(process.cwd(), "public", storedPath.slice(1));

  // realpath resolves symlinks, so the containment check below cannot be
  // defeated by a symlink planted inside the uploads tree. It throws ENOENT
  // when the file does not exist, which is the not-found signal.
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    throw new StorageError("not-found", `No such stored file: ${storedPath}`);
  }
  if (!real.startsWith(root + sep)) {
    throw new StorageError("traversal-blocked", `Resolved outside ${requirePrefix}: ${storedPath}`);
  }
  return real;
}

/**
 * Write a file and return its stored path.
 *
 * `subdirectory` is the full relative directory beneath `uploads/`, with no
 * leading or trailing slash — `"photos/2026/08"`, `"speaker-docs/{eventId}"`.
 * The primitive deliberately does no date partitioning of its own: callers
 * that want `YYYY/MM` build it, callers keyed by event id do not, and a
 * primitive that guessed would be wrong for half of them.
 */
export async function uploadFile(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  subdirectory: string,
): Promise<string> {
  if (PROVIDER === "supabase") {
    return uploadSupabase(buffer, filename, mimeType, subdirectory);
  }
  return uploadLocal(buffer, filename, subdirectory);
}

/**
 * Read a stored file. Throws {@link StorageError} — callers map `reason` to
 * their own status codes and log lines.
 */
export async function readStoredFile(
  storedPath: string,
  requirePrefix: string,
): Promise<Buffer> {
  const { readFile } = await import("fs/promises");
  const real = await resolveLocalReadPath(storedPath, requirePrefix);
  return readFile(real);
}

/**
 * Delete a stored file. NEVER throws.
 *
 * Deletion is always best-effort cleanup that runs after the database row it
 * belongs to has already been committed, so a failure here must never turn a
 * successful operation into an error. An orphaned file is cheap; a 500 on a
 * committed write is not. It logs at warn so the orphan is still traceable.
 *
 * Unlike the old `deleteLocal` this one is prefix-guarded. That function
 * joined straight onto `public/` with no containment check at all; the paths
 * it receives come from our own database rather than user input, so it was not
 * exploitable, but "the input happens to be ours" is not a boundary.
 */
export async function deleteStoredFile(
  storedPath: string,
  requirePrefix: string = UPLOADS_URL_PREFIX,
): Promise<void> {
  if (PROVIDER === "supabase") {
    return deleteSupabase(storedPath);
  }
  const { unlink } = await import("fs/promises");
  try {
    const real = await resolveLocalReadPath(storedPath, requirePrefix);
    await unlink(real);
  } catch (err) {
    const reason = err instanceof StorageError ? err.reason : "unlink-failed";
    apiLogger.warn({ msg: "storage:delete-failed", storedPath, reason });
  }
}

// ── Public API ───────────────────────────────────────────────────────────

export async function uploadPhoto(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<string> {
  return uploadFile(buffer, filename, mimeType, datePartition("photos"));
}

export async function deletePhoto(url: string): Promise<void> {
  return deleteStoredFile(url, "/uploads/photos/");
}

export async function uploadMedia(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<string> {
  return uploadFile(buffer, filename, mimeType, datePartition("media"));
}

export async function deleteMedia(url: string): Promise<void> {
  return deleteStoredFile(url, "/uploads/media/");
}

/**
 * Uploads a rendered certificate PDF. Stored under `certificates/{eventId}/`
 * to keep one event's certs separable for retention / cleanup. Filename
 * is the IssuedCertificate id with `.pdf` so the URL is stable across
 * re-downloads. Returns the public URL.
 *
 * S3 cross-region backup is deferred to a separate cron in v1.1 — that
 * cron will read IssuedCertificate rows where pdfUrl is set + a backup
 * URL field is null, fetch from Supabase, upload to S3, persist the
 * second URL. Decouples the cert-issue critical path from backup work.
 */
export async function uploadCertificatePdf(
  buffer: Buffer,
  filename: string,
  eventId: string
): Promise<string> {
  return uploadFile(
    buffer,
    filename,
    "application/pdf",
    datePartition(`certificates/${eventId}`),
  );
}

/**
 * Persist a downloaded Stripe receipt (HTML) into our storage under
 * `/uploads/stripe-receipts/{YYYY}/{MM}/`. Mirrors uploadCertificatePdf.
 */
export async function uploadStripeReceipt(
  buffer: Buffer,
  filename: string
): Promise<string> {
  return uploadFile(buffer, filename, "text/html", datePartition("stripe-receipts"));
}

/**
 * Downloads an external photo URL and re-hosts it in our storage.
 * Returns the local/Supabase URL on success, or null on failure.
 * Skips URLs that are already hosted by us.
 *
 * SSRF: this used to be a bare `fetch(externalUrl)` with no validation of any
 * kind. The URL arrives from the EventsAir import payload, so it is not typed by
 * an end user — but it is not ours either, and "an upstream system supplies it"
 * is not a security boundary. A bare fetch here could be pointed at the EC2
 * instance-metadata endpoint, at localhost, or at any service on the Docker
 * network (the app is on the same bridge as the worker and MediaMTX). The Docker
 * socket is mounted into this container, which makes the blast radius of an
 * app-initiated internal request considerably worse than it looks.
 *
 * It now goes through the SSRF-safe fetcher the codebase already had and this
 * call site never used: scheme + credential checks, a cloud-metadata hostname
 * blocklist, DNS resolution with private/reserved IP rejection, and — the part a
 * naive allowlist always misses — re-validation of every redirect hop, so a
 * permitted host cannot 302 us into 169.254.169.254.
 */
export async function downloadExternalPhoto(
  externalUrl: string
): Promise<string | null> {
  // Skip if already a local upload or Supabase URL
  if (externalUrl.startsWith("/uploads/")) return externalUrl;
  if (externalUrl.includes(".supabase.co/storage/")) return externalUrl;

  try {
    const result = await safeFetchImage(externalUrl, {
      maxBytes: 500 * 1024, // unchanged: 500KB cap
      timeoutMs: 10_000, // unchanged
      maxRedirects: 2,
    });

    if (!result.ok) {
      // Log the REASON, not just "it failed". An `ip_blocked` here is a security
      // event (something tried to make us fetch an internal address); an
      // `http_error` is just a dead link. They should not look the same in /logs.
      apiLogger.warn({
        msg: "external-photo:rejected",
        url: externalUrl,
        reason: result.reason,
        detail: result.detail,
        finalUrl: result.finalUrl,
      });
      return null;
    }

    const { buffer, ext, mime } = result.data;

    // safeFetchImage permits SVG. We must not: these files are re-served from OUR
    // origin, and an SVG can carry a <script>. Accepting one would turn a photo
    // import into stored XSS on our own domain.
    if (ext === "svg") {
      apiLogger.warn({ msg: "external-photo:svg-rejected", url: externalUrl });
      return null;
    }

    const { randomUUID } = await import("crypto");
    const filename = `${randomUUID()}.${ext}`;

    return await uploadPhoto(buffer, filename, mime);
  } catch (err) {
    apiLogger.warn({ msg: "external-photo:download-failed", url: externalUrl, err });
    return null;
  }
}

export { PROVIDER as storageProvider };
