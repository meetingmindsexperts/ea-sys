/**
 * Joining a recording's pieces into one MP4 (Nov 25, 2026; step 4). With the
 * real ffmpeg where this machine has it (the proof that the command makes an
 * MP4 from a real piece, through pipes only), and with a stand-in for every
 * way it can fail: a failed write must stop ffmpeg, never leave it blocked.
 */
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { FFMPEG_ARGS, joinPiecesToMp4, Mp4JoinError, type SpawnFfmpeg } from "@/lib/webinar/recording-mp4";

const PIECE = readFileSync(path.join(__dirname, "../fixtures/stream-recording/piece.mpegts"));
const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0;

async function collect(src: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of src) parts.push(c);
  return Buffer.concat(parts);
}

/** A stand-in ffmpeg: what it does with its input is up to the test. */
function fakeFfmpeg(behave: (child: FakeChild) => void): { spawn: SpawnFfmpeg; child: () => FakeChild } {
  let made: FakeChild | null = null;
  const spawn: SpawnFfmpeg = () => {
    made = new FakeChild();
    queueMicrotask(() => behave(made!));
    return made as never;
  };
  return { spawn, child: () => made! };
}

class FakeChild extends EventEmitter {
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
  it.skipIf(!HAS_FFMPEG)("makes a fragmented MP4 from a real piece, through pipes only", async () => {
    const mp4 = await joinPiecesToMp4({ count: 1, readPiece: async () => PIECE, write: collect });
    expect(mp4.length).toBeGreaterThan(PIECE.length / 2);
    // An MP4 begins with its ftyp box; a fragmented one carries a moof.
    expect(mp4.subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect(mp4.includes(Buffer.from("moof"))).toBe(true);
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
  it("runs the command proven in step 0", () => {
    expect(FFMPEG_ARGS).toContain("frag_keyframe+empty_moov+default_base_moof");
    expect(FFMPEG_ARGS.slice(-2)).toEqual(["mp4", "pipe:1"]);
  });

  it("feeds the pieces in order and answers what the write answered", async () => {
    const seen: string[] = [];
    const fake = fakeFfmpeg((c) => {
      c.stdin.on("data", (d: Buffer) => seen.push(d.toString()));
      c.stdin.on("end", () => {
        c.stdout.end(Buffer.from("MP4"));
        c.exit(0);
      });
    });
    const out = await joinPiecesToMp4({ count: 3, readPiece: async (i) => Buffer.from(`p${i}`), write: collect, spawn: fake.spawn });
    expect(seen.join("")).toBe("p0p1p2");
    expect(out.toString()).toBe("MP4");
  });

  it("a failed write stops ffmpeg and is a write failure", async () => {
    const fake = fakeFfmpeg(() => undefined);
    const err = await joinPiecesToMp4({
      count: 1,
      readPiece: async () => Buffer.from("x"),
      write: async () => {
        throw new Error("bucket refused");
      },
      spawn: fake.spawn,
    }).catch((e) => e);
    expect((err as Mp4JoinError).kind).toBe("write");
    expect(fake.child().kill).toHaveBeenCalled();
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
    const err = await joinPiecesToMp4({ count: 1, readPiece: async () => Buffer.from("x"), write: collect, spawn: fake.spawn }).catch((e) => e);
    expect((err as Mp4JoinError).kind).toBe("ffmpeg");
    expect((err as Error).message).toMatch(/code 1: Invalid data found/);
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
