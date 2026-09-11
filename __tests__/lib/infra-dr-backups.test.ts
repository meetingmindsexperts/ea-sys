/**
 * /admin/backups reads the DR bucket through two aws-ops functions. Pins:
 *  - the listing is the last DR_BACKUPS_WINDOW_HOURS only (owner: three days,
 *    never the whole retention), newest first, with size + instant, the
 *    prefix's total alongside, the prefix placeholder dropped, and a capped
 *    listing reported rather than hidden;
 *  - a failed listing degrades to status "error" + a warn log, never a throw;
 *  - ONLY a worker-built mirror archive is downloadable (a dump is not, by
 *    owner decision), and the presigner is never reached for anything else
 *    (the route checks too; this is the backstop);
 *  - the presigned GET is an attachment with a 5-minute life.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
const signMock = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class ListObjectsV2Command {
    readonly kind = "list";
    constructor(public input: { Bucket: string; Prefix: string; MaxKeys?: number }) {}
  }
  class HeadObjectCommand {
    readonly kind = "head";
    constructor(public input: { Bucket: string; Key: string }) {}
  }
  class GetObjectCommand {
    readonly kind = "get";
    constructor(public input: { Bucket: string; Key: string; ResponseContentDisposition?: string }) {}
  }
  class S3Client {
    send = sendMock;
  }
  return { S3Client, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: (...args: unknown[]) => signMock(...args),
}));
vi.mock("@/lib/db", () => ({ db: {} }));
const warnMock = vi.fn();
vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: (...args: unknown[]) => warnMock(...args), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/worker-jobs", () => ({ EXPECTED_JOBS: [] }));
vi.mock("@/lib/build-info", () => ({ getBuildInfo: () => ({}) }));
vi.mock("@/lib/admin-alert", () => ({ getAlertSilence: vi.fn() }));

import {
  DR_BACKUPS_WINDOW_HOURS,
  DR_DOWNLOAD_LINK_SECONDS,
  isDrBackupKind,
  isMirrorArchiveKey,
  listDrBackups,
  presignDrBackupDownload,
} from "@/lib/infra/aws-ops";

beforeEach(() => {
  sendMock.mockReset();
  signMock.mockReset();
  warnMock.mockReset();
});

const NOW = Date.parse("2026-09-11T06:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000);

describe("listDrBackups", () => {
  it("lists the last 72h of db/ newest first with size and instant, dropping the placeholder, and counts the rest", async () => {
    expect(DR_BACKUPS_WINDOW_HOURS).toBe(72);
    sendMock.mockResolvedValue({
      Contents: [
        { Key: "db/", Size: 0, LastModified: hoursAgo(500) },
        { Key: "db/2026/08/20-05-mumbai.dump", Size: 900_000, LastModified: hoursAgo(500) },
        { Key: "db/2026/09/10-05-mumbai.dump", Size: 1_100_000, LastModified: hoursAgo(25) },
        { Key: "db/2026/09/11-05-mumbai.dump", Size: 1_120_000, LastModified: hoursAgo(1) },
        { Key: "db/2026/09/08-06-mumbai.dump", Size: 1_000_000, LastModified: hoursAgo(72) },
        { Key: "db/2026/09/08-05-mumbai.dump", Size: 1_000_000, LastModified: hoursAgo(73) },
      ],
      IsTruncated: false,
    });
    const out = await listDrBackups("db", NOW);
    expect(out.status).toBe("ok");
    expect(out.prefix).toBe("db/");
    expect(out.windowHours).toBe(72);
    // Inside the window (72h is inclusive), newest first; the 73h and the
    // 500h objects are counted but not listed.
    expect(out.objects.map((o) => o.key)).toEqual([
      "db/2026/09/11-05-mumbai.dump",
      "db/2026/09/10-05-mumbai.dump",
      "db/2026/09/08-06-mumbai.dump",
    ]);
    expect(out.objects[0]).toEqual({ key: "db/2026/09/11-05-mumbai.dump", sizeBytes: 1_120_000, lastModified: hoursAgo(1).toISOString() });
    expect(out.totalObjects).toBe(5);
    expect(out.truncated).toBe(false);
    expect(sendMock.mock.calls[0][0].input.Prefix).toBe("db/");
  });

  it("lists uploads/ and env/ under their own prefixes", async () => {
    sendMock.mockResolvedValue({ Contents: [{ Key: "uploads/media/2026/09/a.jpg", Size: 4000, LastModified: hoursAgo(2) }], IsTruncated: false });
    const up = await listDrBackups("uploads", NOW);
    expect(sendMock.mock.calls[0][0].input.Prefix).toBe("uploads/");
    expect(up.objects).toHaveLength(1);
    sendMock.mockResolvedValue({ Contents: [{ Key: "env/2026-09-10.env", Size: 4000, LastModified: hoursAgo(5) }], IsTruncated: false });
    const env = await listDrBackups("env", NOW);
    expect(sendMock.mock.calls[1][0].input.Prefix).toBe("env/");
    expect(env.objects).toHaveLength(1);
  });

  it("degrades to status error with a warn log when S3 fails", async () => {
    sendMock.mockRejectedValue(Object.assign(new Error("AccessDenied"), { name: "AccessDenied" }));
    const out = await listDrBackups("db");
    expect(out.status).toBe("error");
    expect(out.objects).toEqual([]);
    expect(warnMock).toHaveBeenCalledWith(expect.objectContaining({ prefix: "db/" }), "infra:dr-backups-list-failed");
  });
});

describe("isDrBackupKind / isMirrorArchiveKey", () => {
  it("accepts only db, uploads and env", () => {
    expect(isDrBackupKind("db")).toBe(true);
    expect(isDrBackupKind("uploads")).toBe(true);
    expect(isDrBackupKind("env")).toBe(true);
    expect(isDrBackupKind("heartbeats")).toBe(false);
    expect(isDrBackupKind(undefined)).toBe(false);
  });

  it("accepts exactly the archive shape the mirror-archive worker writes", () => {
    expect(isMirrorArchiveKey("mirror-archives/2026-09-11-cmxyz.zip")).toBe(true);
  });

  it("refuses everything else: a database dump, env files, heartbeats, traversal, other names under the prefix", () => {
    for (const key of [
      "db/2026/09/10-05-mumbai.dump",
      "env/2026-09-10.env",
      "heartbeats/uploads-mirror",
      "mirror-archives/../db/x.dump",
      "mirror-archives/x.tar.gz",
      "mirror-archives/",
      "mirror-archives/2026-09-11-cmxyz.zip?x=1",
      "uploads/media/2026/09/x.jpg",
      "",
    ]) {
      expect(isMirrorArchiveKey(key), key).toBe(false);
    }
  });
});

describe("presignDrBackupDownload", () => {
  it("signs a 5-minute attachment GET on the DR bucket", async () => {
    signMock.mockResolvedValue("https://signed.example/archive");
    const url = await presignDrBackupDownload("mirror-archives/2026-09-11-cmxyz.zip");
    expect(url).toBe("https://signed.example/archive");
    const [, cmd, opts] = signMock.mock.calls[0];
    expect(cmd.input).toEqual({
      Bucket: "ea-sys-dr-singapore",
      Key: "mirror-archives/2026-09-11-cmxyz.zip",
      ResponseContentDisposition: 'attachment; filename="2026-09-11-cmxyz.zip"',
    });
    expect(opts).toEqual({ expiresIn: DR_DOWNLOAD_LINK_SECONDS });
    expect(DR_DOWNLOAD_LINK_SECONDS).toBe(300);
  });

  it("never reaches the presigner for a key that is not downloadable, a database dump included", async () => {
    await expect(presignDrBackupDownload("env/2026-09-10.env")).rejects.toThrow(/not a downloadable backup/);
    await expect(presignDrBackupDownload("db/2026/09/10-05-mumbai.dump")).rejects.toThrow(/not a downloadable backup/);
    expect(signMock).not.toHaveBeenCalled();
  });
});
