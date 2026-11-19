/**
 * Staff: download one presentation, or remove it (Nov 19, 2026).
 *
 *   GET    answers a redirect to a short-lived signed link for the version
 *          that was checked; the bucket itself is never public
 *   DELETE removes a file that should not be there
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { storageErrorResponse } from "@/lib/api-errors";
import { contentDisposition } from "@/lib/download-filename";
import { readStoredFile } from "@/lib/storage";
import { presentationRefusal } from "@/lib/speaker-presentation-http";
import { deleteSpeakerPresentation, presentationDownload } from "@/services/speaker-presentation-service";
import { loadStaffSpeaker } from "../_staff";

interface RouteParams {
  params: Promise<{ eventId: string; speakerId: string; presentationId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [p, session] = await Promise.all([params, auth()]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const route = "events/[eventId]/speakers/[speakerId]/presentations/[presentationId]:GET";
    const gate = requirePermission(session, "speakers.documents.read", { route, eventId: p.eventId });
    if (!gate.ok) return gate.response;
    const userId = session.user.id;

    return await runWithTenantLane(session.user.organizationId, { route: "speakers:presentations", userId }, async () => {
      const scope = await loadStaffSpeaker(gate, p.eventId, p.speakerId);
      if (!scope) {
        apiLogger.warn({ msg: "speaker-presentations:not-found", route, eventId: p.eventId, speakerId: p.speakerId, userId });
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }
      const result = await presentationDownload({ ...scope, presentationId: p.presentationId });
      if (!result.ok) {
        apiLogger.warn({ msg: "speaker-presentations:download-not-found", eventId: scope.eventId, speakerId: scope.speakerId, presentationId: p.presentationId, userId });
        return presentationRefusal(result);
      }
      apiLogger.info({ msg: "speaker-presentations:downloaded", eventId: scope.eventId, speakerId: scope.speakerId, presentationId: p.presentationId, userId });
      if ("redirectUrl" in result) return NextResponse.redirect(result.redirectUrl, 302);

      // The local provider only: small files, streamed here.
      let file: Buffer;
      try {
        file = await readStoredFile(result.local.storedPath, result.local.requirePrefix);
      } catch (err) {
        const res = storageErrorResponse(err, { route: "speaker-presentation", notFoundMessage: "Presentation not found", eventId: scope.eventId, presentationId: p.presentationId });
        if (res) return res;
        throw err;
      }
      return new NextResponse(new Uint8Array(file), {
        headers: {
          "Content-Type": result.local.mimeType,
          "Content-Disposition": contentDisposition(result.local.filename, "attachment"),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "speaker-presentations:get-failed" });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const [p, session] = await Promise.all([params, auth()]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const route = "events/[eventId]/speakers/[speakerId]/presentations/[presentationId]:DELETE";
    const gate = requirePermission(session, "speakers.documents.write", { route, eventId: p.eventId });
    if (!gate.ok) return gate.response;
    const userId = session.user.id;

    return await runWithTenantLane(session.user.organizationId, { route: "speakers:presentations", userId }, async () => {
      const scope = await loadStaffSpeaker(gate, p.eventId, p.speakerId);
      if (!scope) {
        apiLogger.warn({ msg: "speaker-presentations:not-found", route, eventId: p.eventId, speakerId: p.speakerId, userId });
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }
      const result = await deleteSpeakerPresentation({ ...scope, presentationId: p.presentationId, actor: { source: "staff", userId } });
      if (!result.ok) {
        apiLogger.warn({ msg: "speaker-presentations:delete-not-found", eventId: scope.eventId, speakerId: scope.speakerId, presentationId: p.presentationId });
        return presentationRefusal(result);
      }
      return NextResponse.json({ ok: true });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "speaker-presentations:delete-failed" });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
