import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { readStoredFile, StorageError } from "@/lib/storage";
import { isPublicUploadSegment, uploadPrefix, type UploadSegment } from "@/lib/upload-prefixes";

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  // PDFs land here after the 2026-06-02 cert-background upload landed.
  // Without the entry, direct GET of /uploads/certificates/.../*.pdf
  // returns application/octet-stream and the browser downloads instead
  // of inline-viewing. pdfjs-dist (canvas editor) doesn't care about
  // MIME, and the issue worker reads from disk via fs/promises — but
  // anyone sharing or visiting the URL directly expects an inline view.
  pdf: "application/pdf",
  // Pre-existing /uploads/agreements/{eventId}/*.docx (mail-merge templates)
  // — also was falling through to octet-stream until now.
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

interface RouteParams {
  params: Promise<{ path: string[] }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { path } = await params;

  // Reject path traversal attempts (null bytes, ..)
  if (path.some((segment) => segment.includes("..") || segment.includes("\0"))) {
    apiLogger.warn({ msg: "Path traversal attempt blocked", path: path.join("/") });
    return new NextResponse("Forbidden", { status: 403 });
  }

  // ALLOW-LIST, not a deny-list (Aug 19, 2026).
  //
  // This used to name the five private prefixes and refuse them. That fails
  // OPEN: every private prefix added afterwards was world-readable until
  // someone remembered to edit this file, with no test failing, because a test
  // asserting the OLD prefixes are 403 stays green while a NEW one is wide
  // open. This file's own previous comments described exactly that trap.
  //
  // Inverted, the same mistake fails closed: a segment absent from
  // PUBLIC_UPLOAD_SEGMENTS is refused, so forgetting to classify a new prefix
  // costs a broken image rather than leaked passports.
  //
  // The set is byte-identical to what the deny-list permitted, so this is a
  // structural change, not a behavioural one.
  const segment = path[0] ?? "";
  if (!isPublicUploadSegment(segment)) {
    apiLogger.warn({
      msg: "uploads:private-segment-blocked",
      segment,
      path: path.join("/"),
    });
    return new NextResponse("Forbidden", { status: 403 });
  }

  const storedPath = `/uploads/${path.join("/")}`;

  try {
    // Symlink resolution and root containment live in readStoredFile, scoped to
    // the public segment this request named, so a public prefix cannot be used
    // to reach a private one.
    const file = await readStoredFile(storedPath, uploadPrefix(segment as UploadSegment));
    const ext = (path[path.length - 1].split(".").pop() ?? "jpg").toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'",
        "X-Frame-Options": "DENY",
      },
    });
  } catch (error) {
    if (error instanceof StorageError) {
      // A missing file is ordinary. A traversal or prefix rejection is not, and
      // is logged so it is visible rather than looking like a 404.
      if (error.reason !== "not-found") {
        apiLogger.warn({ msg: `uploads:${error.reason}`, path: path.join("/") });
      }
      return new NextResponse("Not found", { status: 404 });
    }
    apiLogger.error({ err: error, msg: "Unexpected error serving upload", path: path.join("/") });
    return new NextResponse("Not found", { status: 404 });
  }
}
