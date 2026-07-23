import { NextResponse } from "next/server";
import { readFile, stat, realpath } from "fs/promises";
import { join, resolve } from "path";
import { apiLogger } from "@/lib/logger";

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

  // Speaker-reimbursement documents (passport scans, receipts backing wire
  // transfers) are PRIVATE. They live under public/uploads so they ride the
  // persistent Docker volume + hourly DR sync like every other upload, but
  // they must NEVER be served by this public catch-all — they stream only
  // through the authed route
  // /api/events/[eventId]/reimbursements/[id]/documents/[documentId].
  if (path[0] === "reimbursements") {
    apiLogger.warn({ msg: "Private reimbursement upload blocked on public route", path: path.join("/") });
    return new NextResponse("Forbidden", { status: 403 });
  }

  // CRM deal documents (sponsorship prospectus, generated QUOTE PDFs — which
  // print deal money — contract drafts) are likewise PRIVATE: same volume/DR
  // ride, but they stream only through the authed
  // GET /api/crm/deals/[dealId]/documents/[documentId]. Multi-tenant prep —
  // one tenant's quote must never be a guessable URL for another.
  if (path[0] === "crm-deal-docs") {
    apiLogger.warn({ msg: "Private CRM deal upload blocked on public route", path: path.join("/") });
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Only serve from /uploads/ — no other subdirectory of public
  const uploadsRoot = resolve(process.cwd(), "public", "uploads");
  const filePath = join(uploadsRoot, ...path);

  try {
    // Resolve symlinks and verify the real path is within uploads directory
    const resolvedPath = await realpath(filePath);
    if (!resolvedPath.startsWith(uploadsRoot)) {
      apiLogger.warn({ msg: "Symlink escape attempt blocked", path: path.join("/"), resolvedPath });
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
  } catch (error) {
    const isNotFound = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
    if (!isNotFound) {
      apiLogger.error({ err: error, msg: "Unexpected error serving upload", path: path.join("/") });
    }
    return new NextResponse("Not found", { status: 404 });
  }
}
