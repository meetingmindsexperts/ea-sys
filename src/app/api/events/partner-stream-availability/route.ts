import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { partnerStreamReadiness } from "@/lib/webinar/partner-stream-readiness";

/**
 * Whether the new-event form may offer "streamed by a partner" (Nov 16, 2026;
 * external streams step 5). The form is a client component, so it asks here
 * instead of reading the environment. Only the yes or no: which setting is
 * missing is for the administrator and the log, not for the person creating
 * an event. The events POST refuses on the same answer.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const gate = requirePermission(session, "events.create", { route: "events/partner-stream-availability:GET" });
    if (!gate.ok) return gate.response;

    const readiness = partnerStreamReadiness();
    if (!readiness.ready) {
      apiLogger.info({ userId: session.user.id, missing: readiness.missing }, "events:partner-stream-choice-not-offered");
    }
    return NextResponse.json({ offered: readiness.ready });
  } catch (error) {
    apiLogger.error({ err: error }, "events:partner-stream-availability-failed");
    return NextResponse.json({ error: "Failed to read partner stream availability" }, { status: 500 });
  }
}
