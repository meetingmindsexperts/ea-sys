/**
 * Live polls, producer side (Oct 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md §5).
 *
 *   GET   the webinar's polls with live tallies (webinar.analytics.read)
 *   POST  { question, options[], allowMultiple } create a draft (webinar.manage)
 *
 * Polls belong to the webinar's room session, looked up through the gate's
 * eventWhere. Every refusal logs.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { pollDraftSchema } from "@/lib/webinar/live-polls";
import { listPollsWithTally, pollContextFor } from "@/lib/webinar/live-polls-server";

type RouteParams = { params: Promise<{ eventId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  const ROUTE = "events/[eventId]/webinar/polls:GET";
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      apiLogger.warn({ eventId }, "live-polls:unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.analytics.read", { route: ROUTE, eventId, onMissing: "hide" });
    if (!gate.ok) return gate.response;

    return await runWithTenant(orgGuard.orgId, async () => {
      const ctx = await pollContextFor(gate.eventWhere);
      if (!ctx) {
        apiLogger.warn({ eventId, userId: session.user.id }, "live-polls:event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      if (!ctx.sessionId) return NextResponse.json({ polls: [] });
      return NextResponse.json({ polls: await listPollsWithTally(ctx.eventId, ctx.sessionId) });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "live-polls:list-failed");
    return NextResponse.json({ error: "Failed to load the polls" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  const ROUTE = "events/[eventId]/webinar/polls:POST";
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json().catch(() => ({}))]);
    if (!session?.user) {
      apiLogger.warn({ eventId }, "live-polls:unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    const { allowed, retryAfterSeconds } = checkRateLimit({ key: `live-poll-create:${session.user.id}`, limit: 120, windowMs: 3600_000 });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "live-polls:rate-limited");
      return NextResponse.json({ error: "Too many requests", retryAfterSeconds }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } });
    }
    const parsed = pollDraftSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten() }, "live-polls:validation-failed");
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid poll" }, { status: 400 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const ctx = await pollContextFor(gate.eventWhere);
      if (!ctx) {
        apiLogger.warn({ eventId, userId: session.user.id }, "live-polls:event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      if (!ctx.sessionId) {
        apiLogger.warn({ eventId }, "live-polls:no-webinar-session");
        return NextResponse.json({ error: "This event has no webinar session yet. Run the provisioner first." }, { status: 400 });
      }
      const poll = await db.livePoll.create({
        data: {
          eventId: ctx.eventId,
          organizationId: ctx.organizationId,
          sessionId: ctx.sessionId,
          question: parsed.data.question,
          options: parsed.data.options.map((label) => ({ id: randomUUID().slice(0, 8), label })),
          allowMultiple: parsed.data.allowMultiple,
        },
        select: { id: true },
      });
      apiLogger.info({ eventId, pollId: poll.id, userId: session.user.id }, "live-polls:created");
      return NextResponse.json({ id: poll.id }, { status: 201 });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "live-polls:create-failed");
    return NextResponse.json({ error: "Failed to create the poll" }, { status: 500 });
  }
}
