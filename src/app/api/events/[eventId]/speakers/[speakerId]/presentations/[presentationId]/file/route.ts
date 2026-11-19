/**
 * Staff: the file itself, on the LOCAL storage provider only (development and
 * the test server), where there is no bucket to sign a form for. On S3 the
 * service answers 404, so the app never carries a large body (Nov 19, 2026).
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { presentationRefusal, readUploadedFile } from "@/lib/speaker-presentation-http";
import { presentationFileRouteAvailable, receiveLocalPresentationFile } from "@/services/speaker-presentation-service";
import { loadStaffSpeaker } from "../../_staff";

interface RouteParams {
  params: Promise<{ eventId: string; speakerId: string; presentationId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [p, session] = await Promise.all([params, auth()]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const route = "events/[eventId]/speakers/[speakerId]/presentations/[presentationId]/file:POST";
    const gate = requirePermission(session, "speakers.documents.write", { route, eventId: p.eventId });
    if (!gate.ok) return gate.response;
    const userId = session.user.id;

    return await runWithTenantLane(session.user.organizationId, { route: "speakers:presentations", userId }, async () => {
      const scope = await loadStaffSpeaker(gate, p.eventId, p.speakerId);
      if (!scope) {
        apiLogger.warn({ msg: "speaker-presentations:not-found", route, eventId: p.eventId, speakerId: p.speakerId, userId });
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }
      // Before the body is read: on S3 the app never buffers a file.
      if (!presentationFileRouteAvailable()) {
        apiLogger.warn({ msg: "speaker-presentations:file-route-off", eventId: scope.eventId, speakerId: scope.speakerId });
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const bytes = await readUploadedFile(req);
      if (!bytes) {
        apiLogger.warn({ msg: "speaker-presentations:no-file", eventId: scope.eventId, speakerId: scope.speakerId });
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
      }
      const result = await receiveLocalPresentationFile({ ...scope, presentationId: p.presentationId, bytes });
      if (!result.ok) {
        apiLogger.warn({ msg: "speaker-presentations:file-refused", code: result.code, eventId: scope.eventId, speakerId: scope.speakerId });
        return presentationRefusal(result);
      }
      return new NextResponse(null, { status: 204 });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "speaker-presentations:post-failed" });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
