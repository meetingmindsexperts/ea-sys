/**
 * GET /api/agent/messages
 *
 *   The Event Agent's stored conversations: what each person asked, what the
 *   agent replied, and every tool call with its exact input (owner decision,
 *   Sep 21, 2026: "I need messages list"). SUPER_ADMIN ONLY through
 *   denyNonOperator and cross-tenant on dbOperator, exactly like
 *   /api/help-chat/queries, because the operator's question is "what does
 *   everyone ask and where does it fail". The text carries attendee data, so
 *   this is the single read surface for it, and the rows leave through the
 *   180-day agent-run prune.
 *
 *   query params:
 *     q        optional free text; case-insensitive match on message OR reply
 *     outcome  optional AgentRunOutcome (COMPLETED | ERROR | TURN_LIMIT | RUNNING)
 *     page     1-based page (default 1)
 *     limit    page size (default 25, max 100)
 *
 *   response: { runs: AgentMessageRow[], total, page, limit }
 *   errors: 400 unknown outcome · 401 no session · 403 not the operator
 *
 *   Tenancy: deliberately NOT in a tenant lane (the operator-global read
 *   class, listed in OPERATOR_LANE_ALLOWLIST in check-tenant-als.sh). The
 *   platform must serve this route from the privileged lane; inert on master.
 */

import { NextResponse, type NextRequest } from "next/server";
import { AgentRunOutcome } from "@prisma/client";
import { auth } from "@/lib/auth";
import { dbOperator } from "@/lib/db";
import { denyNonOperator } from "@/lib/platform-operator";
import { apiLogger } from "@/lib/logger";
import { escapeLike } from "@/lib/like-escape";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const OUTCOMES = new Set<string>(Object.values(AgentRunOutcome));

function unique(ids: (string | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "agent-messages:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Both walls: denyNonOperator is the RBAC one, dbOperator below the
  // database one. This reads across every tenant, so it needs both.
  const denied = denyNonOperator(session, { route: "agent:messages" });
  if (denied) return denied;

  const { searchParams } = req.nextUrl;
  const q = (searchParams.get("q") ?? "").trim();
  const outcomeRaw = searchParams.get("outcome");
  if (outcomeRaw && !OUTCOMES.has(outcomeRaw)) {
    // A bad filter must never widen the list to everything (the bulk-email lesson).
    apiLogger.warn({ msg: "agent-messages:invalid-outcome", userId: session.user.id, outcome: outcomeRaw.slice(0, 40) });
    return NextResponse.json({ error: "Unknown outcome filter", code: "INVALID_OUTCOME" }, { status: 400 });
  }
  const outcome = outcomeRaw ? (outcomeRaw as AgentRunOutcome) : null;
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(searchParams.get("limit")) || DEFAULT_LIMIT));

  const where = {
    ...(outcome ? { outcome } : {}),
    ...(q
      ? {
          OR: [
            { message: { contains: escapeLike(q), mode: "insensitive" as const } },
            { reply: { contains: escapeLike(q), mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  try {
    const [rows, total] = await Promise.all([
      dbOperator.agentRun.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          organizationId: true,
          userId: true,
          role: true,
          eventId: true,
          route: true,
          message: true,
          reply: true,
          historyPairs: true,
          approvedTool: true,
          model: true,
          outcome: true,
          errorClass: true,
          turns: true,
          toolCalls: true,
          writes: true,
          refusals: true,
          approvalsRequested: true,
          approvalsRun: true,
          toolErrors: true,
          inputTokens: true,
          outputTokens: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          steps: {
            orderBy: { seq: "asc" },
            select: { seq: true, tool: true, outcome: true, code: true, write: true, approved: true, durationMs: true, input: true },
          },
        },
      }),
      dbOperator.agentRun.count({ where }),
    ]);

    // The run keeps scalar ids so it outlives the account and the event it
    // named; the names are resolved once per page, and a deleted one reads
    // as null rather than failing the page.
    const userIds = unique(rows.map((r) => r.userId));
    const eventIds = unique(rows.map((r) => r.eventId));
    const orgIds = unique(rows.map((r) => r.organizationId));
    const [users, events, orgs] = await Promise.all([
      userIds.length ? dbOperator.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true, email: true } }) : [],
      eventIds.length ? dbOperator.event.findMany({ where: { id: { in: eventIds } }, select: { id: true, name: true } }) : [],
      orgIds.length ? dbOperator.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }) : [],
    ]);
    const userById = new Map(users.map((u) => [u.id, { name: `${u.firstName} ${u.lastName}`.trim() || null, email: u.email }]));
    const eventById = new Map(events.map((e) => [e.id, { name: e.name }]));
    const orgById = new Map(orgs.map((o) => [o.id, { name: o.name }]));

    const runs = rows.map((r) => ({
      ...r,
      user: userById.get(r.userId) ?? null,
      event: r.eventId ? (eventById.get(r.eventId) ?? null) : null,
      organization: orgById.get(r.organizationId) ?? null,
    }));

    return NextResponse.json({ runs, total, page, limit });
  } catch (err) {
    apiLogger.error({ msg: "agent-messages:fetch-failed", userId: session.user.id, err });
    return NextResponse.json({ error: "Failed to load agent messages." }, { status: 500 });
  }
}
