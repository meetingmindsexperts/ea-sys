/**
 * The one way a handout's bytes leave storage (Oct 6, 2026), shared by the
 * attendee download and the console's "open" link, so the folder check and the
 * headers cannot drift between them. Server only.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { deleteStoredFile, readStoredFile } from "@/lib/storage";
import { StorageError } from "@/lib/storage-errors";
import { UPLOAD_PREFIX } from "@/lib/upload-prefixes";
import type { WebinarHandout } from "./handouts";

/** This event's private folder: the only place its handouts may be read from. */
export function handoutFolder(eventId: string): string {
  return `${UPLOAD_PREFIX.webinarHandouts}${eventId}/`;
}

export async function handoutDownloadResponse(
  eventId: string,
  handout: WebinarHandout | undefined,
  log: Record<string, unknown>,
): Promise<NextResponse> {
  const folder = handoutFolder(eventId);
  if (!handout || !handout.storedPath.startsWith(folder)) {
    apiLogger.warn({ ...log, eventId, found: !!handout }, "webinar-handouts:download-not-found");
    return NextResponse.json({ error: "Handout not found" }, { status: 404 });
  }
  let bytes: Buffer;
  try {
    bytes = await readStoredFile(handout.storedPath, folder);
  } catch (err) {
    // Listed but gone from storage: a 404 to the viewer, logged for us.
    if (err instanceof StorageError) {
      apiLogger.warn({ ...log, eventId, reason: err.reason }, "webinar-handouts:download-file-missing");
      return NextResponse.json({ error: "Handout not found" }, { status: 404 });
    }
    throw err;
  }
  apiLogger.info({ ...log, eventId }, "webinar-handouts:downloaded");
  // PDFs open in the browser; Office files download.
  const disposition = handout.contentType === "application/pdf" ? "inline" : "attachment";
  // A view over the same memory, not a second copy of the file.
  return new NextResponse(new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength), {
    status: 200,
    headers: {
      "Content-Type": handout.contentType,
      "Content-Disposition": `${disposition}; filename="${handout.name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(handout.name)}`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * After an event is deleted: remove its handout files, which nothing else
 * references (review of handouts). Never throws: a failed delete leaves an
 * orphan in the private folder, logged, and must not fail the event delete.
 */
export async function removeHandoutFiles(eventId: string, handouts: WebinarHandout[]): Promise<void> {
  const folder = handoutFolder(eventId);
  for (const h of handouts) {
    try {
      await deleteStoredFile(h.storedPath, folder);
    } catch (err) {
      apiLogger.error({ err, eventId, storedPath: h.storedPath }, "webinar-handouts:event-delete-file-failed");
    }
  }
  if (handouts.length) apiLogger.info({ eventId, count: handouts.length }, "webinar-handouts:event-delete-files-removed");
}
