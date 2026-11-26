/**
 * Joining a recording's pieces into one MP4 (Nov 25, 2026; step 4). With the
 * real ffmpeg where this machine has it (the proof that the command makes a
 * plain MP4 that states its length: Nov 26, 2026, a fragmented one showed 4
 * seconds of 12 minutes in QuickTime), and with a stand-in for every way it can
 * fail: a failure must stop ffmpeg, never leave it blocked, and never leave
 * its temporary file behind.
 */
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ffmpegArgs, joinPiecesToMp4, Mp4JoinError, removeLeftoverJoinFolders, type SpawnFfmpeg } from "@/lib/webinar/recording-mp4";

const PIECE = readFileSync(path.join(__dirname, "../fixtures/stream-recording/piece.mpegts"));
const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0;

async function collect(src: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of src) parts.push(c);
  return Buffer.concat(parts);
}

/** A fresh folder for a join's temporary folder, so a test can see it was removed. */
const freshTmp = () => mkdtempSync(path.join(tmpdir(), "mp4-test-"));

/** The length an MP4 states in its movie header (mvhd), in seconds; 0 when it states none. */
function statedSeconds(mp4: Buffer): number {
  const at = mp4.indexOf(Buffer.from("mvhd"));
  if (at < 0) return 0;
  const version = mp4[at + 4];
  if (version === 1) return Number(mp4.readBigUInt64BE(at + 4 + 4 + 16 + 4)) / mp4.readUInt32BE(at + 4 + 4 + 16);
  return mp4.readUInt32BE(at + 4 + 4 + 8 + 4) / mp4.readUInt32BE(at + 4 + 4 + 8);
}

/** A stand-in ffmpeg: what it does with its input is up to the test. */
function fakeFfmpeg(behave: (child: FakeChild) => void): { spawn: SpawnFfmpeg; child: () => FakeChild } {
  let made: FakeChild | null = null;
  const spawn: SpawnFfmpeg = (args) => {
    made = new FakeChild(args[args.length - 1]);
    queueMicrotask(() => behave(made!));
    return made as never;
  };
  return { spawn, child: () => made! };
}

class FakeChild extends EventEmitter {
  constructor(readonly outPath: string) {
    super();
  }
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  // As a real kill: the child's stdin is destroyed, its stdout ends, and it closes by signal.
  kill = vi.fn(() => {
    this.killed = true;
    this.stdin.destroy();
    this.stdout.end();
    this.exit(null, "SIGKILL");
    return true;
  });
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? -1;
    setImmediate(() => this.emit("close", code, signal));
  }
}

describe("joinPiecesToMp4 with the real ffmpeg", () => {
  it.skipIf(!HAS_FFMPEG)("makes a plain MP4 that states its length, index first, and leaves no file behind", async () => {
    const tmp = freshTmp();
    const mp4 = await joinPiecesToMp4({ count: 2, readPiece: async () => PIECE, write: collect, tmpDir: tmp });
    expect(mp4.length).toBeGreaterThan(PIECE.length / 2);
    expect(mp4.subarray(4, 8).toString("latin1")).toBe("ftyp");
    // Not fragmented, and the index (moov) before the video (mdat), so a player knows the length at once.
    expect(mp4.includes(Buffer.from("moof"))).toBe(false);
    expect(mp4.indexOf(Buffer.from("moov"))).toBeLessThan(mp4.indexOf(Buffer.from("mdat")));
    expect(statedSeconds(mp4)).toBeGreaterThan(0);
    expect(readdirSync(tmp)).toEqual([]);
  });

  // Review of 593a7f31a (BLOCKER): ffmpeg stopped while a piece was being read, the write then waited for room
  // that never came, and the join never settled, wedging the job.
  it.skipIf(!HAS_FFMPEG)("settles when ffmpeg is stopped while a piece is being read", async () => {
    const slowRead = (i: number, signal: AbortSignal) =>
      new Promise<Buffer>((resolve) => {
        const t = setTimeout(() => resolve(PIECE), i === 0 ? 0 : 500);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve(PIECE);
        });
      });
    const began = Date.now();
    const err = await joinPiecesToMp4({ count: 3, readPiece: slowRead, write: collect, timeoutMs: 200 }).catch((e) => e);
    expect((err as Mp4JoinError).kind).toBe("timeout");
    expect(Date.now() - began).toBeLessThan(3000);
  });

  it.skipIf(!HAS_FFMPEG)("refuses bytes that are not video, as ffmpeg's refusal", async () => {
    const err = await joinPiecesToMp4({ count: 1, readPiece: async () => Buffer.alloc(4096, 7), write: collect }).catch((e) => e);
    expect(err).toBeInstanceOf(Mp4JoinError);
    expect((err as Mp4JoinError).kind).toBe("ffmpeg");
  });
});

