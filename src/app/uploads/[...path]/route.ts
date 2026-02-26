import { NextResponse } from "next/server";
import { readFile, stat, realpath } from "fs/promises";
import { join, resolve } from "path";

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

interface RouteParams {
  params: Promise<{ path: string[] }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { path } = await params;

  // Reject path traversal attempts (null bytes, ..)
  if (path.some((segment) => segment.includes("..") || segment.includes("\0"))) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Only serve from /uploads/ — no other subdirectory of public
  const uploadsRoot = resolve(process.cwd(), "public", "uploads");
  const filePath = join(uploadsRoot, ...path);

  try {
    // Resolve symlinks and verify the real path is within uploads directory
    const resolvedPath = await realpath(filePath);
    if (!resolvedPath.startsWith(uploadsRoot)) {
      return new NextResponse("Forbidden", { status: 403 });
    }

    await stat(resolvedPath);
    const file = await readFile(resolvedPath);
    const ext = (path[path.length - 1].split(".").pop() ?? "jpg").toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

    return new NextResponse(file, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'",
        "X-Frame-Options": "DENY",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
