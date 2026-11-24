/**
 * Where the stream server's recording buffer is, and whether the disk has room
 * for it (Nov 24, 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md §3).
 *
 * The buffer normally holds about a minute of video, but with the worker down
 * it holds up to two hours (mediamtx.yml recordDeleteAfter): about 2.2 GB for
 * one stream at 2.5 Mbps, and a full disk stops the whole site. So a recording
 * is not started on a disk with less than RECORDING_MIN_FREE_BYTES free.
 *
 * Asked from the app's container, which does not mount the buffer: on the box
 * every container's root and the buffer folder are on the one disk, so the
 * free space `/` reports is the buffer's. STREAM_RECORDING_DISK_PATH names
 * another place to ask, for a server laid out differently.
 */
import { statfs } from "node:fs/promises";
import { apiLogger } from "@/lib/logger";

export const RECORDING_MIN_FREE_BYTES = 6 * 1024 ** 3;

/** The buffer folder as the worker sees it (docker-compose.prod.yml mounts the box's ./recordings here). */
export function recordingsDir(): string {
  return process.env.STREAM_RECORDINGS_DIR || "/recordings";
}

/** Free bytes on the disk the buffer lives on, or null when it could not be read. */
export async function freeDiskBytes(): Promise<number | null> {
  const path = process.env.STREAM_RECORDING_DISK_PATH || "/";
  try {
    const stats = await statfs(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (err) {
    apiLogger.warn({ err, path }, "stream-recording:disk-space-unreadable");
    return null;
  }
}
