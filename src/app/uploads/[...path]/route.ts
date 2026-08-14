import { NextResponse } from "next/server";
import { readFile, stat, realpath } from "fs/promises";
import { join, resolve } from "path";
import { apiLogger } from "@/lib/logger";
import { SUPPORTING_DOCUMENT_PATH_SEGMENT } from "@/lib/supporting-document";

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

  // Inbound CRM email attachments (sponsor-sent files) — same policy: private,
  // streamed only through the authed inbox attachment route.
  if (path[0] === "crm-email-attachments") {
    apiLogger.warn({ msg: "Private CRM email attachment blocked on public route", path: path.join("/") });
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Per-speaker documents (signed agreements, and — since the public speaker
  // profile form, Aug 4 2026 — PASSPORT photocopies) are PRIVATE. Previously
  // served here behind UUID obscurity only; now they stream exclusively
  // through the authed route
  // /api/events/[eventId]/speakers/[speakerId]/documents/[documentId]/file.
  if (path[0] === "speaker-docs") {
    apiLogger.warn({ msg: "Private speaker document blocked on public route", path: path.join("/") });
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Registration supporting documents. PRIVATE for the same reason as the
  // documents above: the file names a person, names their employer and may
  // carry an authorised signature and stamp. Uploaded by an UNAUTHENTICATED
  // public form, so unlike the others there is no token bounding who can write
  // here — which makes it all the more important that nobody can read back.
  // Streams only through
  // /api/events/[eventId]/registrations/[registrationId]/supporting-document.
  //
  // The segment is DERIVED from the same constant the validators and the upload
  // route use, not hardcoded. It was a literal until Aug 14 2026, and that is a
  // silent-failure shape worth avoiding: rename the prefix in the lib without
  // remembering this file and every stored document becomes world-readable at a
  // guessable URL, with no test failing — an existing test asserting the OLD
  // literal is 403 stays true while the NEW prefix is wide open.
  if (path[0] === SUPPORTING_DOCUMENT_PATH_SEGMENT) {
    apiLogger.warn({ msg: "Private supporting document blocked on public route", path: path.join("/") });
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
