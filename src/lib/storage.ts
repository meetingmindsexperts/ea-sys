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

const PROVIDER = (process.env.STORAGE_PROVIDER || "local") as "local" | "supabase" | "s3";
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
/**
 * The provider-independent half of the guard: the three string checks.
 *
 * Shared so the S3 branch enforces exactly the same rules as the local one.
 * S3 has no symlinks and its keys are flat, so it cannot do the filesystem
 * resolution below, which makes it all the more important that it is not
 * quietly running a WEAKER version of the string checks.
 */
function assertStoredPathWithin(storedPath: string, requirePrefix: string): void {
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
}

/** `/uploads/photos/x.jpg` -> `photos/x.jpg`. The whole migration story. */
function storedPathToKey(storedPath: string): string {
  return storedPath.slice(UPLOADS_URL_PREFIX.length);
}

/** `photos/x.jpg` -> `/uploads/photos/x.jpg`. */
function keyToStoredPath(key: string): string {
  return `${UPLOADS_URL_PREFIX}${key}`;
}

async function resolveLocalReadPath(
  storedPath: string,
  requirePrefix: string,
): Promise<string> {
  const { resolve, sep } = await import("path");
  const { realpath } = await import("fs/promises");

  assertStoredPathWithin(storedPath, requirePrefix);

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
  if (PROVIDER === "s3") {
    const { s3Upload } = await import("./storage-s3");
    const storedPath = `/uploads/${subdirectory}/${filename}`;
    await s3Upload(buffer, storedPathToKey(storedPath), mimeType);
    apiLogger.info({ msg: "storage:file-written", storedPath, provider: "s3" });
    return storedPath;
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
  opts: { signal?: AbortSignal } = {},
): Promise<Buffer> {
  if (PROVIDER === "s3") {
    assertStoredPathWithin(storedPath, requirePrefix);
    const { s3Read } = await import("./storage-s3");
    return s3Read(storedPathToKey(storedPath), opts.signal);
  }
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
  try {
    if (PROVIDER === "s3") {
      assertStoredPathWithin(storedPath, requirePrefix);
      const { s3Delete } = await import("./storage-s3");
      await s3Delete(storedPathToKey(storedPath));
      return;
    }
    const { unlink } = await import("fs/promises");
    const real = await resolveLocalReadPath(storedPath, requirePrefix);
    await unlink(real);
  } catch (err) {
    const reason = err instanceof StorageError ? err.reason : "delete-failed";
    apiLogger.warn({ msg: "storage:delete-failed", storedPath, reason });
  }
}

// ── Direct uploads: files too large for the app ──────────────────────────
//
// Speaker presentations (Nov 19, 2026; docs/SPEAKER_PRESENTATIONS_PLAN.md)
// run to hundreds of MB; nginx refuses a body over 10 MB and a large one
// would hold a web container for minutes. So on S3 the browser uploads by a
// signed form and reads by a signed link, and the app never holds the bytes.
// On the local provider (development, the test server) there is no bucket:
// the caller's own route takes the file, bounded by the proxy's upload limit.

/** Where the browser sends the file: a signed form to the bucket, or the caller's own route. */
export type DirectUploadTarget = { via: "s3"; url: string; fields: Record<string, string> } | { via: "app" };

export async function signDirectUpload(opts: {
  storedPath: string;
  requirePrefix: string;
  contentType: string;
  /** The body S3 will take, in bytes. Pass the same number twice for an exact size. */
  minBytes: number;
  maxBytes: number;
  expiresSeconds: number;
}): Promise<DirectUploadTarget> {
  assertStoredPathWithin(opts.storedPath, opts.requirePrefix);
  if (PROVIDER === "s3") {
    const { s3SignUpload } = await import("./storage-s3");
    const signed = await s3SignUpload({
      key: storedPathToKey(opts.storedPath),
      contentType: opts.contentType,
      minBytes: opts.minBytes,
      maxBytes: opts.maxBytes,
      expiresSeconds: opts.expiresSeconds,
    });
    return { via: "s3", url: signed.url, fields: signed.fields };
  }
  if (PROVIDER === "local") return { via: "app" };
  throw new Error("Direct uploads need STORAGE_PROVIDER s3 or local");
}

/** A stored file's size, and on S3 its version and ETag. Null when there is no such file. */
export async function headStoredFile(
  storedPath: string,
  requirePrefix: string,
  versionId?: string | null,
): Promise<{ size: number; versionId: string | null; etag: string | null } | null> {
  if (PROVIDER === "s3") {
    assertStoredPathWithin(storedPath, requirePrefix);
    const { s3Head } = await import("./storage-s3");
    return s3Head(storedPathToKey(storedPath), versionId);
  }
  const { stat } = await import("fs/promises");
  try {
    const real = await resolveLocalReadPath(storedPath, requirePrefix);
    return { size: (await stat(real)).size, versionId: null, etag: null };
  } catch (err) {
    if (err instanceof StorageError && err.reason === "not-found") return null;
    throw err;
  }
}

/** The first `bytes` of a stored file: its signature, never the whole file. */
export async function readStoredFileStart(
  storedPath: string,
  requirePrefix: string,
  bytes: number,
  versionId?: string | null,
): Promise<Buffer> {
  if (PROVIDER === "s3") {
    assertStoredPathWithin(storedPath, requirePrefix);
    const { s3ReadStart } = await import("./storage-s3");
    return s3ReadStart(storedPathToKey(storedPath), bytes, versionId);
  }
  const { open } = await import("fs/promises");
  const real = await resolveLocalReadPath(storedPath, requirePrefix);
  const handle = await open(real, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * A short-lived link to download a stored file, or null on the local
 * provider, where the caller streams it itself (small files only there).
 */
export async function signStoredFileDownload(opts: {
  storedPath: string;
  requirePrefix: string;
  versionId?: string | null;
  expiresSeconds: number;
  contentDisposition: string;
  contentType: string;
}): Promise<string | null> {
  assertStoredPathWithin(opts.storedPath, opts.requirePrefix);
  if (PROVIDER !== "s3") return null;
  const { s3SignDownload } = await import("./storage-s3");
  return s3SignDownload({
    key: storedPathToKey(opts.storedPath),
    versionId: opts.versionId,
    expiresSeconds: opts.expiresSeconds,
    contentDisposition: opts.contentDisposition,
    contentType: opts.contentType,
  });
}

/**
 * Write a large file as it is made, from a stream of bytes, and answer its
 * size (Nov 25, 2026: the MP4 of a partner stream's recording). On S3 a
 * multipart upload holding one 16 MB part in memory; locally, a file. Throws
 * on failure, leaving nothing half-written on S3.
 */
export async function writeStoredFileStream(
  source: AsyncIterable<Buffer>,
  storedPath: string,
  requirePrefix: string,
  contentType: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ bytes: number }> {
  assertStoredPathWithin(storedPath, requirePrefix);
  if (PROVIDER === "s3") {
    const { s3UploadStream } = await import("./storage-s3");
    const written = await s3UploadStream(source, storedPathToKey(storedPath), contentType, opts.signal);
    apiLogger.info({ msg: "storage:file-written", storedPath, provider: "s3", bytes: written.bytes });
    return written;
  }
  if (PROVIDER !== "local") throw new Error("Streamed writes need STORAGE_PROVIDER s3 or local");
  const { createWriteStream } = await import("fs");
  const { mkdir } = await import("fs/promises");
  const { dirname, resolve } = await import("path");
  const { pipeline } = await import("stream/promises");
  const { Readable } = await import("stream");
  const abs = resolve(process.cwd(), "public", storedPath.slice(1));
  await mkdir(dirname(abs), { recursive: true });
  let bytes = 0;
  const counted = Readable.from(
    (async function* () {
      for await (const chunk of source) {
        bytes += chunk.length;
        yield chunk;
      }
    })(),
  );
  await pipeline(counted, createWriteStream(abs), opts.signal ? { signal: opts.signal } : {});
  if (opts.signal?.aborted) throw new Error("The write was stopped before it was complete");
  return { bytes };
}

/**
 * Delete many stored files at once (a recording's pieces). NEVER throws, like
 * deleteStoredFile: answers how many could not be deleted, and logs them by
 * count, so the orphan sweep that runs later can finish the job.
 */
export async function deleteStoredFiles(storedPaths: readonly string[], requirePrefix: string): Promise<{ failed: number }> {
  if (storedPaths.length === 0) return { failed: 0 };
  try {
    for (const p of storedPaths) assertStoredPathWithin(p, requirePrefix);
    if (PROVIDER === "s3") {
      const { s3DeleteMany } = await import("./storage-s3");
      const failed = await s3DeleteMany(storedPaths.map(storedPathToKey));
      if (failed.length > 0) apiLogger.warn({ msg: "storage:delete-many-partly-failed", failed: failed.length, of: storedPaths.length });
      return { failed: failed.length };
    }
  } catch (err) {
    const reason = err instanceof StorageError ? err.reason : "delete-failed";
    apiLogger.warn({ msg: "storage:delete-many-failed", reason, of: storedPaths.length });
    return { failed: storedPaths.length };
  }
  let failed = 0;
  for (const p of storedPaths) {
    // deleteStoredFile never throws and logs its own failure; count what is still there.
    await deleteStoredFile(p, requirePrefix);
    if (PROVIDER === "local" && (await headStoredFile(p, requirePrefix).catch(() => null))) failed += 1;
  }
  return { failed };
}

/**
 * List every stored file beneath `subdirectory`, newest-agnostic, recursive.
 *
 * Exists for the supporting-document prune worker, which has to find files that
 * no database row claims. That is the one job that cannot work from the
 * database alone, so it is the one job that needs to enumerate storage.
 */
export async function listStoredFiles(
  subdirectory: string,
): Promise<{ storedPath: string; modifiedAt: Date; sizeBytes: number }[]> {
  if (PROVIDER === "s3") {
    const { s3List } = await import("./storage-s3");
    const objects = await s3List(`${subdirectory}/`);
    return objects.map((o) => ({
      storedPath: keyToStoredPath(o.key),
      modifiedAt: o.modifiedAt,
      sizeBytes: o.sizeBytes,
    }));
  }
  if (PROVIDER === "supabase") {
    // Not implemented: nothing calls this under the Supabase provider, and a
    // half-working listing is worse than an obvious refusal, because its
    // caller reaps files and an empty result reads as "nothing to do".
    throw new Error("listStoredFiles is not implemented for STORAGE_PROVIDER=supabase");
  }

  const { readdir, stat } = await import("fs/promises");
  const { join, resolve, sep } = await import("path");
  const root = resolve(process.cwd(), "public", "uploads", subdirectory);
  const out: { storedPath: string; modifiedAt: Date; sizeBytes: number }[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      // A missing root means nothing has been uploaded yet, which is not an
      // error. A deeper unreadable directory is skipped rather than aborting
      // the whole sweep, matching the per-directory tolerance the prune worker
      // had before this was centralised.
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      const info = await stat(abs).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) {
        await walk(abs);
        continue;
      }
      const rel = abs.slice(root.length + 1).split(sep).join("/");
      out.push({
        storedPath: `${UPLOADS_URL_PREFIX}${subdirectory}/${rel}`,
        modifiedAt: info.mtime,
        sizeBytes: info.size,
      });
    }
  }

  await walk(root);
  return out;
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
