/**
 * Storage abstraction for file uploads (photos + media).
 *
 * Two providers:
 *   - "local"    — writes to /public/uploads/{photos,media}/ (EC2/Docker)
 *   - "supabase" — uploads to Supabase Storage bucket (Vercel / serverless)
 *
 * Selected via STORAGE_PROVIDER env var (defaults to "local").
 *
 * Supabase setup:
 *   1. Create a public bucket (name matches SUPABASE_STORAGE_BUCKET, default "photos")
 *   2. Set allowed MIME types: image/jpeg, image/png, image/webp
 *   3. Set file size limit to 2MB (media uploads allow up to 2MB; profile photos are 500KB, enforced in API)
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { apiLogger } from "./logger";
import { safeFetchImage } from "./safe-fetch";

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

async function uploadLocal(buffer: Buffer, filename: string, subdirectory = "photos"): Promise<string> {
  const { writeFile, mkdir } = await import("fs/promises");
  const { join } = await import("path");
  const { existsSync } = await import("fs");

  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const uploadDir = join(process.cwd(), "public", "uploads", subdirectory, year, month);

  if (!existsSync(uploadDir)) {
    await mkdir(uploadDir, { recursive: true });
    apiLogger.info({ msg: "Created upload directory", uploadDir });
  }

  const filepath = join(uploadDir, filename);
  await writeFile(filepath, buffer);
  apiLogger.info({ msg: "File written to disk", filepath });

  return `/uploads/${subdirectory}/${year}/${month}/${filename}`;
}

async function deleteLocal(url: string): Promise<void> {
  const { unlink } = await import("fs/promises");
  const { join } = await import("path");

  const filepath = join(process.cwd(), "public", url);
  try {
    await unlink(filepath);
  } catch {
    apiLogger.warn({ msg: "Failed to delete local file", filepath });
  }
}

// ── Supabase Storage provider ────────────────────────────────────────────

async function uploadSupabase(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  subdirectory = "photos"
): Promise<string> {
  const client = getSupabaseClient();

  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const storagePath = `${subdirectory}/${year}/${month}/${filename}`;

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

// ── Public API ───────────────────────────────────────────────────────────

export async function uploadPhoto(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<string> {
  if (PROVIDER === "supabase") {
    return uploadSupabase(buffer, filename, mimeType);
  }
  return uploadLocal(buffer, filename);
}

export async function deletePhoto(url: string): Promise<void> {
  if (PROVIDER === "supabase") {
    return deleteSupabase(url);
  }
  return deleteLocal(url);
}

export async function uploadMedia(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<string> {
  if (PROVIDER === "supabase") {
    return uploadSupabase(buffer, filename, mimeType, "media");
  }
  return uploadLocal(buffer, filename, "media");
}

export async function deleteMedia(url: string): Promise<void> {
  if (PROVIDER === "supabase") {
    return deleteSupabase(url);
  }
  return deleteLocal(url);
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
  const subdir = `certificates/${eventId}`;
  if (PROVIDER === "supabase") {
    return uploadSupabase(buffer, filename, "application/pdf", subdir);
  }
  return uploadLocal(buffer, filename, subdir);
}

/**
 * Persist a downloaded Stripe receipt (HTML) into our storage under
 * `/uploads/stripe-receipts/{YYYY}/{MM}/`. Mirrors uploadCertificatePdf.
 */
export async function uploadStripeReceipt(
  buffer: Buffer,
  filename: string
): Promise<string> {
  const subdir = "stripe-receipts";
  if (PROVIDER === "supabase") {
    return uploadSupabase(buffer, filename, "text/html", subdir);
  }
  return uploadLocal(buffer, filename, subdir);
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
