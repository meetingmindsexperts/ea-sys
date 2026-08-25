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
import { storageErrorResponse } from "@/lib/api-errors";
import { readStoredFile } from "@/lib/storage";
import { UPLOAD_PREFIX } from "@/lib/upload-prefixes";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
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
    const denied = denyReviewer(session, { route: "events/[eventId]/reimbursements/[reimbursementId]/documents/[documentId]:GET" });
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "reimbursement-doc:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Atomic binding: the document must belong to THIS reimbursement on THIS
    // event — a foreign documentId 404s. Tenancy (Domain #17): swept 2-hop
    // read in the resource org.
    const doc = await runWithTenant(event.organizationId, () =>
      db.speakerReimbursementDocument.findFirst({
        where: { id: documentId, reimbursement: { id: reimbursementId, eventId } },
        select: { url: true, filename: true, mimeType: true },
      }),
    );
    if (!doc) {
      apiLogger.warn(
        { eventId, reimbursementId, documentId, userId: session.user.id },
        "reimbursement-doc:not-found",
      );
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    // Prefix check, symlink resolution and root containment all live in
    // readStoredFile now; storageErrorResponse keeps the three cases apart in
    // the logs while returning one 404 either way.
    let file: Buffer;
    try {
      file = await readStoredFile(doc.url, UPLOAD_PREFIX.reimbursements);
    } catch (err) {
      const res = storageErrorResponse(err, {
        route: "reimbursement-doc",
        notFoundMessage: "Document not found",
        eventId,
        reimbursementId,
        documentId,
      });
      if (res) return res;
      throw err;
    }
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
