// The org-level door of the Event Agent (architecture review §4.2). The
// event is optional: the page passes it when opened from an event, and the
// model otherwise finds one with list_events or search_event. The per-event
// route is an alias of this one with the event bound from the URL.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { executeAgentRequest } from "@/lib/agent/execute-handler";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const orgGuard = requireOrgId(session, { route: "agent/execute:POST" });
  if ("error" in orgGuard) return orgGuard.error;

  return executeAgentRequest(req, session, orgGuard.orgId, { route: "agent/execute" });
}
