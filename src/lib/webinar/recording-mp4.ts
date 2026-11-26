/**
 * Joining a recording's pieces into one MP4 (Nov 25, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md §4.4, step 4). The pieces are MPEG-TS
 * as the stream server wrote them; ffmpeg copies them into an MP4 without
 * re-encoding: each piece is read from storage in turn and fed in through a
 * pipe, the MP4 is written to a file in a temporary folder of its own, and that
 * file is then sent to storage and removed.
 *
 * A PLAIN MP4 with its index at the front (`+faststart`), since the rehearsal of
 * Nov 26, 2026. Until then it was the "fragmented" kind (`frag_keyframe+
 * empty_moov`), written front to back through a pipe so nothing touched the
 * disk; but a fragmented MP4 written that way states no length, and QuickTime
 * and the Mac's Finder then showed the first fragment's 4 seconds of a 12
 * minute recording. A plain MP4 needs a file ffmpeg can go back into, so the
 * disk is touched for as long as the join takes: about the size of the
 * recording, roughly 1.2 GB an hour at 2.5 Mbps, checked before the join
 * (`archiveDiskShortBy` in stream-recording-archive.ts). A pause is closed up
 * in the plain kind as in the fragmented one (checked with ffmpeg that day).
 *
 * ffmpeg is in the worker image only (D8); this module runs in the worker.
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** The command: a copy, the audio put in the form MP4 needs, the index moved to the front once written. */
export function ffmpegArgs(outPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "mpegts",
    "-i",
    "pipe:0",
    "-c",
    "copy",
    // ADTS AAC (as MPEG-TS carries it) to the form MP4 needs.
    "-bsf:a",
    "aac_adtstoasc",
    // The index (moov) at the front, so a player knows the length and can start before the whole file arrives.
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    "-y",
    outPath,
  ];
}

/**
 * Longest a join may take, sending the file to storage included. A copy of a
 * two hour webinar is about a minute of one CPU; most of the time is reading
 * and writing storage. Past this, something is stuck: ffmpeg is stopped and
 * the join fails, to be tried again.
 */
export const JOIN_TIMEOUT_MS = 20 * 60 * 1000;

/** The temporary folders' name, so ones a stopped worker left behind can be found and removed. */
const TMP_PREFIX = "ea-recording-";
/** A temporary folder older than this belongs to no join still running. */
const LEFTOVER_AGE_MS = 2 * JOIN_TIMEOUT_MS;

/** How much of ffmpeg's error output is kept for the log and the recording's error. */
const STDERR_KEEP = 2000;

export type SpawnFfmpeg = (args: readonly string[]) => ChildProcessWithoutNullStreams;

const defaultSpawn: SpawnFfmpeg = (args) => nodeSpawn("ffmpeg", [...args], { stdio: ["pipe", "pipe", "pipe"] });

export class Mp4JoinError extends Error {
  constructor(
    message: string,
    /** "ffmpeg": ffmpeg itself refused (missing, or the pieces are not video); anything else is storage, a timeout or a kill, worth retrying. */
    readonly kind: "ffmpeg" | "read" | "write" | "timeout" | "killed",
  ) {
    super(message);
    this.name = "Mp4JoinError";
  }
}

/**
 * Remove temporary folders a join left behind when the worker was stopped in
 * the middle of one (a deploy recreates the container, which clears them too).
 * Never throws: a folder that cannot be removed now is tried on the next join.
 */
export async function removeLeftoverJoinFolders(now = Date.now(), dir = tmpdir()): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.startsWith(TMP_PREFIX));
  } catch {
    return 0;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      if (now - (await stat(full)).mtimeMs < LEFTOVER_AGE_MS) continue;
      await rm(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Gone already, or not ours to remove: left for the next join.
    }
  }
  return removed;
}

/**
 * Feed `count` pieces, read one at a time by `readPiece`, through ffmpeg into
 * an MP4 file, then hand that file to `write`. Resolves with what `write`
 * answered once ffmpeg has exited cleanly and the write is complete. Rejects
 * with an Mp4JoinError otherwise, and stops ffmpeg first. The temporary
 * folder is removed whatever happens.
 *
 * NOTHING HERE MAY WAIT ON SOMETHING THAT CAN NO LONGER HAPPEN (review of
 * 593a7f31a, BLOCKER): a write to the stdin of an ffmpeg that has stopped
 * answers "full" and never drains, so every wait for room also ends when
 * ffmpeg exits. And `signal` is aborted on any failure, including the
 * timeout, so a storage call that has stalled is stopped too: the caller
 * passes it to its reads and its write.
 */
