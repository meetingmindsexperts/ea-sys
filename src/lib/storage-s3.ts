/**
 * S3 backend for the storage primitives.
 *
 * Kept in its own module and imported DYNAMICALLY by storage.ts so the AWS SDK
 * is never pulled in while STORAGE_PROVIDER is "local", which is every
 * deployment until the cutover.
 *
 * ## Keys
 *
 * A stored path is `/uploads/{segment}/...`; the S3 key is the same string with
 * the leading `/uploads/` removed. That mapping is what makes the migration
 * carry no database change: every path already persisted keeps working, and
 * only the bytes move.
 *
 * ## Credentials
 *
 * None in `.env`. The SDK's default provider chain picks up the EC2 instance
 * role, the same way the SES and CloudWatch clients already do. A leaked env
 * file therefore cannot read the bucket.
 *
 * ## Encryption
 *
 * Not specified per object on purpose. The bucket carries default SSE-KMS with
 * a customer-managed key, so encryption is a property of the bucket that cannot
 * be forgotten by a caller, rather than a parameter every write has to
 * remember. See docs/UAE_DOCUMENT_RESIDENCY_PLAN.md section 5.
 */
import type { S3Client } from "@aws-sdk/client-s3";
import { apiLogger } from "./logger";
import { StorageError } from "./storage-errors";

let client: S3Client | null = null;

function bucket(): string {
  const name = process.env.S3_UPLOADS_BUCKET;
  if (!name) {
    // Fail loudly at first use rather than writing to a bucket named
    // "undefined" or silently degrading to local disk. A misconfigured
    // provider must be obvious immediately, not at audit time.
    throw new Error("S3_UPLOADS_BUCKET is required when STORAGE_PROVIDER=s3");
  }
  return name;
}

async function getClient(): Promise<S3Client> {
  if (client) return client;
  const { S3Client: Ctor } = await import("@aws-sdk/client-s3");
  const region = process.env.S3_UPLOADS_REGION || process.env.AWS_REGION;
  if (!region) {
    throw new Error("S3_UPLOADS_REGION (or AWS_REGION) is required when STORAGE_PROVIDER=s3");
  }
  client = new Ctor({ region });
  apiLogger.info({ msg: "storage:s3-client-initialised", region, bucket: bucket() });
  return client;
}

/** Test seam + a way to drop the client after a config change. */
export function resetS3Client(): void {
  client = null;
}

function isNotFound(err: unknown): boolean {
  // The SDK reports a missing key as NoSuchKey on GetObject but as a bare 404
  // on HeadObject, and a missing BUCKET as NoSuchBucket. The first two are
  // "not found"; the third is a misconfiguration and must NOT be swallowed as
  // one, or a wrong bucket name would look like an empty bucket.
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

export async function s3Upload(buffer: Buffer, key: string, mimeType: string): Promise<void> {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = await getClient();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      // Matches the one-year immutable Cache-Control the serving routes set.
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}

export async function s3Read(key: string): Promise<Buffer> {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = await getClient();
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    if (!res.Body) throw new StorageError("not-found", `Empty body for key: ${key}`);
    const bytes = await res.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch (err) {
    if (err instanceof StorageError) throw err;
    if (isNotFound(err)) {
      throw new StorageError("not-found", `No such object: ${key}`);
    }
    throw err;
  }
}

export async function s3Delete(key: string): Promise<void> {
  const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = await getClient();
  // S3 DeleteObject is idempotent: deleting a key that does not exist succeeds.
  // That suits deleteStoredFile's never-throws contract exactly.
  await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/**
 * List every object under a key prefix, following pagination.
 *
 * Paginating is not optional: ListObjectsV2 returns at most 1000 keys per
 * call, and a caller that ignores IsTruncated silently sees only the first
 * page. For the prune worker that would mean quietly never reaping anything
 * past the first thousand files, which is the exact class of silent failure
 * the local walk was guarded against.
 */
export async function s3List(
  prefix: string,
): Promise<{ key: string; modifiedAt: Date; sizeBytes: number }[]> {
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const s3 = await getClient();
  const out: { key: string; modifiedAt: Date; sizeBytes: number }[] = [];
  let token: string | undefined;

  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }),
    );
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      out.push({
        key: obj.Key,
        modifiedAt: obj.LastModified ?? new Date(0),
        sizeBytes: obj.Size ?? 0,
      });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  return out;
}

// ── Direct uploads (Nov 19, 2026; docs/SPEAKER_PRESENTATIONS_PLAN.md) ───────
//
// A file too large for the app goes from the browser straight to the bucket
// by a signed form, and is read back by a short-lived signed link. The app
// never holds its bytes.

/**
 * A signed POST form for ONE key. A POST policy, not a signed PUT: only a
 * policy carries `content-length-range`, which makes S3 itself refuse a file
 * over the cap, whatever the browser told us. The key and the content type
 * are pinned too.
 */
export async function s3SignUpload(opts: {
  key: string;
  contentType: string;
  /** The smallest and largest body S3 will take. Equal for an exact size. */
  minBytes: number;
  maxBytes: number;
  expiresSeconds: number;
}): Promise<{ url: string; fields: Record<string, string> }> {
  const { createPresignedPost } = await import("@aws-sdk/s3-presigned-post");
  const s3 = await getClient();
  return createPresignedPost(s3, {
    Bucket: bucket(),
    Key: opts.key,
    Conditions: [
      ["content-length-range", opts.minBytes, opts.maxBytes],
      ["eq", "$Content-Type", opts.contentType],
      ["eq", "$key", opts.key],
    ],
    Fields: { "Content-Type": opts.contentType },
    Expires: opts.expiresSeconds,
  });
}

/** Size, version and ETag of an object, or null when there is none. */
export async function s3Head(
  key: string,
  versionId?: string | null,
): Promise<{ size: number; versionId: string | null; etag: string | null } | null> {
  const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = await getClient();
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: bucket(), Key: key, ...(versionId ? { VersionId: versionId } : {}) }));
    return { size: res.ContentLength ?? 0, versionId: res.VersionId ?? null, etag: res.ETag ?? null };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** The first `bytes` of an object: enough to read its signature, never the whole file. */
export async function s3ReadStart(key: string, bytes: number, versionId?: string | null): Promise<Buffer> {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = await getClient();
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket(), Key: key, Range: `bytes=0-${bytes - 1}`, ...(versionId ? { VersionId: versionId } : {}) }),
    );
    if (!res.Body) throw new StorageError("not-found", `Empty body for key: ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  } catch (err) {
    if (err instanceof StorageError) throw err;
    if (isNotFound(err)) throw new StorageError("not-found", `No such object: ${key}`);
    throw err;
  }
}

/** A signed link to read one object (one version of it, when given), with the name it downloads under. */
export async function s3SignDownload(opts: {
  key: string;
  versionId?: string | null;
  expiresSeconds: number;
  contentDisposition: string;
  contentType: string;
}): Promise<string> {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const s3 = await getClient();
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket(),
      Key: opts.key,
      ...(opts.versionId ? { VersionId: opts.versionId } : {}),
      ResponseContentDisposition: opts.contentDisposition,
      ResponseContentType: opts.contentType,
    }),
    { expiresIn: opts.expiresSeconds },
  );
}

