/**
 * The mirror-archive worker: claims one PENDING request, zips every object
 * under uploads/ through archiver (real, on fake streams), uploads the zip and
 * marks the row DONE. Pins the parts that would fail silently in production:
 *  - the zip really contains every mirrored file under its stored path (the
 *    uploaded bytes are unzipped with jszip and the entry names checked);
 *  - a capped listing never ships a partial archive (FAILED, no upload);
 *  - a lost claim builds nothing (two workers, one request);
 *  - a build the worker died in is reclaimed, and DONE archives past the TTL
 *    lose their object and become EXPIRED;
 *  - an S3 failure lands as FAILED with the message, logged at error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const { send, listDrPrefix, dbm, logs } = vi.hoisted(() => ({
  send: vi.fn(),
  listDrPrefix: vi.fn(),
  dbm: { updateMany: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  logs: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: { mirrorArchive: dbm } }));
vi.mock("@/lib/logger", () => ({ apiLogger: logs }));
vi.mock("@/lib/infra/aws-ops", () => ({
  getDrS3: () => ({ send }),
  DR_BUCKET_NAME: "ea-sys-dr-singapore",
  DR_MIRROR_PREFIX: "uploads/",
  MIRROR_ARCHIVE_PREFIX: "mirror-archives/",
  listDrPrefix: (...a: unknown[]) => listDrPrefix(...a),
}));

import {
  MIRROR_ARCHIVE_STALE_RUNNING_MINUTES,
  MIRROR_ARCHIVE_TTL_DAYS,
  runMirrorArchiveTick,
} from "@/lib/infra/mirror-archive-worker";

const NOW = new Date("2026-09-11T06:00:00Z");
const FILES: Record<string, string> = {
  "uploads/media/2026/09/a.jpg": "jpeg-bytes-a",
  "uploads/photos/2026/08/b.png": "png-bytes-b",
  "uploads/reimbursements/ev1/c.pdf": "pdf-bytes-c",
};

/** Collect a Node readable into a Buffer. */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

let uploaded: { key: string; body: Buffer; contentLength?: number } | null;
let deleted: string[];

beforeEach(() => {
  vi.clearAllMocks();
  uploaded = null;
  deleted = [];
  listDrPrefix.mockResolvedValue({
    objects: Object.entries(FILES).map(([key, v]) => ({ key, sizeBytes: v.length })),
    truncated: false,
  });
  send.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof GetObjectCommand) {
      const body = FILES[cmd.input.Key as string];
      if (body === undefined) throw new Error(`NoSuchKey ${cmd.input.Key}`);
      return { Body: Readable.from([Buffer.from(body)]) };
    }
    if (cmd instanceof PutObjectCommand) {
      uploaded = { key: cmd.input.Key as string, body: await collect(cmd.input.Body as Readable), contentLength: cmd.input.ContentLength };
      return {};
    }
    if (cmd instanceof DeleteObjectCommand) {
      deleted.push(cmd.input.Key as string);
      return {};
    }
    throw new Error("unexpected command");
  });
  // Housekeeping defaults: nothing stale, nothing expiring.
  dbm.updateMany.mockResolvedValue({ count: 0 });
  dbm.findMany.mockResolvedValue([]);
  dbm.findFirst.mockResolvedValue(null);
  dbm.update.mockResolvedValue({});
});

