/**
 * Large files written as they are made, and many deleted at once (Nov 25,
 * 2026; a partner stream recording's MP4 and its pieces). The AWS SDK is
 * mocked; what is asserted is what we ask of S3: parts of the right size in
 * order, an abort when anything fails, a thousand keys per delete.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@aws-sdk/client-s3", () => {
  const cmd = (kind: string) =>
    class {
      readonly kind = kind;
      constructor(public input: Record<string, unknown>) {}
    };
  return {
    S3Client: class {
      send = sendMock;
    },
    CreateMultipartUploadCommand: cmd("create"),
    UploadPartCommand: cmd("part"),
    CompleteMultipartUploadCommand: cmd("complete"),
    AbortMultipartUploadCommand: cmd("abort"),
    DeleteObjectsCommand: cmd("deleteMany"),
  };
});

async function loadS3() {
  const mod = await import("@/lib/storage-s3");
  mod.resetS3Client();
  return mod;
}

async function* chunks(...sizes: number[]) {
  for (const n of sizes) yield Buffer.alloc(n, 1);
}

const kinds = () => sendMock.mock.calls.map(([c]) => (c as { kind: string }).kind);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("S3_UPLOADS_BUCKET", "ea-sys-uploads");
  vi.stubEnv("S3_UPLOADS_REGION", "ap-south-1");
  sendMock.mockImplementation(async (c: { kind: string; input: { PartNumber?: number } }) => {
    if (c.kind === "create") return { UploadId: "up1" };
    if (c.kind === "part") return { ETag: `"e${c.input.PartNumber}"` };
    return {};
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("s3UploadStream", () => {
  it("sends 16 MB parts in order, the small rest last, then completes with every part", async () => {
    const { s3UploadStream, S3_PART_BYTES } = await loadS3();
    const mb = 1024 * 1024;
    const out = await s3UploadStream(chunks(10 * mb, 10 * mb, 3 * mb), "recordings/ev1/s1/r1/recording.mp4", "video/mp4");
    expect(out.bytes).toBe(23 * mb);
    expect(kinds()).toEqual(["create", "part", "part", "complete"]);
    const parts = sendMock.mock.calls.filter(([c]) => c.kind === "part").map(([c]) => c.input);
    expect((parts[0].Body as Buffer).length).toBe(20 * mb);
    expect((parts[0].Body as Buffer).length).toBeGreaterThanOrEqual(S3_PART_BYTES);
    expect((parts[1].Body as Buffer).length).toBe(3 * mb);
    expect(sendMock.mock.calls.at(-1)![0].input).toMatchObject({
      Bucket: "ea-sys-uploads",
      Key: "recordings/ev1/s1/r1/recording.mp4",
      UploadId: "up1",
      MultipartUpload: { Parts: [{ ETag: '"e1"', PartNumber: 1 }, { ETag: '"e2"', PartNumber: 2 }] },
    });
  });

  it("an empty stream is still one (empty) part, so the upload can complete", async () => {
    const { s3UploadStream } = await loadS3();
    await s3UploadStream(chunks(), "k", "video/mp4");
    expect(kinds()).toEqual(["create", "part", "complete"]);
  });

  it("a failure aborts the upload, so no half-written parts are left, and is thrown", async () => {
    const { s3UploadStream } = await loadS3();
    async function* broken() {
      yield Buffer.alloc(10);
      throw new Error("ffmpeg died");
    }
    await expect(s3UploadStream(broken(), "k", "video/mp4")).rejects.toThrow("ffmpeg died");
    expect(kinds()).toEqual(["create", "abort"]);
    expect(sendMock.mock.calls[1][0].input).toEqual({ Bucket: "ea-sys-uploads", Key: "k", UploadId: "up1" });
  });
});

describe("s3UploadStream stopped", () => {
  it("passes the signal to every call, and never completes an upload whose signal was aborted", async () => {
    const { s3UploadStream } = await loadS3();
    const ctl = new AbortController();
    async function* endsEarly() {
      yield Buffer.alloc(10);
      ctl.abort();
    }
    await expect(s3UploadStream(endsEarly(), "k", "video/mp4", ctl.signal)).rejects.toThrow(/stopped/);
    expect(kinds()).toEqual(["create", "part", "abort"]);
    expect(sendMock.mock.calls[0][1]).toEqual({ abortSignal: ctl.signal });
  });
});

describe("s3DeleteMany", () => {
  it("a thousand keys per request, and answers the keys S3 could not delete", async () => {
    const { s3DeleteMany } = await loadS3();
    sendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({ Errors: [{ Key: "k1500" }] });
    const keys = Array.from({ length: 1500 }, (_, i) => `k${i}`);
    expect(await s3DeleteMany(keys)).toEqual(["k1500"]);
    const batches = sendMock.mock.calls.map(([c]) => c.input.Delete.Objects.length);
    expect(batches).toEqual([1000, 500]);
  });
});
