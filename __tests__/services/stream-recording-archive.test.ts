/**
 * Making the MP4 of a finished recording (Nov 25, 2026; step 4). Storage,
 * ffmpeg and the buffer are stand-ins; the timing rules are real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { StorageErrorStub } = vi.hoisted(() => ({
  StorageErrorStub: class extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  },
}));
const h = vi.hoisted(() => ({
  db: {
    streamRecording: { findFirst: vi.fn(), updateMany: vi.fn() },
    streamRecordingSegment: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  storage: { readStoredFile: vi.fn(), writeStoredFileStream: vi.fn(), deleteStoredFile: vi.fn() },
  piecesLeft: vi.fn(),
  join: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/logger", () => ({ apiLogger: h.logger }));
vi.mock("@/lib/storage", () => ({ ...h.storage, StorageError: StorageErrorStub }));
vi.mock("@/services/stream-recording-shipping", () => ({ piecesLeftToShip: h.piecesLeft }));
vi.mock("@/lib/webinar/recording-mp4", async (orig) => ({
  ...(await orig<typeof import("@/lib/webinar/recording-mp4")>()),
  joinPiecesToMp4: h.join,
}));

import { Mp4JoinError } from "@/lib/webinar/recording-mp4";
import {
  ARCHIVE_GIVE_UP_MS,
  ARCHIVE_MIN_WAIT_MS,
  ARCHIVE_WAIT_MAX_MS,
  buildRecordingArchive,
} from "@/services/stream-recording-archive";

const at = { eventId: "ev1", sessionId: "s1" };
const NOW = new Date("2026-12-01T12:00:00Z");
const PREFIX = "/uploads/recordings/ev1/s1/r1";
const finishedAgo = (ms: number) => ({ id: "r1", organizationId: "org1", storagePrefix: PREFIX, finishedAt: new Date(NOW.getTime() - ms) });
const PIECES = [{ storedPath: `${PREFIX}/1.ts` }, { storedPath: `${PREFIX}/2.ts` }];

beforeEach(() => {
  vi.clearAllMocks();
  h.db.streamRecording.findFirst.mockResolvedValue(finishedAgo(ARCHIVE_MIN_WAIT_MS));
  h.db.streamRecording.updateMany.mockResolvedValue({ count: 1 });
  h.db.streamRecordingSegment.findMany.mockResolvedValue(PIECES);
  h.db.auditLog.create.mockResolvedValue({});
  h.piecesLeft.mockResolvedValue(0);
  h.join.mockResolvedValue({ bytes: 5_000_000 });
});

describe("buildRecordingArchive", () => {
  it("joins every piece in order into recording.mp4 beside them, and marks the recording READY", async () => {
    expect(await buildRecordingArchive(at, NOW)).toBe("ready");
    const call = h.join.mock.calls[0][0];
    expect(call.count).toBe(2);
    const signal = new AbortController().signal;
    await call.readPiece(1, signal);
    expect(h.storage.readStoredFile).toHaveBeenCalledWith(`${PREFIX}/2.ts`, "/uploads/recordings/", { signal });
    await call.write("mp4-bytes", signal);
    expect(h.storage.writeStoredFileStream).toHaveBeenCalledWith("mp4-bytes", `${PREFIX}/recording.mp4`, "/uploads/recordings/", "video/mp4", { signal });
    expect(h.db.streamRecording.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", status: "FINISHING" },
      data: { status: "READY", archivePath: `${PREFIX}/recording.mp4`, archiveBytes: BigInt(5_000_000), error: null },
    });
    expect(h.db.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "STREAM_RECORDING_READY", organizationId: "org1" });
  });

  it("waits for the last pieces to settle and ship before joining", async () => {
    h.db.streamRecording.findFirst.mockResolvedValue(finishedAgo(ARCHIVE_MIN_WAIT_MS - 1));
    expect(await buildRecordingArchive(at, NOW)).toBe("waiting");
    h.db.streamRecording.findFirst.mockResolvedValue(finishedAgo(ARCHIVE_MIN_WAIT_MS));
    h.piecesLeft.mockResolvedValue(3);
    expect(await buildRecordingArchive(at, NOW)).toBe("waiting");
    expect(h.join).not.toHaveBeenCalled();
  });

  it("past half an hour, joins what arrived and says pieces are missing", async () => {
    h.db.streamRecording.findFirst.mockResolvedValue(finishedAgo(ARCHIVE_WAIT_MAX_MS));
    h.piecesLeft.mockResolvedValue(3);
    expect(await buildRecordingArchive(at, NOW)).toBe("ready");
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ left: 3 }), "stream-recording-archive:joined-without-some-pieces");
  });

  it("joins by time alone when the buffer cannot be named (no partner stream any more)", async () => {
    h.piecesLeft.mockResolvedValue(null);
    expect(await buildRecordingArchive(at, NOW)).toBe("ready");
  });

  it("nothing recorded: READY with no file", async () => {
    h.db.streamRecordingSegment.findMany.mockResolvedValue([]);
    expect(await buildRecordingArchive(at, NOW)).toBe("empty");
    expect(h.db.streamRecording.updateMany.mock.calls[0][0].data).toEqual({ status: "READY", archivePath: null, archiveBytes: null, error: null });
    expect(h.join).not.toHaveBeenCalled();
  });

  it("a storage failure removes the half-written file and is tried again", async () => {
    h.join.mockRejectedValue(new Mp4JoinError("bucket refused", "write"));
    expect(await buildRecordingArchive(at, NOW)).toBe("retry");
    expect(h.storage.deleteStoredFile).toHaveBeenCalledWith(`${PREFIX}/recording.mp4`, "/uploads/recordings/");
    expect(h.db.streamRecording.updateMany).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ kind: "write", giveUp: false }), "stream-recording-archive:join-failed");
  });

  it("ffmpeg's own refusal fails it at once, with words staff can read and no path", async () => {
    h.join.mockRejectedValue(new Mp4JoinError("ffmpeg stopped with code 1: /uploads/recordings/x", "ffmpeg"));
    expect(await buildRecordingArchive(at, NOW)).toBe("failed");
    const data = h.db.streamRecording.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe("FAILED");
    expect(data.error).toBe("The recording's file could not be made from its pieces.");
    expect(h.db.auditLog.create.mock.calls[0][0].data.action).toBe("STREAM_RECORDING_FAILED");
  });

  // Review of 593a7f31a: a piece whose file is gone cannot come back, so it is left out, not retried for six hours.
  it("a piece missing from storage is left out and logged; any other read failure still fails the read", async () => {
    let readPiece: ((i: number, s: AbortSignal) => Promise<Buffer>) | null = null;
    h.join.mockImplementation(async (o: { readPiece: typeof readPiece }) => {
      readPiece = o.readPiece;
      expect((await o.readPiece!(0, new AbortController().signal)).length).toBe(0);
      return { bytes: 1 };
    });
    h.storage.readStoredFile.mockRejectedValueOnce(new StorageErrorStub("not-found"));
    expect(await buildRecordingArchive(at, NOW)).toBe("ready");
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ missing: 1, of: 2 }), "stream-recording-archive:pieces-missing-from-storage");
    h.storage.readStoredFile.mockRejectedValueOnce(new Error("network"));
    await expect(readPiece!(1, new AbortController().signal)).rejects.toThrow("network");
  });

  it("ffmpeg killed from outside is tried again, not failed", async () => {
    h.join.mockRejectedValue(new Mp4JoinError("ffmpeg was stopped by SIGKILL", "killed"));
    expect(await buildRecordingArchive(at, NOW)).toBe("retry");
  });

  it("a storage failure still failing six hours after the finish gives up", async () => {
    h.db.streamRecording.findFirst.mockResolvedValue(finishedAgo(ARCHIVE_GIVE_UP_MS));
    h.join.mockRejectedValue(new Error("network"));
    expect(await buildRecordingArchive(at, NOW)).toBe("failed");
  });

  it("deleted while the file was being made: the file is removed and nothing is brought back", async () => {
    h.db.streamRecording.updateMany.mockResolvedValue({ count: 0 });
    expect(await buildRecordingArchive(at, NOW)).toBe("skipped");
    expect(h.storage.deleteStoredFile).toHaveBeenCalledWith(`${PREFIX}/recording.mp4`, "/uploads/recordings/");
  });

  it("only a FINISHING recording is looked at", async () => {
    h.db.streamRecording.findFirst.mockResolvedValue(null);
    expect(await buildRecordingArchive(at, NOW)).toBe("skipped");
    expect(h.db.streamRecording.findFirst.mock.calls[0][0].where).toMatchObject({ status: "FINISHING" });
  });
});
