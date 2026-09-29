/**
 * A new secret for one shared registration view (Sep 29, 2026): the old link
 * stops working at once. docs/REGISTRATION_SHARE_PLAN.md.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { runWithTenant } from "@/lib/tenant-context";
import { resolveShareEvent } from "@/lib/share-link-access";
import { viewErrorResponse } from "@/lib/registration-share-http";
import { listRegistrationViews, regenerateRegistrationView } from "@/services/registration-share-service";

interface RouteParams {
  params: Promise<{ eventId: string; viewId: string }>;
}

export async function POST(_req: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { eventId, viewId } = await params;
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route: "events/[eventId]/registration-shares/[viewId]/regenerate:POST", eventId });
    if (denied) return denied;
    const r = await resolveShareEvent(session, "events/[eventId]/registration-shares/[viewId]/regenerate:POST", eventId);
    if (r.error) return r.error;
    const scope = { eventId: r.event.id, slug: r.event.slug, organizationId: r.event.organizationId, userId: session.user.id };
    return await runWithTenant(r.event.organizationId, async () => {
      const result = await regenerateRegistrationView(scope, viewId);
      if (!result.ok) {
        apiLogger.warn({ msg: "registration-shares:regenerate-refused", eventId, viewId, code: result.code });
        return viewErrorResponse(result.code, result.message);
      }
      return NextResponse.json(await listRegistrationViews(r.event.id, r.event.slug));
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "registration-shares:regenerate-failed" });
    return NextResponse.json({ error: "Failed to regenerate the link" }, { status: 500 });
  }
}
