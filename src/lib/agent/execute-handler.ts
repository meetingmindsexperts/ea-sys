// The Event Agent's HTTP handler body, shared by the org-level route
// (POST /api/agent/execute) and the per-event alias
// (POST /api/events/[eventId]/agent/execute). The route files call auth()
// and requireOrgId themselves, then hand the session here.

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import type { Session } from "next-auth";
import { checkRateLimit } from "@/lib/security";
import { apiLogger } from "@/lib/logger";
import { rateLimited, zodErrorResponse } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { canViewFinance } from "@/lib/finance-visibility";
import { runAgentRequest, type AgentSseEvent } from "./run-agent";

import { AGENT_ROLES } from "./agent-roles";

export { AGENT_ROLES };

const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_PAIRS = 20;
const MAX_HISTORY_MSG_LENGTH = 8000;

export const agentExecuteBodySchema = z.object({
  message: z.string().trim().min(1, "message is required").max(MAX_MESSAGE_LENGTH),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .max(MAX_HISTORY_PAIRS * 2)
    .optional(),
  /** Org-level door only: the event the conversation is about, if any. */
  eventId: z.string().min(1).max(64).nullable().optional(),
});

export interface ExecuteAgentOptions {
  /** The alias route binds the event from the URL; the org route reads the body. */
  eventIdFromRoute?: string;
  route: string;
}

export async function executeAgentRequest(
  req: Request,
  session: Session,
  orgId: string,
  opts: ExecuteAgentOptions,
): Promise<Response> {
  const role = session.user.role;
  if (!(AGENT_ROLES as readonly string[]).includes(role)) {
    apiLogger.warn({ msg: "agent:role-refused", route: opts.route, userId: session.user.id, role });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const readOnly = role === "MEMBER";
  const blockFinance = !canViewFinance(role);

  // 20 agent requests per user per hour, shared by both routes.
  const rl = checkRateLimit({ key: `agent-${session.user.id}`, limit: 20, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) {
    return rateLimited(rl, {
      route: opts.route,
      message: `Rate limit reached. Please wait ${rl.retryAfterSeconds} seconds.`,
      userId: session.user.id,
      limit: 20,
      windowSeconds: 3600,
    });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    apiLogger.warn({ msg: "agent:invalid-json", route: opts.route, userId: session.user.id });
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = agentExecuteBodySchema.safeParse(raw);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: opts.route, userId: session.user.id });
  }

  const eventId = opts.eventIdFromRoute ?? parsed.data.eventId ?? null;
  if (eventId) {
    // Fail fast before spending model tokens: the event must be this org's.
    const event = await db.event.findFirst({ where: { id: eventId, organizationId: orgId }, select: { id: true } });
    if (!event) {
      apiLogger.warn({ msg: "agent:event-not-found", route: opts.route, userId: session.user.id, eventId });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
  }

  const history: MessageParam[] = (parsed.data.history ?? [])
    .filter((m) => m.content.length > 0)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_MSG_LENGTH) }))
    .slice(-MAX_HISTORY_PAIRS * 2);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: AgentSseEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Client disconnected.
        }
      };
      try {
        await runAgentRequest({
          organizationId: orgId,
          eventId,
          actor: { userId: session.user.id, role, fromApiKey: false },
          message: parsed.data.message,
          history,
          readOnly,
          blockFinance,
          send,
        });
        send({ type: "done" });
      } catch (err) {
        apiLogger.error({ err, route: opts.route, eventId, userId: session.user.id }, "agent:execute failed");
        // Mask provider-specific details; never leak API internals to the client.
        const msg =
          err instanceof Anthropic.APIError
            ? `AI provider error (${err.status}). Please try again.`
            : "An unexpected error occurred. Please try again.";
        send({ type: "error", message: msg });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering for SSE (EC2/Docker)
    },
  });
}
