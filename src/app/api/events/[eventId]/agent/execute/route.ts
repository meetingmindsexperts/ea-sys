// Per-event alias of POST /api/agent/execute: the event comes from the URL
// instead of the body, so the event page keeps working unchanged. The loop,
// the tool registry, the gate and the prompt all live in src/lib/agent.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { executeAgentRequest } from "@/lib/agent/execute-handler";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const [session, { eventId }] = await Promise.all([auth(), params]);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const orgGuard = requireOrgId(session, { route: "events/[eventId]/agent/execute:POST" });
  if ("error" in orgGuard) return orgGuard.error;

  return executeAgentRequest(req, session, orgGuard.orgId, {
    route: "events/agent-execute",
    eventIdFromRoute: eventId,
  });
}
