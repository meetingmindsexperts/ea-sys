/**
 * Speaker reimbursement — authed document stream (organizer).
 *
 * Reimbursement uploads (passport scans, receipts) are BLOCKED on the
 * public /uploads catch-all; this is the only way to read one. The row is
 * bound document → reimbursement → event (via buildEventAccessWhere), and
 * the on-disk path is verified to sit inside
 * public/uploads/reimbursements/ before the read (traversal guard — the
 * DB url is trusted-ish, but defense in depth is free).
 */
import { NextResponse } from "next/server";
import { readFile, realpath } from "fs/promises";
import path from "path";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";

type RouteParams = {
  params: Promise<{ eventId: string; reimbursementId: string; documentId: string }>;
};

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, reimbursementId, documentId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "reimbursement-doc:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Atomic binding: the document must belong to THIS reimbursement on THIS
    // event — a foreign documentId 404s.
    const doc = await db.speakerReimbursementDocument.findFirst({
      where: { id: documentId, reimbursement: { id: reimbursementId, eventId } },
      select: { url: true, filename: true, mimeType: true },
    });
    if (!doc) {
      apiLogger.warn(
        { eventId, reimbursementId, documentId, userId: session.user.id },
        "reimbursement-doc:not-found",
      );
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const allowedRoot = path.resolve(process.cwd(), "public", "uploads", "reimbursements");
    if (!doc.url.startsWith("/uploads/reimbursements/")) {
      apiLogger.warn({ documentId, url: doc.url }, "reimbursement-doc:url-outside-root");
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }
    const abs = path.resolve(process.cwd(), "public", doc.url.slice(1));
    let resolved: string;
    try {
      resolved = await realpath(abs);
    } catch {
      apiLogger.error({ documentId, abs }, "reimbursement-doc:file-missing");
      return NextResponse.json(
        {
          error:
            "The file is missing on this server. With local storage, files uploaded on another machine are not present here.",
          code: "FILE_MISSING",
        },
        { status: 404 },
      );
    }
    if (!resolved.startsWith(allowedRoot + path.sep)) {
      apiLogger.warn({ documentId, resolved }, "reimbursement-doc:traversal-blocked");
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const file = await readFile(resolved);
    const ext = (doc.url.split(".").pop() ?? "").toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? doc.mimeType ?? "application/octet-stream";
    // ASCII-sanitized filename for the header (a crafted filename must not
    // inject header characters); inline so PDFs/images preview in-browser.
    const safeName = doc.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "document";
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${safeName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'",
      },
    });
  } catch (err) {
    apiLogger.error({ err }, "reimbursement-doc:stream-failed");
    return NextResponse.json({ error: "Failed to load document" }, { status: 500 });
  }
}
