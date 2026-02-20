import { NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import { join } from "path";

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

  // Reject path traversal attempts
  if (path.some((segment) => segment.includes(".."))) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Only serve from /uploads/ — no other subdirectory of public
  const filePath = join(process.cwd(), "public", "uploads", ...path);

  try {
    await stat(filePath);
    const file = await readFile(filePath);
    const ext = (path[path.length - 1].split(".").pop() ?? "jpg").toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

    return new NextResponse(file, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
