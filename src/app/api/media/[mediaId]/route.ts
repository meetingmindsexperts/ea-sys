import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { deleteMedia } from "@/lib/storage";
import { findMediaReferences, mediaInUseMessage } from "@/lib/media-references";
import { runWithTenant } from "@/lib/tenant-context";

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
    const orgGuard = requireOrgId(session, { route: "media/[mediaId]:DELETE" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { route: "media/[mediaId]:DELETE" });
    if (denied) return denied;

    return await runWithTenant(orgGuard.orgId, async () => {
    const mediaFile = await db.mediaFile.findFirst({
      where: { id: mediaId, organizationId: orgGuard.orgId },
      select: { id: true, url: true, filename: true },
    });

    if (!mediaFile) {
      return NextResponse.json({ error: "Media file not found" }, { status: 404 });
    }

    // Refuse while anything still references the URL — deleting removes the
    // file from disk, so a referenced image becomes a permanent 404 in every
    // email/page that carries it (the July 23 dangling-emailFooterImage bug).
    const references = await findMediaReferences(mediaFile.url, orgGuard.orgId);
    if (references.length > 0) {
      apiLogger.warn({
        msg: "media:delete-refused-in-use",
        mediaId,
        url: mediaFile.url,
        references: references.map((r) => r.label),
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: mediaInUseMessage(references), code: "MEDIA_IN_USE", references },
        { status: 409 }
      );
    }

    // Delete from storage + database in parallel
    await Promise.all([
      deleteMedia(mediaFile.url).catch((err) => {
        apiLogger.warn({ msg: "Failed to delete media file from storage", mediaId, url: mediaFile.url, err: err instanceof Error ? err.message : String(err) });
      }),
      // Compound-where org-binds the delete (defence #1) — the previously
      // findFirst-only gap this sweep closes.
      db.mediaFile.delete({ where: { id: mediaId, organizationId: orgGuard.orgId } }),
    ]);

    apiLogger.info({ msg: "Media file deleted", mediaId, filename: mediaFile.filename, userId: session.user.id });

    return NextResponse.json({ success: true });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting media file" });
    return NextResponse.json({ error: "Failed to delete media file" }, { status: 500 });
  }
}
