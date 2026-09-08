/**
 * email-attachment-prune: collects operator-picked email attachments once no
 * queued send needs them.
 *
 * Files under /uploads/email-attachments/{eventId}/ are transient by design:
 * uploaded from the send dialog, read back at send time, and then nothing
 * points at them (EmailLog records attachment NAMES only). Two things keep a
 * file alive: age inside the grace window (a scheduled send may be days out,
 * and an operator may still be composing), and a reference from a
 * ScheduledEmail row that can still fire (PENDING, PROCESSING, or FAILED,
 * which Retry re-runs). A referenced file is NEVER deleted, whatever its age.
 *
 * Same shape as supporting-document-prune: enumerate through the storage
 * layer so it works whatever the backing store, age check before the
 * reference check, a per-tick ceiling, and a summary line only when something
 * happened.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { listStoredFiles, deleteStoredFile } from "@/lib/storage";
import { UPLOAD_PREFIX, UPLOAD_SEGMENT } from "@/lib/upload-prefixes";
import type { StoredAttachmentRef } from "@/lib/email-attachment-limits";

/** Long enough for a scheduled send a week out and for the dialog to be
 *  abandoned and re-opened; short enough that the prefix never grows. */
export const EMAIL_ATTACHMENT_GRACE_DAYS = 7;

const MAX_DELETES_PER_TICK = 500;

export interface EmailAttachmentPruneResult {
  scanned: number;
  deleted: number;
  /** Inside the grace window, left alone deliberately. */
  skippedRecent: number;
  /** Older than the window but a queued send still names it. */
  skippedReferenced: number;
  capped: boolean;
  errors: number;
}

/** Every storedPath a still-runnable queued send references. */
export async function referencedAttachmentPaths(): Promise<Set<string>> {
  const rows = await db.scheduledEmail.findMany({
    where: { status: { in: ["PENDING", "PROCESSING", "FAILED"] } },
    select: { attachments: true },
  });
  const set = new Set<string>();
  for (const row of rows) {
    const refs = Array.isArray(row.attachments) ? (row.attachments as unknown as StoredAttachmentRef[]) : [];
    for (const ref of refs) if (ref && typeof ref.storedPath === "string") set.add(ref.storedPath);
  }
  return set;
}

export async function runEmailAttachmentPruneTick(now: Date = new Date()): Promise<EmailAttachmentPruneResult> {
  const cutoff = now.getTime() - EMAIL_ATTACHMENT_GRACE_DAYS * 24 * 60 * 60 * 1000;
  const result: EmailAttachmentPruneResult = {
    scanned: 0,
    deleted: 0,
    skippedRecent: 0,
    skippedReferenced: 0,
    capped: false,
    errors: 0,
  };

  let files: Awaited<ReturnType<typeof listStoredFiles>>;
  try {
    files = await listStoredFiles(UPLOAD_SEGMENT.emailAttachments);
  } catch (err) {
    result.errors++;
    apiLogger.error({ err, msg: "email-attachment-prune:list-failed" });
    return result;
  }

  // One query for the whole tick rather than one per file: the reference set
  // is small (queued sends), the file list can be large.
  let referenced: Set<string>;
  try {
    referenced = await referencedAttachmentPaths();
  } catch (err) {
    // Without the reference set a deletion could take a queued send's file;
    // fail the tick rather than fail open.
    result.errors++;
    apiLogger.error({ err, msg: "email-attachment-prune:references-failed" });
    return result;
  }

  for (const file of files) {
    if (result.deleted >= MAX_DELETES_PER_TICK) {
      result.capped = true;
      break;
    }
    result.scanned++;
    try {
      if (file.modifiedAt.getTime() >= cutoff) {
        result.skippedRecent++;
        continue;
      }
      if (referenced.has(file.storedPath)) {
        result.skippedReferenced++;
        continue;
      }
      await deleteStoredFile(file.storedPath, UPLOAD_PREFIX.emailAttachments);
      result.deleted++;
    } catch (err) {
      result.errors++;
      apiLogger.warn({ err, msg: "email-attachment-prune:file-failed", storedPath: file.storedPath });
    }
  }

  if (result.deleted > 0 || result.capped || result.errors > 0) {
    apiLogger.info({ msg: "email-attachment-prune:tick", ...result });
  }
  return result;
}
