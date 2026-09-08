/**
 * The storage-then-row half of a media upload, shared by the organisation
 * upload route (`/api/media`) and the event upload route
 * (`/api/events/[eventId]/media`).
 *
 * Why one helper (review Sep 8, 2026, P2c): the two routes each carried their
 * own copy of "upload the object, then insert the row", and they drifted. The
 * event route deleted the object again when the row insert failed; the org
 * route did not, so a database blip left an untracked file in PUBLIC storage
 * that no screen could ever find, because no row pointed at it. The org route
 * had also stopped sanitising the display filename. Both now call this.
 *
 * Contract: on a row-insert failure the uploaded object is deleted (best
 * effort, logged) and the ORIGINAL error is rethrown, so the caller's 500 is
 * about the row, never about the cleanup.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { deleteMedia, uploadMedia } from "@/lib/storage";

/** Object-name extension per accepted image type (validated upstream). */
export const MEDIA_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const MEDIA_ROW_SELECT = {
  id: true,
  url: true,
  filename: true,
  mimeType: true,
  size: true,
  createdAt: true,
} as const;

export interface StoreUploadedMediaInput {
  buffer: Buffer;
  /** Magic-byte detected type, never the client's claim. */
  detectedMime: string;
  /** The client's file name; stored for display only, sanitised here. */
  originalFilename: string;
  size: number;
  organizationId: string;
  uploadedById: string;
  eventId?: string;
}

/** Strip path components and cap the length; the stored name is display only. */
export function safeMediaFilename(name: string): string {
  return name.replace(/[/\\]/g, "").slice(0, 255) || "upload";
}

export async function storeUploadedMedia(input: StoreUploadedMediaInput) {
  const ext = MEDIA_MIME_TO_EXT[input.detectedMime] ?? "bin";
  const url = await uploadMedia(input.buffer, `${randomUUID()}.${ext}`, input.detectedMime);
  try {
    return await db.mediaFile.create({
      data: {
        organizationId: input.organizationId,
        ...(input.eventId ? { eventId: input.eventId } : {}),
        uploadedById: input.uploadedById,
        filename: safeMediaFilename(input.originalFilename),
        url,
        mimeType: input.detectedMime,
        size: input.size,
      },
      select: MEDIA_ROW_SELECT,
    });
  } catch (dbErr) {
    // The object is already public; without this it would outlive the failed
    // request with nothing pointing at it.
    apiLogger.error({
      msg: "media:row-create-failed-deleting-orphaned-object",
      err: dbErr,
      url,
      eventId: input.eventId ?? null,
    });
    await deleteMedia(url).catch((storageErr) =>
      apiLogger.error({ msg: "media:orphaned-object-cleanup-failed", err: storageErr, url }),
    );
    throw dbErr;
  }
}
