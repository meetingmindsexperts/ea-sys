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
import { getModelConfig } from "@/lib/ai/config";
import { runAgentRequest, type AgentSseEvent } from "./run-agent";
import { verifyApprovalToken } from "./approval-token";
import { MAX_STORED_REPLY_LENGTH, startAgentRun } from "./run-store";

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
  /** The call the person approved on the page, with the token the loop minted for it. */
  approval: z
    .object({
      toolName: z.string().min(1).max(100),
      input: z.record(z.string(), z.unknown()),
      token: z.string().min(16).max(4000),
    })
    .optional(),
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

  let approvedCall: { toolName: string; input: Record<string, unknown> } | undefined;
  if (parsed.data.approval) {
    const { toolName, input, token } = parsed.data.approval;
    const verdict = verifyApprovalToken(token, { userId: session.user.id, organizationId: orgId, eventId, toolName, input });
    if (!verdict.ok) {
      apiLogger.warn({ msg: "agent:approval-rejected", route: opts.route, userId: session.user.id, eventId, tool: toolName, reason: verdict.reason });
      return NextResponse.json(
        { error: verdict.reason === "expired" ? "This approval has expired. Ask again and approve within ten minutes." : "This approval does not match the call.", code: "APPROVAL_INVALID" },
        { status: 400 },
      );
    }
    approvedCall = { toolName, input };
  }

  const history: MessageParam[] = (parsed.data.history ?? [])
    .filter((m) => m.content.length > 0)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_MSG_LENGTH) }))
    .slice(-MAX_HISTORY_PAIRS * 2);

  // The stored run: names, counts, tokens, and since the messages page
  // (owner decision, Sep 21, 2026) the message itself. A recording failure
  // hands back a no-op recorder; the request runs.
  const run = await startAgentRun({
    organizationId: orgId,
    userId: session.user.id,
    role,
    eventId,
    route: opts.eventIdFromRoute ? "event" : "org",
    message: parsed.data.message,
    messageLength: parsed.data.message.length,
    historyPairs: Math.floor(history.length / 2),
    approvedTool: approvedCall?.toolName ?? null,
    model: getModelConfig("agent").model,
  });

  const encoder = new TextEncoder();
  // The agent's reply, assembled from the text the page receives, for the
  // stored run. Capped at what the recorder keeps so a runaway stream cannot
  // grow this buffer; a partial reply on an error is exactly what the
  // messages page wants to show.
  const replyParts: string[] = [];
  let replyChars = 0;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: AgentSseEvent) => {
        if (event.type === "text_delta" && replyChars < MAX_STORED_REPLY_LENGTH) {
          replyParts.push(event.text);
          replyChars += event.text.length;
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Client disconnected.
        }
      };
      try {
        const ended = await runAgentRequest({
          organizationId: orgId,
          eventId,
          actor: { userId: session.user.id, role, fromApiKey: false },
          message: parsed.data.message,
          history,
          readOnly,
          blockFinance,
          approvedCall,
          run,
          send,
        });
        send({ type: "done" });
        await run.finish(ended === "turn_limit" ? "TURN_LIMIT" : "COMPLETED", undefined, { reply: replyParts.join("") });
      } catch (err) {
        apiLogger.error({ err, route: opts.route, eventId, userId: session.user.id }, "agent:execute failed");
        const providerErr = err instanceof Anthropic.APIError ? err : null;
        // Mask provider-specific details; never leak API internals to the client.
        const msg = providerErr
          ? `AI provider error (${providerErr.status}). Please try again.`
          : "An unexpected error occurred. Please try again.";
        send({ type: "error", message: msg });
        await run.finish("ERROR", providerErr ? "provider" : "unexpected", { reply: replyParts.join("") });
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