export async function joinPiecesToMp4<T>(opts: {
  count: number;
  readPiece: (index: number, signal: AbortSignal) => Promise<Buffer>;
  write: (mp4: AsyncIterable<Buffer>, signal: AbortSignal) => Promise<T>;
  spawn?: SpawnFfmpeg;
  timeoutMs?: number;
  /** Where the temporary folder is made; the system's own by default. */
  tmpDir?: string;
}): Promise<T> {
  const folder = await mkdtemp(path.join(opts.tmpDir ?? tmpdir(), TMP_PREFIX));
  try {
    return await runJoin(opts, path.join(folder, "recording.mp4"));
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runJoin<T>(
  opts: {
    count: number;
    readPiece: (index: number, signal: AbortSignal) => Promise<Buffer>;
    write: (mp4: AsyncIterable<Buffer>, signal: AbortSignal) => Promise<T>;
    spawn?: SpawnFfmpeg;
    timeoutMs?: number;
  },
  outPath: string,
): Promise<T> {
  const child = (opts.spawn ?? defaultSpawn)(ffmpegArgs(outPath));
  const abort = new AbortController();
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString("utf8")).slice(-STDERR_KEEP);
  });
  // Nothing comes out of stdout (the MP4 goes to the file); drained so it can never fill.
  child.stdout.resume();

  let failure: Mp4JoinError | null = null;
  const fail = (err: Mp4JoinError) => {
    if (!failure) failure = err;
    abort.abort();
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  };

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", (err) => {
      // Spawning failed: no ffmpeg on this machine.
      fail(new Mp4JoinError(`ffmpeg could not be started: ${err.message}`, "ffmpeg"));
      resolve({ code: null, signal: null });
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  const timer = setTimeout(() => fail(new Mp4JoinError("Joining the pieces took too long", "timeout")), opts.timeoutMs ?? JOIN_TIMEOUT_MS);

  /** Room in ffmpeg's input again, or ffmpeg gone: whichever comes first. */
  const roomOrExit = async () => {
    let onDrain: (() => void) | null = null;
    const drained = new Promise<void>((resolve) => {
      onDrain = resolve;
      child.stdin.once("drain", resolve);
    });
    await Promise.race([drained, exited]);
    if (onDrain) child.stdin.off("drain", onDrain);
  };

  const stdinGone = () => child.stdin.destroyed || child.stdin.writableEnded;

  const feed = (async () => {
    // A closed stdin (ffmpeg stopped) is reported by the exit, not here.
    child.stdin.on("error", () => undefined);
    for (let i = 0; i < opts.count; i++) {
      if (failure || stdinGone()) return;
      let piece: Buffer;
      try {
        piece = await opts.readPiece(i, abort.signal);
      } catch (err) {
        fail(new Mp4JoinError(`A piece could not be read: ${(err as Error).message}`, "read"));
        return;
      }
      // ffmpeg may have stopped while the piece was read.
      if (failure || stdinGone()) return;
      if (!child.stdin.write(piece)) await roomOrExit();
    }
    if (!stdinGone()) child.stdin.end();
  })();

  try {
    const [, exit] = await Promise.all([feed, exited]);
    if (failure) throw failure;
    // Stopped from outside (the out-of-memory killer, a worker shutting down): worth trying again, not ffmpeg's verdict.
    if (exit.signal) throw new Mp4JoinError(`ffmpeg was stopped by ${exit.signal}`, "killed");
    if (exit.code !== 0) throw new Mp4JoinError(`ffmpeg stopped with code ${exit.code}: ${stderr.trim() || "no message"}`, "ffmpeg");

    // The file is complete only now: the index is written last and moved to the front.
    let result: T;
    try {
      result = await opts.write(createReadStream(outPath), abort.signal);
    } catch (err) {
      // A timeout during the write aborted it; that is the failure to report.
      throw failure ?? new Mp4JoinError(`The MP4 could not be written: ${(err as Error).message}`, "write");
    }
    if (failure) throw failure;
    return result;
  } finally {
    clearTimeout(timer);
  }
}
