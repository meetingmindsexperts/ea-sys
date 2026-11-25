/**
 * Shipping a recording's pieces to S3 (Nov 24, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md §4.2, step 2). The folder, storage,
 * database and stream server are stand-ins; the piece read from the folder is
 * a real one MediaMTX wrote (the fixture), so its length is really measured.
 *
 * What matters most: pieces go strictly in order and a failure stops the run;
 * a crash anywhere is safe on the next run; a piece recorded while the
 * organisers said not to is deleted and never shipped; the key is never kept.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const PIECE = readFileSync(path.join(process.cwd(), "__tests__/fixtures/stream-recording/piece.mpegts"));

const { fsMock, mockDb, tx, uploadSpy, deleteSpy, streamSpy, arrivingSpy, mockLogger } = vi.hoisted(() => {
  const tx = {
    streamRecordingSegment: { findFirst: vi.fn(), create: vi.fn() },
    streamRecording: { update: vi.fn() },
  };
  return {
    fsMock: { readdir: vi.fn(), stat: vi.fn(), readFile: vi.fn() },
    tx,
    mockDb: { streamRecording: { findFirst: vi.fn() }, streamRecordingSegment: { findFirst: vi.fn(), findMany: vi.fn() } },
    uploadSpy: vi.fn(),
    deleteSpy: vi.fn(),
    streamSpy: vi.fn(),
    arrivingSpy: vi.fn(),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});
vi.mock("node:fs/promises", () => fsMock);
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (t: unknown) => unknown) => fn(tx) }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/storage", () => ({ uploadFile: uploadSpy }));
vi.mock("@/lib/webinar/mediamtx-control", () => ({ deleteRecordingPiece: deleteSpy }));
vi.mock("@/lib/webinar/session-stream", () => ({ sessionStream: streamSpy }));
vi.mock("@/lib/webinar/stream-probe", () => ({ isStreamArriving: arrivingSpy }));

import { logSafe, piecesLeftToShip, resetShippingReports, shipRecordingPieces } from "@/services/stream-recording-shipping";

const KEY = "0123456789abcdef0123456789abcdef";
const FOLDER = `/recordings/live/${KEY}`;
const PREFIX = "/uploads/recordings/ev1/s1/r1";
const NOW = new Date("2026-11-24T09:30:00Z");
const at = { eventId: "ev1", sessionId: "s1" };
const opts = (extra: Partial<{ deadline: number; clock: () => number }> = {}) => ({ now: NOW, deadline: Infinity, clock: () => 0, ...extra });

/** Pieces in the folder: name and how long ago it last changed. */
let folder: { name: string; ageMs: number }[] = [];
const recording = (extra: Record<string, unknown> = {}) => ({
  id: "r1",
  organizationId: "org1",
  status: "RECORDING",
  storagePrefix: PREFIX,
  startedAt: new Date("2026-11-24T09:00:00Z"),
  lastStartedAt: new Date("2026-11-24T09:00:00Z"),
  finishedAt: null,
  // As stored: JSON.
  pauses: [],
  ...extra,
});
/** Names the database already has rows for. */
let shippedAlready: string[] = [];
// Three pieces, six seconds apart, as the stream server names them (Unix time and microseconds).
const P1 = "1795512296-718063.ts"; // 09:24:56
const P2 = "1795512302-614902.ts"; // 09:25:02
const P3 = "1795512308-519732.ts"; // 09:25:08

