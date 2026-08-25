/**
 * Speaker document — authed file stream (Aug 4, 2026).
 *
 * /uploads/speaker-docs/ is now BLOCKED on the public /uploads catch-all
 * (the speaker profile form stores PASSPORT photocopies there — previously
 * signed agreements etc. were served behind UUID obscurity only). This route
 * is the only way to read one: document bound speaker → event (via
 * buildEventAccessWhere), on-disk path verified inside
 * public/uploads/speaker-docs/ before the read (reimbursement-doc pattern).
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { storageErrorResponse } from "@/lib/api-errors";
import { readStoredFile } from "@/lib/storage";
import { UPLOAD_PREFIX } from "@/lib/upload-prefixes";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";

type RouteParams = {
  params: Promise<{ eventId: string; speakerId: string; documentId: string }>;
};

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, speakerId, documentId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route: "events/[eventId]/speakers/[speakerId]/documents/[documentId]/file:GET" });
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "speaker-doc-file:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Atomic binding: the document must belong to THIS speaker on THIS event.
    const doc = await runWithTenant(event.organizationId, () =>
      db.speakerDocument.findFirst({
        where: { id: documentId, speaker: { id: speakerId, eventId } },
        select: { url: true, filename: true, mimeType: true },
      }),
    );
    if (!doc) {
      apiLogger.warn({ eventId, speakerId, documentId, userId: session.user.id }, "speaker-doc-file:not-found");
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    // The prefix check, symlink resolution and root containment all live in
    // readStoredFile now. storageErrorResponse preserves the three cases as
    // distinct log lines while returning one 404 either way, so this route
    // stays free of an existence oracle.
    let file: Buffer;
    try {
      file = await readStoredFile(doc.url, UPLOAD_PREFIX.speakerDocs);
    } catch (err) {
      const res = storageErrorResponse(err, {
        route: "speaker-doc-file",
        notFoundMessage: "Document not found",
        eventId,
        speakerId,
        documentId,
      });
      if (res) return res;
      throw err;
    }
    const ext = (doc.url.split(".").pop() ?? "").toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? doc.mimeType ?? "application/octet-stream";
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
    apiLogger.error({ err }, "speaker-doc-file:stream-failed");
    return NextResponse.json({ error: "Failed to load document" }, { status: 500 });
  }
}
