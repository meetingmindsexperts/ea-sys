/**
 * The S3 storage backend.
 *
 * Written before the bucket exists, so the AWS SDK is mocked. That is the right
 * boundary anyway: what can actually go wrong here is our key mapping, our
 * pagination, and our error classification, none of which needs a real bucket
 * to be wrong.
 *
 * See docs/UAE_DOCUMENT_RESIDENCY_PLAN.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { sendMock, ctorMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  ctorMock: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Commands are recorded as plain tagged objects so assertions read as intent
// ("a GetObject for this key") rather than as SDK internals.
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor(cfg: unknown) {
      ctorMock(cfg);
    }
    send = sendMock;
  },
  PutObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
    readonly kind = "put";
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
    readonly kind = "get";
  },
  DeleteObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
    readonly kind = "delete";
  },
  ListObjectsV2Command: class {
    constructor(public input: Record<string, unknown>) {}
    readonly kind = "list";
  },
}));

async function loadS3() {
  const mod = await import("@/lib/storage-s3");
  mod.resetS3Client();
  return mod;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("S3_UPLOADS_BUCKET", "ea-sys-documents-uae");
  vi.stubEnv("S3_UPLOADS_REGION", "me-central-1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("configuration", () => {
  it("uses the configured region", async () => {
    const { s3Delete } = await loadS3();
    sendMock.mockResolvedValue({});
    await s3Delete("photos/x.jpg");
    expect(ctorMock).toHaveBeenCalledWith({ region: "me-central-1" });
  });

  it("refuses to run without a bucket rather than writing somewhere wrong", async () => {
    vi.stubEnv("S3_UPLOADS_BUCKET", "");
    const { s3Delete } = await loadS3();
    await expect(s3Delete("photos/x.jpg")).rejects.toThrow(/S3_UPLOADS_BUCKET is required/);
  });
});

describe("s3Upload", () => {
  it("puts the key with its content type and the immutable cache header", async () => {
    const { s3Upload } = await loadS3();
    sendMock.mockResolvedValue({});
    await s3Upload(Buffer.from("hi"), "speaker-docs/evt1/a.pdf", "application/pdf");

    const cmd = sendMock.mock.calls[0]![0] as { kind: string; input: Record<string, unknown> };
    expect(cmd.kind).toBe("put");
    expect(cmd.input.Bucket).toBe("ea-sys-documents-uae");
    expect(cmd.input.Key).toBe("speaker-docs/evt1/a.pdf");
    expect(cmd.input.ContentType).toBe("application/pdf");
    expect(cmd.input.CacheControl).toBe("public, max-age=31536000, immutable");
  });

  it("does NOT set per-object encryption", async () => {
    // Encryption is a bucket property (default SSE-KMS with a customer key), so
    // it cannot be forgotten by a caller. Setting it here as well would create a
    // second place that has to stay right.
    const { s3Upload } = await loadS3();
    sendMock.mockResolvedValue({});
    await s3Upload(Buffer.from("hi"), "photos/a.jpg", "image/jpeg");

    const cmd = sendMock.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(cmd.input.ServerSideEncryption).toBeUndefined();
  });
});

describe("s3Read error classification", () => {
  it("maps a missing key to a not-found StorageError", async () => {
    const { s3Read } = await loadS3();
    const { StorageError } = await import("@/lib/storage-errors");
    sendMock.mockRejectedValue(Object.assign(new Error("nope"), { name: "NoSuchKey" }));

    await expect(s3Read("photos/gone.jpg")).rejects.toBeInstanceOf(StorageError);
    await s3Read("photos/gone.jpg").catch((e) => expect(e.reason).toBe("not-found"));
  });

  it("maps a bare 404 to not-found too", async () => {
    const { s3Read } = await loadS3();
    sendMock.mockRejectedValue(
      Object.assign(new Error("nf"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }),
    );
    await s3Read("photos/gone.jpg").catch((e) => expect(e.reason).toBe("not-found"));
  });

  it("does NOT swallow a missing BUCKET as a missing file", async () => {
    // The distinction that matters: a wrong bucket name would otherwise look
    // like an empty bucket, and the prune worker would report a clean sweep
    // while reaping nothing. A misconfiguration has to surface as one.
    const { s3Read } = await loadS3();
    const { StorageError } = await import("@/lib/storage-errors");
    sendMock.mockRejectedValue(Object.assign(new Error("no bucket"), { name: "NoSuchBucket" }));

    const err = await s3Read("photos/x.jpg").catch((e) => e);
    expect(err).not.toBeInstanceOf(StorageError);
    expect(err.name).toBe("NoSuchBucket");
  });
});

describe("s3List pagination", () => {
  it("follows continuation tokens instead of returning only the first page", async () => {
    // ListObjectsV2 caps at 1000 keys. A caller that ignores IsTruncated sees
    // one page and calls it the whole bucket. For the prune worker that means
    // silently never reaping anything past the first thousand files.
    const { s3List } = await loadS3();
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: "a.pdf", LastModified: new Date("2026-01-01"), Size: 1 }],
        IsTruncated: true,
        NextContinuationToken: "tok-1",
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: "b.pdf", LastModified: new Date("2026-01-02"), Size: 2 }],
        IsTruncated: false,
      });

    const out = await s3List("resident-letters/");

    expect(out.map((o) => o.key)).toEqual(["a.pdf", "b.pdf"]);
    expect(sendMock).toHaveBeenCalledTimes(2);
    const second = sendMock.mock.calls[1]![0] as { input: Record<string, unknown> };
    expect(second.input.ContinuationToken).toBe("tok-1");
  });

  it("returns an empty list, not a throw, when the prefix has nothing", async () => {
    const { s3List } = await loadS3();
    sendMock.mockResolvedValue({ Contents: undefined, IsTruncated: false });
    expect(await s3List("resident-letters/")).toEqual([]);
  });
});

describe("storage dispatch under STORAGE_PROVIDER=s3", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("STORAGE_PROVIDER", "s3");
  });

  it("maps a stored path to a key by stripping /uploads/", async () => {
    const { uploadFile } = await import("@/lib/storage");
    sendMock.mockResolvedValue({});

    const stored = await uploadFile(
      Buffer.from("x"),
      "a.pdf",
      "application/pdf",
      "speaker-docs/evt1",
    );

    expect(stored).toBe("/uploads/speaker-docs/evt1/a.pdf");
    const cmd = sendMock.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(cmd.input.Key).toBe("speaker-docs/evt1/a.pdf");
  });

  it("applies the SAME prefix guard as the local provider before touching S3", async () => {
    // S3 has no symlinks and flat keys, so it cannot do the filesystem
    // resolution the local branch does. That makes it all the more important
    // that it is not quietly running a weaker version of the string checks.
    const { readStoredFile } = await import("@/lib/storage");
    const { StorageError } = await import("@/lib/storage-errors");

    await expect(
      readStoredFile("/uploads/photos/x.jpg", "/uploads/speaker-docs/"),
    ).rejects.toBeInstanceOf(StorageError);
    await expect(
      readStoredFile("/uploads/speaker-docs/../photos/x.jpg", "/uploads/speaker-docs/"),
    ).rejects.toBeInstanceOf(StorageError);

    // And it refused BEFORE any network call, rather than asking S3 first.
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("keeps deleteStoredFile's never-throws contract when S3 errors", async () => {
    const { deleteStoredFile } = await import("@/lib/storage");
    sendMock.mockRejectedValue(new Error("network down"));
    await expect(
      deleteStoredFile("/uploads/photos/x.jpg", "/uploads/photos/"),
    ).resolves.toBeUndefined();
  });
});
