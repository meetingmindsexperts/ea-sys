import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { deleteMedia } from "@/lib/storage";

type RouteParams = { params: Promise<{ mediaId: string }> };

/**
 * DELETE /api/media/[mediaId] — Delete a media file
 */
export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ mediaId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const mediaFile = await db.mediaFile.findFirst({
      where: { id: mediaId, organizationId: session.user.organizationId! },
      select: { id: true, url: true, filename: true },
    });

    if (!mediaFile) {
      return NextResponse.json({ error: "Media file not found" }, { status: 404 });
    }

    // Delete from storage + database in parallel
    await Promise.all([
      deleteMedia(mediaFile.url).catch((err) => {
        apiLogger.warn({ msg: "Failed to delete media file from storage", mediaId, url: mediaFile.url, err: err instanceof Error ? err.message : String(err) });
      }),
      db.mediaFile.delete({ where: { id: mediaId } }),
    ]);

    apiLogger.info({ msg: "Media file deleted", mediaId, filename: mediaFile.filename, userId: session.user.id });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting media file" });
    return NextResponse.json({ error: "Failed to delete media file" }, { status: 500 });
  }
}
