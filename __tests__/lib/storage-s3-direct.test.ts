/**
 * Direct uploads to S3 (Nov 19, 2026; docs/SPEAKER_PRESENTATIONS_PLAN.md): a
 * file too large for the app goes from the browser to the bucket by a signed
 * form and is read by a signed link. What can go wrong is what we sign, so
 * the AWS SDK is mocked and the signatures' contents are what is asserted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { sendMock, postMock, getUrlMock } = vi.hoisted(() => ({ sendMock: vi.fn(), postMock: vi.fn(), getUrlMock: vi.fn() }));

vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = sendMock;
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
    readonly kind = "get";
  },
  HeadObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
    readonly kind = "head";
  },
}));
vi.mock("@aws-sdk/s3-presigned-post", () => ({ createPresignedPost: (...a: unknown[]) => postMock(...a) }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: (...a: unknown[]) => getUrlMock(...a) }));

async function loadS3() {
  const mod = await import("@/lib/storage-s3");
  mod.resetS3Client();
  return mod;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("S3_UPLOADS_BUCKET", "ea-sys-uploads");
  vi.stubEnv("S3_UPLOADS_REGION", "ap-south-1");
});
afterEach(() => vi.unstubAllEnvs());

describe("the signed upload form", () => {
  it("pins the key, the content type and the size in the policy itself", async () => {
    const { s3SignUpload } = await loadS3();
    postMock.mockResolvedValue({ url: "https://ea-sys-uploads.s3.amazonaws.com/", fields: { key: "k" } });
    const out = await s3SignUpload({ key: "presentations/ev1/sp1/p1.pdf", contentType: "application/pdf", maxBytes: 200 * 1024 * 1024, expiresSeconds: 900 });
    expect(out).toEqual({ url: "https://ea-sys-uploads.s3.amazonaws.com/", fields: { key: "k" } });
    const opts = postMock.mock.calls[0][1];
    expect(opts).toMatchObject({ Bucket: "ea-sys-uploads", Key: "presentations/ev1/sp1/p1.pdf", Expires: 900, Fields: { "Content-Type": "application/pdf" } });
    // S3 refuses a file over the cap, another key or another type, whatever the browser told us.
    expect(opts.Conditions).toEqual([
      ["content-length-range", 1, 200 * 1024 * 1024],
      ["eq", "$Content-Type", "application/pdf"],
      ["eq", "$key", "presentations/ev1/sp1/p1.pdf"],
    ]);
  });
});

describe("reading what landed", () => {
  it("heads an object for its size, version and ETag, and answers null when there is none", async () => {
    const { s3Head } = await loadS3();
    sendMock.mockResolvedValueOnce({ ContentLength: 4321, VersionId: "v1", ETag: '"abc"' });
    expect(await s3Head("presentations/a.pdf")).toEqual({ size: 4321, versionId: "v1", etag: '"abc"' });
    sendMock.mockRejectedValueOnce(Object.assign(new Error("nope"), { name: "NotFound" }));
    expect(await s3Head("presentations/a.pdf")).toBeNull();
  });

  it("reads only the first bytes, of the version it is told", async () => {
    const { s3ReadStart } = await loadS3();
    sendMock.mockResolvedValue({ Body: { transformToByteArray: async () => Uint8Array.from([0x25, 0x50, 0x44, 0x46]) } });
    const start = await s3ReadStart("presentations/a.pdf", 16, "v1");
    expect(start.toString()).toBe("%PDF");
    expect(sendMock.mock.calls[0][0].input).toEqual({ Bucket: "ea-sys-uploads", Key: "presentations/a.pdf", Range: "bytes=0-15", VersionId: "v1" });
  });
});

describe("the signed download link", () => {
  it("names the version that was checked and the name it downloads under", async () => {
    const { s3SignDownload } = await loadS3();
    getUrlMock.mockResolvedValue("https://signed.example/x");
    const url = await s3SignDownload({ key: "presentations/a.pdf", versionId: "v1", expiresSeconds: 300, contentDisposition: 'attachment; filename="Deck.pdf"', contentType: "application/pdf" });
    expect(url).toBe("https://signed.example/x");
    expect(getUrlMock.mock.calls[0][1].input).toEqual({
      Bucket: "ea-sys-uploads",
      Key: "presentations/a.pdf",
      VersionId: "v1",
      ResponseContentDisposition: 'attachment; filename="Deck.pdf"',
      ResponseContentType: "application/pdf",
    });
    expect(getUrlMock.mock.calls[0][2]).toEqual({ expiresIn: 300 });
  });
});
