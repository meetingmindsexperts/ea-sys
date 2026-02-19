import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { apiLogger } from "@/lib/logger";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_FILE_SIZE = 500 * 1024; // 500KB in bytes

// Check if running on Vercel
const isVercel = process.env.VERCEL === "1";

export async function POST(req: Request) {
  try {
    const session = await auth();

    if (!session?.user) {
      apiLogger.warn({ msg: "Unauthorized photo upload attempt" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    // Generate unique filename
    const fileExtension = file.name.split(".").pop() || "jpg";
    const sanitizedExtension = fileExtension.toLowerCase().replace(/[^a-z0-9]/g, "");
    const uniqueId = randomUUID();
    const filename = `${uniqueId}.${sanitizedExtension}`;

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
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

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
      {
        error: "Failed to upload photo",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
