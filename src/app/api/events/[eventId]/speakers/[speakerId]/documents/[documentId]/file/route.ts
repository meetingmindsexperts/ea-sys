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
import { readFile, realpath } from "fs/promises";
import path from "path";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
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
    const denied = denyReviewer(session);
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

    const allowedRoot = path.resolve(process.cwd(), "public", "uploads", "speaker-docs");
    if (!doc.url.startsWith("/uploads/speaker-docs/")) {
      apiLogger.warn({ documentId, url: doc.url }, "speaker-doc-file:url-outside-root");
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }
    const abs = path.resolve(process.cwd(), "public", doc.url.slice(1));
    let resolved: string;
    try {
      resolved = await realpath(abs);
    } catch {
      apiLogger.error({ documentId, abs }, "speaker-doc-file:file-missing");
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
      apiLogger.warn({ documentId, resolved }, "speaker-doc-file:traversal-blocked");
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const file = await readFile(resolved);
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
