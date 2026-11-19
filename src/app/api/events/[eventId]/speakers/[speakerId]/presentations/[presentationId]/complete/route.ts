/**
 * Staff: the upload has finished. The service checks the file that landed
 * (it exists, its size, its signature) before it counts (Nov 19, 2026).
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { presentationRefusal } from "@/lib/speaker-presentation-http";
import { completePresentationUpload } from "@/services/speaker-presentation-service";
import { loadStaffSpeaker } from "../../_staff";

interface RouteParams {
  params: Promise<{ eventId: string; speakerId: string; presentationId: string }>;
}

export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [p, session] = await Promise.all([params, auth()]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const route = "events/[eventId]/speakers/[speakerId]/presentations/[presentationId]/complete:POST";
    const gate = requirePermission(session, "speakers.documents.write", { route, eventId: p.eventId });
    if (!gate.ok) return gate.response;
    const userId = session.user.id;

    return await runWithTenantLane(session.user.organizationId, { route: "speakers:presentations", userId }, async () => {
      const scope = await loadStaffSpeaker(gate, p.eventId, p.speakerId);
      if (!scope) {
        apiLogger.warn({ msg: "speaker-presentations:not-found", route, eventId: p.eventId, speakerId: p.speakerId, userId });
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }
      const result = await completePresentationUpload({ ...scope, presentationId: p.presentationId, actor: { source: "staff", userId } });
      if (!result.ok) return presentationRefusal(result);
      return NextResponse.json({ presentation: result.presentation });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "speaker-presentations:post-failed" });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
