import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { deleteMedia } from "@/lib/storage";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ eventId: string; mediaId: string }> }
) {
  try {
    const [session, { eventId, mediaId }] = await Promise.all([auth(), params]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, mediaFile] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, ...buildEventAccessWhere(session.user) },
        select: { id: true },
      }),
      db.mediaFile.findFirst({
        where: { id: mediaId, eventId },
        select: { id: true, url: true, filename: true },
      }),
    ]);

    if (!event) {
      apiLogger.warn({ msg: "Event media delete: event not found or access denied", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!mediaFile) {
      apiLogger.warn({ msg: "Event media delete: file not found", mediaId, eventId, userId: session.user.id });
      return NextResponse.json({ error: "Media file not found" }, { status: 404 });
    }

    await Promise.all([
      deleteMedia(mediaFile.url).catch((err) => {
        apiLogger.warn({ msg: "Failed to delete event media from storage", mediaId, url: mediaFile.url, err: err instanceof Error ? err.message : String(err) });
      }),
      db.mediaFile.delete({ where: { id: mediaId } }),
    ]);

    apiLogger.info({ msg: "Event media file deleted", mediaId, eventId, filename: mediaFile.filename, userId: session.user.id });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting event media file" });
    return NextResponse.json({ error: "Failed to delete media file" }, { status: 500 });
  }
}
