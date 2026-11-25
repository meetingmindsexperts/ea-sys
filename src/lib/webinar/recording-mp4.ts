/**
 * Joining a recording's pieces into one MP4 (Nov 25, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md §4.4, step 4). The pieces are MPEG-TS
 * as the stream server wrote them; ffmpeg copies them into an MP4 without
 * re-encoding, reading from a pipe and writing to a pipe, so nothing touches
 * the box's disk: each piece is read from storage in turn and fed in, and the
 * MP4 goes back to storage as it comes out.
 *
 * The MP4 is the "fragmented" kind (`frag_keyframe+empty_moov`), the only kind
 * that can be written front to back without seeking back to the start. Proven
 * in step 0 (§2.1): it plays and seeks in a browser across a pause and a
 * reconnect, and a pause is closed up, not frozen through.
 *
 * ffmpeg is in the worker image only (D8); this module runs in the worker.
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** The exact command proven in step 0. */
export const FFMPEG_ARGS = [
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
  "-movflags",
  "frag_keyframe+empty_moov+default_base_moof",
  "-f",
  "mp4",
  "pipe:1",
] as const;

/**
 * Longest a join may take. A copy of a two hour webinar is about a minute of
 * one CPU; most of the time is reading and writing storage. Past this,
 * something is stuck: ffmpeg is stopped and the join fails, to be tried again.
 */
export const JOIN_TIMEOUT_MS = 20 * 60 * 1000;

/** How much of ffmpeg's error output is kept for the log and the recording's error. */
const STDERR_KEEP = 2000;

export type SpawnFfmpeg = (args: readonly string[]) => ChildProcessWithoutNullStreams;

const defaultSpawn: SpawnFfmpeg = (args) => nodeSpawn("ffmpeg", [...args], { stdio: ["pipe", "pipe", "pipe"] });

export class Mp4JoinError extends Error {
  constructor(
    message: string,
    /** "ffmpeg": ffmpeg itself refused (missing, or the pieces are not video); anything else is storage or a timeout. */
    readonly kind: "ffmpeg" | "read" | "write" | "timeout",
  ) {
    super(message);
    this.name = "Mp4JoinError";
  }
}

/**
 * Feed `count` pieces, read one at a time by `readPiece`, through ffmpeg, and
 * hand its output to `write` as it comes. Resolves with what `write` answered
 * once ffmpeg has exited cleanly and the write is complete. Rejects with an
 * Mp4JoinError otherwise, and stops ffmpeg first, so a failed write never
 * leaves it blocked on a full pipe.
 */
export async function joinPiecesToMp4<T>(opts: {
  count: number;
  readPiece: (index: number) => Promise<Buffer>;
  write: (mp4: AsyncIterable<Buffer>) => Promise<T>;
  spawn?: SpawnFfmpeg;
  timeoutMs?: number;
}): Promise<T> {
  const child = (opts.spawn ?? defaultSpawn)(FFMPEG_ARGS);
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString("utf8")).slice(-STDERR_KEEP);
  });

  let failure: Mp4JoinError | null = null;
  const fail = (err: Mp4JoinError) => {
    if (!failure) failure = err;
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  };

  const exited = new Promise<number | null>((resolve) => {
    child.on("error", (err) => {
      // Spawning failed: no ffmpeg on this machine.
      fail(new Mp4JoinError(`ffmpeg could not be started: ${err.message}`, "ffmpeg"));
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });

  const timer = setTimeout(() => fail(new Mp4JoinError("Joining the pieces took too long", "timeout")), opts.timeoutMs ?? JOIN_TIMEOUT_MS);

  const feed = (async () => {
    // A closed stdin (ffmpeg stopped) is reported by the exit, not here.
    child.stdin.on("error", () => undefined);
    for (let i = 0; i < opts.count; i++) {
      if (failure) return;
      let piece: Buffer;
      try {
        piece = await opts.readPiece(i);
      } catch (err) {
        fail(new Mp4JoinError(`A piece could not be read: ${(err as Error).message}`, "read"));
        return;
      }
      if (!child.stdin.write(piece)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            child.stdin.off("drain", done);
            child.stdin.off("close", done);
            resolve();
          };
          child.stdin.on("drain", done);
          child.stdin.on("close", done);
        });
      }
    }
    child.stdin.end();
  })();

  const written = opts.write(child.stdout as AsyncIterable<Buffer>).catch((err: Error) => {
    fail(new Mp4JoinError(`The MP4 could not be written: ${err.message}`, "write"));
    return null;
  });

  try {
    const [, result, code] = await Promise.all([feed, written, exited]);
    if (failure) throw failure;
    if (code !== 0) throw new Mp4JoinError(`ffmpeg stopped with code ${code}: ${stderr.trim() || "no message"}`, "ffmpeg");
    return result as T;
  } finally {
    clearTimeout(timer);
  }
}
