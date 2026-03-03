/**
 * Storage abstraction for photo uploads.
 *
 * Two providers:
 *   - "local"    — writes to /public/uploads/photos/ (EC2/Docker)
 *   - "supabase" — uploads to Supabase Storage bucket (Vercel / serverless)
 *
 * Selected via STORAGE_PROVIDER env var (defaults to "local").
 *
 * Supabase setup:
 *   1. Create a public bucket (name matches SUPABASE_STORAGE_BUCKET, default "photos")
 *   2. Set allowed MIME types: image/jpeg, image/png, image/webp
 *   3. Set file size limit to 500KB
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { apiLogger } from "./logger";

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

async function uploadLocal(buffer: Buffer, filename: string): Promise<string> {
  const { writeFile, mkdir } = await import("fs/promises");
  const { join } = await import("path");
  const { existsSync } = await import("fs");

  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const uploadDir = join(process.cwd(), "public", "uploads", "photos", year, month);

  if (!existsSync(uploadDir)) {
    await mkdir(uploadDir, { recursive: true });
    apiLogger.info({ msg: "Created upload directory", uploadDir });
  }

  const filepath = join(uploadDir, filename);
  await writeFile(filepath, buffer);
  apiLogger.info({ msg: "File written to disk", filepath });

  return `/uploads/photos/${year}/${month}/${filename}`;
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
  mimeType: string
): Promise<string> {
  const client = getSupabaseClient();

  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const storagePath = `${year}/${month}/${filename}`;

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

export { PROVIDER as storageProvider };