beforeEach(() => {
  vi.clearAllMocks();
  resetShippingReports();
  folder = [
    { name: P1, ageMs: 60_000 },
    { name: P2, ageMs: 50_000 },
    { name: P3, ageMs: 1_000 },
  ];
  fsMock.readdir.mockImplementation(async () => folder.map((f) => f.name));
  fsMock.stat.mockImplementation(async (p: string) => {
    const f = folder.find((x) => p.endsWith(x.name));
    if (!f) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return { size: PIECE.length, mtime: new Date(NOW.getTime() - f.ageMs) };
  });
  fsMock.readFile.mockResolvedValue(PIECE);
  mockDb.streamRecording.findFirst.mockResolvedValue(recording());
  shippedAlready = [];
  mockDb.streamRecordingSegment.findFirst.mockResolvedValue(null);
  mockDb.streamRecordingSegment.findMany.mockImplementation(async ({ where }: { where: { sourceName: { in: string[] } } }) =>
    where.sourceName.in.filter((n) => shippedAlready.includes(n)).map((sourceName) => ({ sourceName })),
  );
  tx.streamRecordingSegment.findFirst.mockResolvedValue(null);
  tx.streamRecordingSegment.create.mockResolvedValue({});
  tx.streamRecording.update.mockResolvedValue({});
  uploadSpy.mockImplementation(async (_buf: Buffer, name: string, _type: string, sub: string) => `/uploads/${sub}/${name}`);
  deleteSpy.mockResolvedValue({ ok: true, changed: true });
  streamSpy.mockResolvedValue({ source: "external", streamKey: KEY, streamStatus: "ACTIVE" });
  // Not live by default, so a lone old piece counts as finished; the tests about a live stream say so.
  arrivingSpy.mockResolvedValue(false);
  process.env.STREAM_RECORDINGS_DIR = "/recordings";
});