describe("runMirrorArchiveTick", () => {
  it("does nothing when no archive was requested", async () => {
    const out = await runMirrorArchiveTick(NOW);
    expect(out).toEqual({ built: 0, failed: 0, expired: 0, reclaimed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("claims the request, zips every mirrored file under its stored path, uploads it and marks DONE", async () => {
    dbm.findFirst.mockResolvedValue({ id: "req1", requestedByEmail: "x@y" });
    dbm.updateMany.mockImplementation(async (args: { where: { status?: string; id?: string } }) =>
      args.where.id === "req1" && args.where.status === "PENDING" ? { count: 1 } : { count: 0 },
    );
    const out = await runMirrorArchiveTick(NOW);
    expect(out.built).toBe(1);
    expect(uploaded).not.toBeNull();
    expect(uploaded!.key).toBe("mirror-archives/2026-09-11-req1.zip");
    expect(uploaded!.contentLength).toBe(uploaded!.body.length);
    const zip = await JSZip.loadAsync(uploaded!.body);
    expect(Object.keys(zip.files).sort()).toEqual([
      "media/2026/09/a.jpg",
      "photos/2026/08/b.png",
      "reimbursements/ev1/c.pdf",
    ]);
    expect(await zip.file("reimbursements/ev1/c.pdf")!.async("string")).toBe("pdf-bytes-c");
    expect(dbm.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "req1" },
        data: expect.objectContaining({ status: "DONE", key: "mirror-archives/2026-09-11-req1.zip", fileCount: 3, sizeBytes: uploaded!.body.length }),
      }),
    );
    expect(logs.info).toHaveBeenCalledWith(expect.objectContaining({ id: "req1", fileCount: 3 }), "mirror-archive:build-done");
  });

  it("builds nothing when the claim is lost to another worker", async () => {
    dbm.findFirst.mockResolvedValue({ id: "req1", requestedByEmail: null });
    dbm.updateMany.mockResolvedValue({ count: 0 });
    const out = await runMirrorArchiveTick(NOW);
    expect(out.built).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(dbm.update).not.toHaveBeenCalled();
  });

  it("refuses to ship a partial archive when the listing was capped", async () => {
    dbm.findFirst.mockResolvedValue({ id: "req1", requestedByEmail: null });
    dbm.updateMany.mockImplementation(async (args: { where: { id?: string } }) => (args.where.id === "req1" ? { count: 1 } : { count: 0 }));
    listDrPrefix.mockResolvedValue({ objects: [], truncated: true });
    const out = await runMirrorArchiveTick(NOW);
    expect(out.failed).toBe(1);
    expect(uploaded).toBeNull();
    expect(dbm.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", error: expect.stringMatching(/partial archive/) }) }),
    );
    expect(logs.error).toHaveBeenCalledWith(expect.objectContaining({ id: "req1" }), "mirror-archive:build-failed");
  });

  it("lands an S3 read failure as FAILED with the message, and uploads nothing", async () => {
    dbm.findFirst.mockResolvedValue({ id: "req1", requestedByEmail: null });
    dbm.updateMany.mockImplementation(async (args: { where: { id?: string } }) => (args.where.id === "req1" ? { count: 1 } : { count: 0 }));
    listDrPrefix.mockResolvedValue({ objects: [{ key: "uploads/media/missing.jpg", sizeBytes: 1 }], truncated: false });
    const out = await runMirrorArchiveTick(NOW);
    expect(out.failed).toBe(1);
    expect(uploaded).toBeNull();
    expect(dbm.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", error: expect.stringMatching(/NoSuchKey/) }) }),
    );
  });

  it("reclaims a build the worker died in, and expires DONE archives past the TTL (object first, then the row)", async () => {
    dbm.updateMany.mockImplementation(async (args: { where: { status?: string; startedAt?: { lt: Date } } }) => {
      if (args.where.status === "RUNNING") {
        expect(args.where.startedAt?.lt.toISOString()).toBe(new Date(NOW.getTime() - MIRROR_ARCHIVE_STALE_RUNNING_MINUTES * 60_000).toISOString());
        return { count: 1 };
      }
      return { count: 0 };
    });
    dbm.findMany.mockImplementation(async (args: { where: { finishedAt?: { lt: Date } } }) => {
      expect(args.where.finishedAt?.lt.toISOString()).toBe(new Date(NOW.getTime() - MIRROR_ARCHIVE_TTL_DAYS * 86_400_000).toISOString());
      return [{ id: "old1", key: "mirror-archives/2026-09-01-old1.zip" }];
    });
    const out = await runMirrorArchiveTick(NOW);
    expect(out.reclaimed).toBe(1);
    expect(out.expired).toBe(1);
    expect(deleted).toEqual(["mirror-archives/2026-09-01-old1.zip"]);
    expect(dbm.update).toHaveBeenCalledWith({ where: { id: "old1" }, data: { status: "EXPIRED" } });
    expect(logs.warn).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }), "mirror-archive:stale-running-reclaimed");
  });

  it("leaves a DONE row in place when its object cannot be deleted, so it is retried", async () => {
    dbm.findMany.mockResolvedValue([{ id: "old1", key: "mirror-archives/2026-09-01-old1.zip" }]);
    send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DeleteObjectCommand) throw new Error("AccessDenied");
      throw new Error("unexpected");
    });
    const out = await runMirrorArchiveTick(NOW);
    expect(out.expired).toBe(0);
    expect(dbm.update).not.toHaveBeenCalled();
    expect(logs.error).toHaveBeenCalledWith(expect.objectContaining({ id: "old1" }), "mirror-archive:expire-failed");
  });
});