describe("joinPiecesToMp4 failures", () => {
  it("asks for a plain MP4 with its index at the front, written to the file it is given", () => {
    const args = ffmpegArgs("/tmp/x/recording.mp4");
    expect(args).toContain("+faststart");
    expect(args.join(" ")).not.toMatch(/frag_keyframe|empty_moov|pipe:1/);
    expect(args.slice(-4)).toEqual(["-f", "mp4", "-y", "/tmp/x/recording.mp4"]);
  });

  /** ffmpeg that writes `body` to its output file once its input ends. */
  const writesFile = (body: string, seen?: string[]) => (c: FakeChild) => {
    c.stdin.on("data", (d: Buffer) => seen?.push(d.toString()));
    c.stdin.on("end", () => {
      writeFileSync(c.outPath, body);
      c.stdout.end();
      c.exit(0);
    });
  };

  it("feeds the pieces in order, sends the finished file, answers what the write answered, and removes the file", async () => {
    const seen: string[] = [];
    const tmp = freshTmp();
    const fake = fakeFfmpeg(writesFile("MP4", seen));
    const out = await joinPiecesToMp4({ count: 3, readPiece: async (i) => Buffer.from(`p${i}`), write: collect, spawn: fake.spawn, tmpDir: tmp });
    expect(seen.join("")).toBe("p0p1p2");
    expect(out.toString()).toBe("MP4");
    expect(fake.child().outPath.startsWith(tmp)).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("the file is sent only after ffmpeg has finished it", async () => {
    let exitedFirst = false;
    const fake = fakeFfmpeg(writesFile("MP4"));
    await joinPiecesToMp4({
      count: 1,
      readPiece: async () => Buffer.from("x"),
      write: async (mp4) => {
        exitedFirst = fake.child().exitCode === 0;
        return collect(mp4);
      },
      spawn: fake.spawn,
    });
    expect(exitedFirst).toBe(true);
  });

  it("a failed write is a write failure, and the file is removed", async () => {
    const tmp = freshTmp();
    const fake = fakeFfmpeg(writesFile("MP4"));
    const err = await joinPiecesToMp4({
      count: 1,
      readPiece: async () => Buffer.from("x"),
      write: async () => {
        throw new Error("bucket refused");
      },
      spawn: fake.spawn,
      tmpDir: tmp,
    }).catch((e) => e);
    expect((err as Mp4JoinError).kind).toBe("write");
    expect((err as Error).message).toMatch(/bucket refused/);
    expect(readdirSync(tmp)).toEqual([]);
  });

  // Review of 392f9a92f (HIGH): a write refused before it reads (the upload's first call) left the file open,
  // so its disk space stayed taken after the folder was removed.
  it("the file handed to the write is always closed, even when the write never reads it", async () => {
    let given: { destroyed: boolean } | null = null;
    const fake = fakeFfmpeg(writesFile("MP4"));
    await joinPiecesToMp4({
      count: 1,
      readPiece: async () => Buffer.from("x"),
      write: async (mp4) => {
        given = mp4 as unknown as { destroyed: boolean };
        throw new Error("CreateMultipartUpload refused");
      },
      spawn: fake.spawn,
    }).catch(() => undefined);
    expect(given!.destroyed).toBe(true);
  });

  it("a full or failing disk stops ffmpeg as a write failure, tried again, not ffmpeg's verdict on the pieces", async () => {
    const fake = fakeFfmpeg((c) => {
      c.stdin.resume();
      c.stdin.on("end", () => {
        c.stderr.write("Error writing trailer: No space left on device");
        c.stdout.end();
        c.exit(1);
      });
    });
    const err = await joinPiecesToMp4({ count: 1, readPiece: async () => Buffer.from("x"), write: collect, spawn: fake.spawn }).catch((e) => e);
    expect((err as Mp4JoinError).kind).toBe("write");
  });

  it("a write that stalls past the time allowed is a timeout, and its signal is aborted", async () => {
    let given: AbortSignal | null = null;
    const fake = fakeFfmpeg(writesFile("MP4"));
    const err = await joinPiecesToMp4({
      count: 1,
      readPiece: async () => Buffer.from("x"),
      write: (_mp4, signal) => {
        given = signal;
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      },
      spawn: fake.spawn,
      timeoutMs: 30,
    }).catch((e) => e);
    expect((err as Mp4JoinError).kind).toBe("timeout");
    expect(given!.aborted).toBe(true);
  });

  it("a piece that cannot be read stops ffmpeg and is a read failure", async () => {
    const fake = fakeFfmpeg(() => undefined);
    const err = await joinPiecesToMp4({
      count: 2,
      readPiece: async () => {
        throw new Error("no such object");
      },
      write: collect,
      spawn: fake.spawn,
    }).catch((e) => e);
    expect((err as Mp4JoinError).kind).toBe("read");
    expect(fake.child().kill).toHaveBeenCalled();
  });

  it("ffmpeg ending with an error code is ffmpeg's failure, with its message", async () => {
    const fake = fakeFfmpeg((c) => {
      c.stdin.resume();
      c.stdin.on("end", () => {
        c.stderr.write("Invalid data found");
        c.stdout.end();
        c.exit(1);
      });
    });
    const tmp = freshTmp();
    const err = await joinPiecesToMp4({ count: 1, readPiece: async () => Buffer.from("x"), write: collect, spawn: fake.spawn, tmpDir: tmp }).catch((e) => e);
    expect((err as Mp4JoinError).kind).toBe("ffmpeg");
    expect((err as Error).message).toMatch(/code 1: Invalid data found/);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("no ffmpeg on the machine is ffmpeg's failure", async () => {
    const fake = fakeFfmpeg((c) => {
      c.emit("error", new Error("spawn ffmpeg ENOENT"));
      c.stdout.end();
    });
    const err = await joinPiecesToMp4({ count: 1, readPiece: async () => Buffer.from("x"), write: collect, spawn: fake.spawn }).catch((e) => e);
    expect((err as Mp4JoinError).kind).toBe("ffmpeg");
  });

  it("a write left waiting for room ends when ffmpeg goes, instead of waiting for ever", async () => {
    // ffmpeg reads nothing (its input fills) and is then stopped by the timeout.
    const fake = fakeFfmpeg(() => undefined);
    const big = Buffer.alloc(1024 * 1024);
    const err = await joinPiecesToMp4({ count: 5, readPiece: async () => big, write: collect, spawn: fake.spawn, timeoutMs: 30 }).catch((e) => e);
    expect((err as Mp4JoinError).kind).toBe("timeout");
  });

  it("every failure aborts the signal the reads and the write were given, so a stalled storage call stops", async () => {
    const fake = fakeFfmpeg(() => undefined);
    let given: AbortSignal | null = null;
    const err = await joinPiecesToMp4({
      count: 1,
      readPiece: (_i, signal) => {
        given = signal;
        return new Promise<Buffer>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      },
      write: collect,
      spawn: fake.spawn,
      timeoutMs: 20,
    }).catch((e) => e);
    expect((err as Mp4JoinError).kind).toBe("timeout");
    expect(given!.aborted).toBe(true);
  });

  it("ffmpeg stopped from outside (a signal) is worth retrying, not ffmpeg's verdict", async () => {
    const fake = fakeFfmpeg((c) => {
      c.stdin.resume();
      c.stdin.on("end", () => {
        c.stdout.end();
        c.exit(null, "SIGKILL");
      });
    });
    const err = await joinPiecesToMp4({ count: 1, readPiece: async () => Buffer.from("x"), write: collect, spawn: fake.spawn }).catch((e) => e);
    expect((err as Mp4JoinError).kind).toBe("killed");
  });

  it("a join that takes too long is stopped", async () => {
    const fake = fakeFfmpeg((c) => c.stdin.resume());
    const err = await joinPiecesToMp4({ count: 1, readPiece: async () => Buffer.from("x"), write: collect, spawn: fake.spawn, timeoutMs: 20 }).catch((e) => e);
    expect((err as Mp4JoinError).kind).toBe("timeout");
    expect(fake.child().kill).toHaveBeenCalled();
  });
});

describe("removeLeftoverJoinFolders", () => {
  it("removes only a join's own folders, and only old ones", async () => {
    const dir = freshTmp();
    const now = Date.now();
    const old = new Date(now - 3 * 60 * 60_000);
    for (const name of ["ea-recording-old", "ea-recording-new", "someone-else"]) mkdirSync(path.join(dir, name));
    utimesSync(path.join(dir, "ea-recording-old"), old, old);
    utimesSync(path.join(dir, "someone-else"), old, old);
    expect(await removeLeftoverJoinFolders(now, dir)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["ea-recording-new", "someone-else"]);
  });

  it("a folder it cannot list is not an error", async () => {
    expect(await removeLeftoverJoinFolders(Date.now(), path.join(tmpdir(), "no-such-folder-here"))).toBe(0);
  });
});
