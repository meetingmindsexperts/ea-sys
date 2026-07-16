import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";

interface RouteParams {
  params: Promise<{ eventId: string; speakerId: string; documentId: string }>;
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, speakerId, documentId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "speaker-document-delete:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Bind the row through the speaker to THIS event so a foreign documentId
    // can't be deleted via an event the caller does have access to.
    const document = await db.speakerDocument.findFirst({
      where: { id: documentId, speakerId, speaker: { eventId } },
      select: { id: true, kind: true, url: true, filename: true },
    });
    if (!document) {
      apiLogger.warn({ msg: "speaker-document-delete:not-found", eventId, speakerId, documentId, userId: session.user.id });
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    await db.speakerDocument.delete({ where: { id: document.id } });

    if (document.url.startsWith("/uploads/speaker-docs/")) {
      const abs = path.resolve(process.cwd(), "public", document.url.slice(1));
      await fs.unlink(abs).catch((err) =>
        apiLogger.warn({ err, msg: "speaker-document-delete:unlink-failed", abs }),
      );
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "DELETE",
          entityType: "SpeakerDocument",
          entityId: document.id,
          changes: {
            speakerId,
            kind: document.kind,
            filename: document.filename,
            ip: getClientIp(req),
          },
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "speaker-document-delete:audit-log-failed", eventId, speakerId }));

    apiLogger.info({ msg: "speaker-documents:deleted", eventId, speakerId, documentId, userId: session.user.id });
    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting speaker document" });
    return NextResponse.json({ error: "Failed to delete document" }, { status: 500 });
  }
}