describe("shipRecordingPieces", () => {
  it("ships every finished piece, oldest first, and leaves the one still being written", async () => {
    const report = await shipRecordingPieces(at, opts());
    expect(report).toEqual({ shipped: 2, discarded: 0, waiting: 0 });
    expect(fsMock.readdir).toHaveBeenCalledWith(FOLDER);
    expect(uploadSpy.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      [P1, "video/mp2t", "recordings/ev1/s1/r1"],
      [P2, "video/mp2t", "recordings/ev1/s1/r1"],
    ]);
    expect(deleteSpy.mock.calls).toEqual([
      [KEY, "2026-11-24T09:24:56.718063Z"],
      [KEY, "2026-11-24T09:25:02.614902Z"],
    ]);
  });

  it("writes each piece's row with its measured length, its place and its tenant, and adds it to the totals", async () => {
    await shipRecordingPieces(at, opts());
    expect(tx.streamRecordingSegment.create.mock.calls[0][0].data).toEqual({
      recordingId: "r1",
      organizationId: "org1",
      seq: 0,
      sourceName: P1,
      startedAt: new Date("2026-11-24T09:24:56.718Z"),
      durationMs: 6105,
      bytes: PIECE.length,
      storedPath: `${PREFIX}/${P1}`,
      afterBreak: false,
    });
    expect(tx.streamRecording.update.mock.calls[0][0]).toEqual({
      where: { id: "r1" },
      data: { segmentCount: { increment: 1 }, totalBytes: { increment: BigInt(PIECE.length) }, durationMs: { increment: 6105 } },
    });
  });

  it("numbers on from the last piece, and marks a break when the new one does not follow on", async () => {
    // The last shipped piece began at 09:24:40 and played 6.1 s: P1 at 09:24:56 starts ten seconds after it ended.
    tx.streamRecordingSegment.findFirst.mockResolvedValue({ seq: 41, startedAt: new Date("2026-11-24T09:24:40Z"), durationMs: 6100 });
    folder = [{ name: P1, ageMs: 60_000 }];
    await shipRecordingPieces(at, opts());
    expect(tx.streamRecordingSegment.create.mock.calls[0][0].data).toMatchObject({ seq: 42, afterBreak: true });
  });

  it("uploads, writes the row, and only then deletes the piece from the buffer", async () => {
    folder = [{ name: P1, ageMs: 60_000 }];
    await shipRecordingPieces(at, opts());
    const order = [uploadSpy, tx.streamRecordingSegment.create, deleteSpy].map((m) => m.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("a piece already shipped by a run that stopped before its delete is only deleted", async () => {
    shippedAlready = [P1];
    const report = await shipRecordingPieces(at, opts());
    expect(report.shipped).toBe(1);
    expect(uploadSpy.mock.calls.map((c) => c[1])).toEqual([P2]);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
  });

  it("a row written twice (two runs, or a retry) is the outcome wanted, not a failure", async () => {
    folder = [{ name: P1, ageMs: 60_000 }];
    tx.streamRecordingSegment.create.mockImplementation(async () => {
      shippedAlready = [P1];
      throw Object.assign(new Error("unique"), { code: "P2002" });
    });
    expect(await shipRecordingPieces(at, opts())).toMatchObject({ shipped: 1 });
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  // Review of 9592d2151: a clash on the NUMBER means the piece was not recorded, and deleting it would lose it.
  it("a unique clash that is not this piece's row is a failure: the piece is kept, not deleted", async () => {
    folder = [{ name: P1, ageMs: 60_000 }];
    tx.streamRecordingSegment.create.mockRejectedValue(Object.assign(new Error("unique seq"), { code: "P2002" }));
    expect(await shipRecordingPieces(at, opts())).toEqual({ shipped: 0, discarded: 0, waiting: 1 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.anything(), "stream-recording-ship:piece-failed");
  });

  it("stops at the first piece that fails, so no later piece is numbered ahead of it", async () => {
    uploadSpy.mockRejectedValueOnce(new Error("S3 down"));
    const report = await shipRecordingPieces(at, opts());
    expect(report).toEqual({ shipped: 0, discarded: 0, waiting: 2 });
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }), "stream-recording-ship:piece-failed");
  });

  // A failed delete must not stop the shipping: with the stream server's API down for two hours, its own
  // clean-up would delete every piece never shipped.
  it("a piece the stream server would not delete is kept for the next run, and shipping carries on", async () => {
    deleteSpy.mockResolvedValue({ ok: false, code: "UNREACHABLE" });
    const report = await shipRecordingPieces(at, opts());
    expect(report).toEqual({ shipped: 2, discarded: 0, waiting: 0 });
    expect(uploadSpy).toHaveBeenCalledTimes(2);
    // Deletes stop at the first failure, until the next run.
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    const said = mockLogger.warn.mock.calls.filter(([, msg]) => msg === "stream-recording-ship:piece-not-deleted");
    expect(said).toHaveLength(1);
    expect(said[0][0]).toMatchObject({ code: "UNREACHABLE", pending: 2 });
  });

  // Review of 9592d2151 (HIGH): a backlog of slow deletes at the head of the list took each run's whole time.
  it("a backlog of shipped pieces whose deletes keep timing out never stops new pieces being shipped", async () => {
    // Forty shipped-but-undeleted pieces ahead of two new ones; each delete takes three seconds and fails.
    const backlog = Array.from({ length: 40 }, (_, i) => ({ name: `17955120${String(i).padStart(2, "0")}-000000.ts`, ageMs: 600_000 }));
    folder = [...backlog, { name: P1, ageMs: 60_000 }, { name: P2, ageMs: 50_000 }];
    shippedAlready = backlog.map((b) => b.name);
    mockDb.streamRecording.findFirst.mockResolvedValue(recording({ startedAt: new Date("2026-11-24T08:00:00Z") }));
    let t = 0;
    deleteSpy.mockImplementation(async () => {
      t += 3000;
      return { ok: false, code: "UNREACHABLE" };
    });
    const report = await shipRecordingPieces(at, opts({ deadline: 20_000, clock: () => t }));
    expect(report.shipped).toBe(2);
    expect(uploadSpy.mock.calls.map((c) => c[1])).toEqual([P1, P2]);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  it("on the next run a piece already shipped is not uploaded again, only its delete is tried", async () => {
    shippedAlready = [P1, P2];
    const report = await shipRecordingPieces(at, opts());
    expect(report).toEqual({ shipped: 0, discarded: 0, waiting: 0 });
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalledTimes(2);
  });

  it("a piece begun after a Stop is deleted and never shipped", async () => {
    mockDb.streamRecording.findFirst.mockResolvedValue(recording({ status: "PAUSED", pauses: [{ from: "2026-11-24T09:25:00.000Z", to: null }] }));
    folder = [
      { name: P1, ageMs: 60_000 },
      { name: P2, ageMs: 50_000 },
    ];
    const report = await shipRecordingPieces(at, opts());
    expect(report).toEqual({ shipped: 1, discarded: 1, waiting: 0 });
    expect(uploadSpy.mock.calls.map((c) => c[1])).toEqual([P1]);
    expect(deleteSpy.mock.calls.map((c) => c[1])).toEqual(["2026-11-24T09:24:56.718063Z", "2026-11-24T09:25:02.614902Z"]);
  });

  // Review of 9592d2151 (MED): an earlier pause's footage, still in the folder, became wanted after a later Stop.
  it("a piece from an earlier pause stays unwanted after a later Start and Stop", async () => {
    mockDb.streamRecording.findFirst.mockResolvedValue(
      recording({
        status: "PAUSED",
        pauses: [
          { from: "2026-11-24T09:24:58.000Z", to: "2026-11-24T09:25:05.000Z" },
          { from: "2026-11-24T09:26:00.000Z", to: null },
        ],
      }),
    );
    // P2 (09:25:02) is inside the first pause; P1 and P3 are not.
    folder = [
      { name: P1, ageMs: 60_000 },
      { name: P2, ageMs: 50_000 },
      { name: P3, ageMs: 40_000 },
    ];
    expect(await shipRecordingPieces(at, opts())).toEqual({ shipped: 2, discarded: 1, waiting: 0 });
    expect(uploadSpy.mock.calls.map((c) => c[1])).toEqual([P1, P3]);
  });

  it("a stopped recording's last piece is shipped once it has settled", async () => {
    mockDb.streamRecording.findFirst.mockResolvedValue(recording({ status: "PAUSED", pauses: [{ from: "2026-11-24T09:25:10.000Z", to: null }] }));
    folder = [{ name: P3, ageMs: 30_000 }];
    expect(await shipRecordingPieces(at, opts())).toMatchObject({ shipped: 1 });
  });

  it("a leftover older than the recording is deleted, never shipped as its first piece", async () => {
    mockDb.streamRecording.findFirst.mockResolvedValue(recording({ startedAt: new Date("2026-11-24T09:25:00Z") }));
    expect(await shipRecordingPieces(at, opts())).toEqual({ shipped: 1, discarded: 1, waiting: 0 });
    expect(uploadSpy.mock.calls.map((c) => c[1])).toEqual([P2]);
  });

  it("never numbers a piece behind one already shipped: it is dropped and said", async () => {
    mockDb.streamRecordingSegment.findFirst.mockResolvedValue({ seq: 7, startedAt: new Date("2026-11-24T09:25:00Z"), durationMs: 6000 });
    expect(await shipRecordingPieces(at, opts())).toEqual({ shipped: 1, discarded: 1, waiting: 0 });
    expect(uploadSpy.mock.calls.map((c) => c[1])).toEqual([P2]);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.anything(), "stream-recording-ship:piece-out-of-order");
  });

  it("while the stream is live and recording, the newest piece is never taken, however still it looks", async () => {
    arrivingSpy.mockResolvedValue(true);
    folder = [
      { name: P1, ageMs: 60_000 },
      { name: P2, ageMs: 50_000 },
    ];
    expect(await shipRecordingPieces(at, opts())).toMatchObject({ shipped: 1 });
    expect(uploadSpy.mock.calls.map((c) => c[1])).toEqual([P1]);
  });

  it("stops starting new pieces at the deadline, and says how many wait", async () => {
    let t = 0;
    const report = await shipRecordingPieces(at, opts({ deadline: 1, clock: () => t++ }));
    expect(report).toEqual({ shipped: 1, discarded: 0, waiting: 1 });
  });

  it("nothing to do with no recording that is shipping, or no partner stream", async () => {
    mockDb.streamRecording.findFirst.mockResolvedValue(null);
    expect(await shipRecordingPieces(at, opts())).toEqual({ shipped: 0, discarded: 0, waiting: 0 });
    mockDb.streamRecording.findFirst.mockResolvedValue(recording());
    streamSpy.mockResolvedValue({ source: "zoom", streamKey: KEY, streamStatus: "ACTIVE" });
    expect(await shipRecordingPieces(at, opts())).toEqual({ shipped: 0, discarded: 0, waiting: 0 });
    expect(fsMock.readdir).not.toHaveBeenCalled();
  });

  it("asks only for recordings that are still shipping", async () => {
    await shipRecordingPieces(at, opts());
    expect(mockDb.streamRecording.findFirst.mock.calls[0][0].where).toEqual({
      sessionId: "s1",
      eventId: "ev1",
      status: { in: ["RECORDING", "PAUSED", "FINISHING"] },
    });
  });

  it("no folder yet (no piece written) is not a problem", async () => {
    fsMock.readdir.mockRejectedValue(Object.assign(new Error("no dir"), { code: "ENOENT" }));
    mockDb.streamRecording.findFirst.mockResolvedValue(recording({ lastStartedAt: new Date(NOW.getTime() - 30_000) }));
    expect(await shipRecordingPieces(at, opts())).toEqual({ shipped: 0, discarded: 0, waiting: 0 });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("a folder that cannot be read is said", async () => {
    fsMock.readdir.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    await shipRecordingPieces(at, opts());
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.anything(), "stream-recording-ship:folder-unreadable");
  });

  // Review of 9592d2151: one such piece held up the rest for two hours.
  it("a piece far too large is dropped, not left to hold up the ones after it, and said once", async () => {
    folder = [
      { name: P1, ageMs: 60_000 },
      { name: P2, ageMs: 50_000 },
    ];
    fsMock.stat.mockImplementation(async (p: string) => ({
      size: p.endsWith(P1) ? 200 * 1024 * 1024 : PIECE.length,
      mtime: new Date(NOW.getTime() - 60_000),
    }));
    expect(await shipRecordingPieces(at, opts())).toEqual({ shipped: 1, discarded: 1, waiting: 0 });
    expect(uploadSpy.mock.calls.map((c) => c[1])).toEqual([P2]);
    await shipRecordingPieces(at, opts());
    expect(mockLogger.error.mock.calls.filter(([, m]) => m === "stream-recording-ship:piece-too-large")).toHaveLength(1);
  });

  it("a piece whose length cannot be read is shipped all the same, timed by the gap to the next piece, and said", async () => {
    fsMock.readFile.mockResolvedValueOnce(Buffer.from("not video"));
    expect(await shipRecordingPieces(at, opts())).toMatchObject({ shipped: 2 });
    // P1 at 09:24:56.718, P2 at 09:25:02.614.
    expect(tx.streamRecordingSegment.create.mock.calls[0][0].data.durationMs).toBe(5896);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 5896 }), "stream-recording-ship:piece-length-unreadable");
  });

  it("refuses a stored path outside the recording's folder", async () => {
    uploadSpy.mockResolvedValue("/uploads/photos/elsewhere.ts");
    folder = [{ name: P1, ageMs: 60_000 }];
    expect(await shipRecordingPieces(at, opts())).toMatchObject({ shipped: 0 });
    expect(tx.streamRecordingSegment.create).not.toHaveBeenCalled();
  });

  it("pieces piling up for over two minutes is an error, said once in ten minutes", async () => {
    uploadSpy.mockRejectedValue(new Error("S3 down"));
    folder = [
      { name: P1, ageMs: 180_000 },
      { name: P2, ageMs: 170_000 },
    ];
    await shipRecordingPieces(at, opts());
    await shipRecordingPieces(at, opts());
    const said = mockLogger.error.mock.calls.filter(([, msg]) => msg === "stream-recording-ship:pieces-waiting");
    expect(said).toHaveLength(1);
    expect(said[0][0]).toMatchObject({ waiting: 2, oldestSeconds: 180 });
  });

  it("recording but nothing new for two minutes while the stream is live: the stream server is not recording, said", async () => {
    arrivingSpy.mockResolvedValue(true);
    folder = [{ name: P1, ageMs: 200_000 }];
    mockDb.streamRecording.findFirst.mockResolvedValue(recording({ lastStartedAt: new Date(NOW.getTime() - 600_000) }));
    await shipRecordingPieces(at, opts());
    expect(arrivingSpy).toHaveBeenCalledWith(KEY);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }), "stream-recording-ship:live-but-not-recording");
  });

  it("...but not when the stream itself is not live, nor when recording was just started", async () => {
    folder = [];
    mockDb.streamRecording.findFirst.mockResolvedValue(recording({ lastStartedAt: new Date(NOW.getTime() - 600_000) }));
    arrivingSpy.mockResolvedValue(false);
    await shipRecordingPieces(at, opts());
    mockDb.streamRecording.findFirst.mockResolvedValue(recording({ lastStartedAt: new Date(NOW.getTime() - 30_000) }));
    arrivingSpy.mockResolvedValue(true);
    await shipRecordingPieces(at, opts());
    expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.anything(), "stream-recording-ship:live-but-not-recording");
  });

  // Review of 9592d2151: Node's file errors repeat their path, and the folder is named by the key.
  it("a file error is logged by its code, never with its path (which holds the stream key)", async () => {
    const fsError = (syscall: string) =>
      Object.assign(new Error(`EACCES: permission denied, ${syscall} '${FOLDER}/${P1}'`), { code: "EACCES", syscall, path: `${FOLDER}/${P1}` });
    fsMock.readFile.mockRejectedValue(fsError("open"));
    await shipRecordingPieces(at, opts());
    fsMock.readdir.mockRejectedValue(fsError("scandir"));
    await shipRecordingPieces(at, opts());
    fsMock.readdir.mockImplementation(async () => folder.map((f) => f.name));
    fsMock.stat.mockRejectedValue(fsError("stat"));
    await shipRecordingPieces(at, opts());
    const logged = JSON.stringify([mockLogger.warn.mock.calls, mockLogger.error.mock.calls]);
    expect(logged).not.toContain(KEY);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ err: { code: "EACCES", syscall: "open" } }), "stream-recording-ship:piece-failed");
  });

  it("logSafe keeps a non-file error whole", () => {
    const e = new Error("S3 down");
    expect(logSafe(e)).toBe(e);
    expect(logSafe(Object.assign(new Error(`x '${FOLDER}'`), { code: "ENOSPC", syscall: "write" }))).toEqual({ code: "ENOSPC", syscall: "write" });
  });

  it("never logs or stores the stream key", async () => {
    uploadSpy.mockRejectedValueOnce(new Error("S3 down"));
    await shipRecordingPieces(at, opts());
    await shipRecordingPieces(at, opts());
    const everything = JSON.stringify([
      mockLogger.info.mock.calls,
      mockLogger.warn.mock.calls,
      mockLogger.error.mock.calls.map(([obj, msg]) => [{ ...obj, err: String(obj.err) }, msg]),
      tx.streamRecordingSegment.create.mock.calls,
      tx.streamRecording.update.mock.calls.map(([a]) => ({ ...a, data: { ...a.data, totalBytes: "n" } })),
    ]);
    expect(everything).not.toContain(KEY);
  });
});

// Step 4 (Nov 25, 2026): the MP4 is joined only once nothing the recording wants is left in the buffer.
describe("piecesLeftToShip", () => {
  const finished = recording({ status: "FINISHING", finishedAt: new Date("2026-11-24T09:25:05Z") });

  it("counts wanted pieces with no row, settled or not; a piece after the finish is not wanted", async () => {
    mockDb.streamRecording.findFirst.mockResolvedValue(finished);
    // P1 and P2 began before the finish; P3 (09:25:08) after it.
    expect(await piecesLeftToShip(at)).toBe(2);
    shippedAlready = [P1];
    expect(await piecesLeftToShip(at)).toBe(1);
    shippedAlready = [P1, P2];
    expect(await piecesLeftToShip(at)).toBe(0);
  });

  it("null when the buffer cannot be named (no partner stream any more), zero with no recording", async () => {
    mockDb.streamRecording.findFirst.mockResolvedValue(finished);
    streamSpy.mockResolvedValue(null);
    expect(await piecesLeftToShip(at)).toBeNull();
    mockDb.streamRecording.findFirst.mockResolvedValue(null);
    expect(await piecesLeftToShip(at)).toBe(0);
  });
});
