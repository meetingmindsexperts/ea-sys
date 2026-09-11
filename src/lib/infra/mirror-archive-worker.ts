/**
 * Builds a zip of the whole Singapore uploads mirror on request
 * (/admin/backups "Build archive", Sep 11 2026).
 *
 * The queue is the MirrorArchive table: the route inserts PENDING, this tick
 * (every three minutes) claims the oldest one (a conditional PENDING → RUNNING write, so two
 * workers cannot build the same request), streams every object under
 * uploads/ through archiver into a temp file, uploads the zip under
 * mirror-archives/ and marks the row DONE with the key. The page then mints a
 * presigned link for it through the normal download route.
 *
 * Why a temp file: the mirror is ~165 MB today. Buffering the zip in memory
 * would put that on the worker's heap; streaming it to disk keeps memory flat
 * and gives PutObject the ContentLength it needs. Objects are pulled ONE at a
 * time (append, wait for archiver's "entry", then the next), so at most one S3
 * response stream is open.
 *
 * Housekeeping on every tick: a RUNNING row older than the stale threshold
 * (the worker restarted mid-build) is failed so it can be requested again,
 * and DONE archives past their TTL have their object deleted and the row
 * marked EXPIRED, so the bucket never accumulates a full copy per request.
 */
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { ZipArchive, type Archiver } from "archiver";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  DR_BUCKET_NAME,
  DR_MIRROR_PREFIX,
  MIRROR_ARCHIVE_PREFIX,
  getDrS3,
  listDrPrefix,
} from "@/lib/infra/aws-ops";

/** DONE archives are deleted after this many days. */
export const MIRROR_ARCHIVE_TTL_DAYS = 7;
/** A RUNNING row older than this is a build the worker died in the middle of. */
export const MIRROR_ARCHIVE_STALE_RUNNING_MINUTES = 90;

export interface MirrorArchiveTickResult {
  built: number;
  failed: number;
  expired: number;
  reclaimed: number;
}

export interface BuiltArchive {
  key: string;
  fileCount: number;
  sizeBytes: number;
}

/** Wait for archiver to finish the entry just appended, or fail with it. */
function entryFinished(archive: Archiver): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEntry = () => {
      archive.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      archive.off("entry", onEntry);
      reject(err);
    };
    archive.once("entry", onEntry);
    archive.once("error", onError);
  });
}

/**
 * Zip every object under the mirror prefix into a temp file, upload it, and
 * report the key. Throws on any failure; the temp file is always removed.
 * Exported for the tick and its tests.
 */
export async function buildMirrorArchive(id: string, now: Date): Promise<BuiltArchive> {
  const listed = await listDrPrefix(DR_MIRROR_PREFIX);
  if (listed.truncated) {
    // Never ship a partial copy that looks complete.
    throw new Error("The mirror listing hit its page cap; refusing to build a partial archive");
  }
  const objects = listed.objects;
  const s3 = getDrS3();
  const tmp = join(tmpdir(), `mirror-archive-${id}.zip`);
  try {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(tmp);
      const archive = new ZipArchive({ zlib: { level: 6 } });
      out.on("close", () => resolve());
      out.on("error", reject);
      archive.on("error", reject);
      archive.on("warning", (err: Error) => apiLogger.warn({ err, id }, "mirror-archive:archiver-warning"));
      archive.pipe(out);
      (async () => {
        for (const obj of objects) {
          const res = await s3.send(new GetObjectCommand({ Bucket: DR_BUCKET_NAME, Key: obj.key }));
          if (!res.Body) throw new Error(`Empty body for ${obj.key}`);
          const done = entryFinished(archive);
          archive.append(res.Body as Readable, { name: obj.key.slice(DR_MIRROR_PREFIX.length) });
          await done;
        }
        await archive.finalize();
      })().catch(reject);
    });
    const { size } = await fs.stat(tmp);
    const key = `${MIRROR_ARCHIVE_PREFIX}${now.toISOString().slice(0, 10)}-${id}.zip`;
    await s3.send(
      new PutObjectCommand({
        Bucket: DR_BUCKET_NAME,
        Key: key,
        Body: createReadStream(tmp),
        ContentLength: size,
        ContentType: "application/zip",
      }),
    );
    return { key, fileCount: objects.length, sizeBytes: size };
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** One worker tick: housekeeping, then at most one build. Exported for the job and its tests. */
export async function runMirrorArchiveTick(now: Date = new Date()): Promise<MirrorArchiveTickResult> {
  const result: MirrorArchiveTickResult = { built: 0, failed: 0, expired: 0, reclaimed: 0 };

  // A build the worker died in the middle of: fail it so it can be requested
  // again, and say so, because a row stuck RUNNING forever blocks the button.
  const staleBefore = new Date(now.getTime() - MIRROR_ARCHIVE_STALE_RUNNING_MINUTES * 60_000);
  const reclaimed = await db.mirrorArchive.updateMany({
    where: { status: "RUNNING", startedAt: { lt: staleBefore } },
    data: {
      status: "FAILED",
      error: "The worker restarted during the build. Request the archive again.",
      finishedAt: now,
    },
  });
  if (reclaimed.count > 0) {
    apiLogger.warn({ count: reclaimed.count }, "mirror-archive:stale-running-reclaimed");
    result.reclaimed = reclaimed.count;
  }

  // Expire archives past their TTL: object first, then the row, so a failed
  // delete leaves the row DONE and is retried next tick.
  const expiryBefore = new Date(now.getTime() - MIRROR_ARCHIVE_TTL_DAYS * 86_400_000);
  const expiring = await db.mirrorArchive.findMany({
    where: { status: "DONE", finishedAt: { lt: expiryBefore } },
    select: { id: true, key: true },
  });
  for (const row of expiring) {
    try {
      if (row.key) await getDrS3().send(new DeleteObjectCommand({ Bucket: DR_BUCKET_NAME, Key: row.key }));
      await db.mirrorArchive.update({ where: { id: row.id }, data: { status: "EXPIRED" } });
      result.expired += 1;
      apiLogger.info({ id: row.id, key: row.key }, "mirror-archive:expired");
    } catch (err) {
      apiLogger.error({ err, id: row.id, key: row.key }, "mirror-archive:expire-failed");
    }
  }

  // Claim the oldest request. The conditional write is what makes two
  // workers safe; a lost claim is silent because the winner logs.
  const next = await db.mirrorArchive.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    select: { id: true, requestedByEmail: true },
  });
  if (!next) return result;
  const claim = await db.mirrorArchive.updateMany({
    where: { id: next.id, status: "PENDING" },
    data: { status: "RUNNING", startedAt: now },
  });
  if (claim.count === 0) return result;

  apiLogger.info({ id: next.id }, "mirror-archive:build-start");
  try {
    const built = await buildMirrorArchive(next.id, now);
    await db.mirrorArchive.update({
      where: { id: next.id },
      data: { status: "DONE", key: built.key, fileCount: built.fileCount, sizeBytes: built.sizeBytes, finishedAt: new Date() },
    });
    result.built += 1;
    apiLogger.info(
      { id: next.id, key: built.key, fileCount: built.fileCount, sizeBytes: built.sizeBytes, durationMs: Date.now() - now.getTime() },
      "mirror-archive:build-done",
    );
  } catch (err) {
    result.failed += 1;
    const message = err instanceof Error ? err.message : String(err);
    apiLogger.error({ err, id: next.id }, "mirror-archive:build-failed");
    await db.mirrorArchive.update({
      where: { id: next.id },
      data: { status: "FAILED", error: message.slice(0, 500), finishedAt: new Date() },
    });
  }
  return result;
}
