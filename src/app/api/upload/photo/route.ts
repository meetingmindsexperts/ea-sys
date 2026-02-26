import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_FILE_SIZE = 500 * 1024; // 500KB in bytes

// Magic byte signatures for allowed image types
const MAGIC_BYTES: Record<string, { bytes: number[]; offset: number }[]> = {
  "image/jpeg": [{ bytes: [0xFF, 0xD8, 0xFF], offset: 0 }],
  "image/png": [{ bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], offset: 0 }],
  "image/webp": [
    { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // "RIFF"
    { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 }, // "WEBP"
  ],
};

// Map validated MIME type to file extension (never trust client-provided extension)
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

// Check if running on Vercel
const isVercel = process.env.VERCEL === "1";

export async function POST(req: Request) {
  try {
    const session = await auth();

    if (!session?.user) {
      apiLogger.warn({ msg: "Unauthorized photo upload attempt" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const uploadRateLimit = checkRateLimit({
      key: `photo-upload:user:${session.user.id}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });

    if (!uploadRateLimit.allowed) {
      return NextResponse.json(
        { error: "Upload limit reached. Maximum 20 photos per hour." },
        { status: 429, headers: { "Retry-After": String(uploadRateLimit.retryAfterSeconds) } }
      );
    }

    // Log environment info
    apiLogger.info({
      msg: "Photo upload attempt",
      userId: session.user.id,
      isVercel,
      env: process.env.NODE_ENV,
    });

    // Check if running on Vercel (which doesn't support file uploads to /public)
    if (isVercel) {
      apiLogger.error({
        msg: "Photo upload not supported on Vercel deployment",
        userId: session.user.id,
      });
      return NextResponse.json(
        {
          error:
            "Photo uploads are not supported on Vercel. Please use a cloud storage service (S3, Cloudinary, etc.) or deploy to EC2.",
        },
        { status: 501 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      apiLogger.warn({ msg: "No file provided in upload request", userId: session.user.id });
      return NextResponse.json(
        { error: "No file provided" },
        { status: 400 }
      );
    }

    apiLogger.info({
      msg: "File received",
      filename: file.name,
      size: file.size,
      type: file.type,
      userId: session.user.id,
    });

    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
      apiLogger.warn({
        msg: "Invalid file type",
        type: file.type,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "Only JPEG, PNG, and WebP images are allowed" },
        { status: 400 }
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      apiLogger.warn({
        msg: "File too large",
        size: file.size,
        maxSize: MAX_FILE_SIZE,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "File size must be under 500KB" },
        { status: 400 }
      );
    }

    // Read file buffer and validate magic bytes
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const detectedMime = detectMimeType(buffer);
    if (!detectedMime || !ALLOWED_TYPES.includes(detectedMime)) {
      apiLogger.warn({
        msg: "File content does not match an allowed image type",
        claimedType: file.type,
        detectedMime,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "File content is not a valid JPEG, PNG, or WebP image" },
        { status: 400 }
      );
    }

    // Derive extension from validated content type, never from client filename
    const fileExtension = MIME_TO_EXT[detectedMime];
    const uniqueId = randomUUID();
    const filename = `${uniqueId}.${fileExtension}`;

    // Create directory structure: /public/uploads/photos/YYYY/MM/
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, "0");

    const uploadDir = join(process.cwd(), "public", "uploads", "photos", year, month);

    apiLogger.info({
      msg: "Attempting to create upload directory",
      uploadDir,
      userId: session.user.id,
    });

    // Create directory if it doesn't exist
    if (!existsSync(uploadDir)) {
      try {
        await mkdir(uploadDir, { recursive: true });
        apiLogger.info({ msg: "Created upload directory", uploadDir });
      } catch (mkdirError) {
        apiLogger.error({
          err: mkdirError,
          msg: "Failed to create upload directory",
          uploadDir,
        });
        throw mkdirError;
      }
    }

    // Save file
    const filepath = join(uploadDir, filename);

    apiLogger.info({
      msg: "Writing file to disk",
      filepath,
      bufferSize: buffer.length,
      userId: session.user.id,
    });

    try {
      await writeFile(filepath, buffer);
      apiLogger.info({
        msg: "File written successfully",
        filepath,
        userId: session.user.id,
      });
    } catch (writeError) {
      apiLogger.error({
        err: writeError,
        msg: "Failed to write file",
        filepath,
      });
      throw writeError;
    }

    // Return public URL
    const url = `/uploads/photos/${year}/${month}/${filename}`;

    apiLogger.info({
      msg: "Photo uploaded successfully",
      url,
      userId: session.user.id,
    });

    return NextResponse.json({ url }, { status: 200 });
  } catch (error) {
    apiLogger.error({
      err: error,
      msg: "Photo upload failed",
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      { error: "Failed to upload photo" },
      { status: 500 }
    );
  }
}
