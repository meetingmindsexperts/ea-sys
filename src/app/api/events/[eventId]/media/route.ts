import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit } from "@/lib/security";
import { uploadMedia, deleteMedia, storageProvider } from "@/lib/storage";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

const MAGIC_BYTES: Record<string, { bytes: number[]; offset: number }[]> = {
  "image/jpeg": [{ bytes: [0xFF, 0xD8, 0xFF], offset: 0 }],
  "image/png": [{ bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], offset: 0 }],
  "image/webp": [
    { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },
    { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  ],
};

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function detectMimeType(buffer: Buffer): string | null {
  for (const [mime, signatures] of Object.entries(MAGIC_BYTES)) {
    const allMatch = signatures.every(({ bytes, offset }) =>
      bytes.every((byte, i) => buffer[offset + i] === byte)
    );
    if (allMatch) return mime;
  }
  return null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, ...buildEventAccessWhere(session.user) },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50") || 50));
    const skip = (page - 1) * limit;

    const where = { eventId };

    const [mediaFiles, total] = await Promise.all([
      db.mediaFile.findMany({
        where,
        select: {
          id: true,
          filename: true,
          url: true,
          mimeType: true,
          size: true,
          createdAt: true,
          uploadedBy: { select: { firstName: true, lastName: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      db.mediaFile.count({ where }),
    ]);

    return NextResponse.json({ mediaFiles, total, page, limit });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching event media files" });
    return NextResponse.json({ error: "Failed to fetch media files" }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);

    if (!session?.user) {
      apiLogger.warn({ msg: "Unauthorized event media upload attempt" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, formData] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, ...buildEventAccessWhere(session.user) },
        select: { id: true },
      }),
      req.formData(),
    ]);
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const rateLimit = checkRateLimit({
      key: `media-upload:user:${session.user.id}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
      apiLogger.warn({ msg: "Event media upload rate limit exceeded", eventId, userId: session.user.id });
      return NextResponse.json(
        { error: "Upload limit reached. Maximum 20 uploads per hour." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
      );
    }

    const file = formData.get("file") as File | null;
    if (!file) {
      apiLogger.warn({ msg: "Event media upload: no file provided", eventId, userId: session.user.id });
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      apiLogger.warn({ msg: "Event media upload: invalid file type", type: file.type, eventId, userId: session.user.id });
      return NextResponse.json({ error: "Only JPEG, PNG, and WebP images are allowed" }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      apiLogger.warn({ msg: "Event media upload: file too large", size: file.size, eventId, userId: session.user.id });
      return NextResponse.json({ error: "File size must be under 2MB" }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const detectedMime = detectMimeType(buffer);
    if (!detectedMime || !ALLOWED_TYPES.includes(detectedMime)) {
      apiLogger.warn({ msg: "Event media upload: magic bytes mismatch", claimedType: file.type, detectedMime, eventId, userId: session.user.id });
      return NextResponse.json({ error: "File content is not a valid JPEG, PNG, or WebP image" }, { status: 400 });
    }

    // Sanitize filename: strip path components, limit length
    const safeFilename = file.name.replace(/[/\\]/g, "").slice(0, 255) || "upload";

    const fileExtension = MIME_TO_EXT[detectedMime];
    const filename = `${randomUUID()}.${fileExtension}`;
    const url = await uploadMedia(buffer, filename, detectedMime);

    let mediaFile;
    try {
      mediaFile = await db.mediaFile.create({
        data: {
          organizationId: session.user.organizationId!,
          eventId,
          uploadedById: session.user.id,
          filename: safeFilename,
          url,
          mimeType: detectedMime,
          size: file.size,
        },
        select: { id: true, url: true, filename: true, mimeType: true, size: true, createdAt: true },
      });
    } catch (dbErr) {
      // DB create failed — delete the already-uploaded file to avoid storage orphan
      apiLogger.error({ err: dbErr, msg: "Event media DB create failed; deleting orphaned storage file", url, eventId });
      await deleteMedia(url).catch((storageErr) =>
        apiLogger.error({ err: storageErr, msg: "Failed to clean up orphaned event media from storage", url })
      );
      throw dbErr;
    }

    apiLogger.info({ msg: "Event media file uploaded", mediaId: mediaFile.id, eventId, url, storageProvider, userId: session.user.id });

    return NextResponse.json(mediaFile, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Event media upload failed" });
    return NextResponse.json({ error: "Failed to upload media file" }, { status: 500 });
  }
}
