/**
 * One live poll, producer side (Oct 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md §5).
 *
 *   PATCH { action: "launch" | "close" }   open it (closing any other open
 *         poll on the session) or close it; launching needs the webinar's
 *         "Enable live polls" switch on
 *   PATCH { showResults: boolean }        show or hide results to attendees
 *   PATCH { question, options, allowMultiple }  edit, drafts only
 *   DELETE                                 drafts, or polls nobody answered;
 *         answered polls are kept as records
 *
 * All need webinar.manage; the poll must be this event's room-session poll.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenant } from "@/lib/tenant-context";
import { pollDraftSchema } from "@/lib/webinar/live-polls";
import { pollContextFor } from "@/lib/webinar/live-polls-server";

type RouteParams = { params: Promise<{ eventId: string; pollId: string }> };

const patchSchema = z.union([
  z.object({ action: z.enum(["launch", "close"]) }).strict(),
  z.object({ showResults: z.boolean() }).strict(),
  pollDraftSchema.strict(),
]);

async function gateFor(session: Session, eventId: string, route: string) {
  const orgGuard = requireOrgId(session, { route });
  if ("error" in orgGuard) return { error: orgGuard.error };
  const gate = requirePermission(session, "webinar.manage", { route, eventId });
  if (!gate.ok) return { error: gate.response };
  return { orgId: orgGuard.orgId, gate };
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const ROUTE = "events/[eventId]/webinar/polls/[pollId]:PATCH";
  try {
    const [session, { eventId, pollId }, body] = await Promise.all([auth(), params, req.json().catch(() => ({}))]);
    if (!session?.user) {
      apiLogger.warn({ eventId, pollId }, "live-polls:unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const g = await gateFor(session, eventId, ROUTE);
    if ("error" in g) return g.error;
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten(), pollId }, "live-polls:patch-validation-failed");
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    }

    return await runWithTenant(g.orgId, async () => {
      const ctx = await pollContextFor(g.gate.eventWhere);
      if (!ctx?.sessionId) {
        apiLogger.warn({ eventId, pollId }, "live-polls:event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const poll = await db.livePoll.findFirst({
        where: { id: pollId, eventId: ctx.eventId, sessionId: ctx.sessionId },
        select: { id: true, status: true },
      });
      if (!poll) {
        apiLogger.warn({ eventId, pollId }, "live-polls:poll-not-found");
        return NextResponse.json({ error: "Poll not found" }, { status: 404 });
      }
      const data = parsed.data;

      if ("action" in data && data.action === "launch") {
        if (!ctx.enabled) {
          apiLogger.warn({ eventId, pollId }, "live-polls:launch-polls-off");
          return NextResponse.json(
            { error: "Live polls are switched off for this webinar. Turn on \"Enable live polls\" first.", code: "POLLS_OFF" },
            { status: 409 },
          );
        }
        // One open poll at a time: close the others in the same write.
        await tenantTransaction(async (tx) => {
          await tx.livePoll.updateMany({
            where: { sessionId: ctx.sessionId!, eventId: ctx.eventId, status: "OPEN", id: { not: pollId } },
            data: { status: "CLOSED", closedAt: new Date() },
          });
          await tx.livePoll.update({ where: { id: pollId }, data: { status: "OPEN", openedAt: new Date(), closedAt: null } });
        });
        apiLogger.info({ eventId, pollId, userId: session.user.id }, "live-polls:launched");
        return NextResponse.json({ ok: true });
      }
      if ("action" in data) {
        if (poll.status !== "OPEN") {
          apiLogger.warn({ eventId, pollId, status: poll.status }, "live-polls:close-not-open");
          return NextResponse.json({ error: "This poll is not open." }, { status: 409 });
        }
        await db.livePoll.update({ where: { id: pollId }, data: { status: "CLOSED", closedAt: new Date() } });
        apiLogger.info({ eventId, pollId, userId: session.user.id }, "live-polls:closed");
        return NextResponse.json({ ok: true });
      }
      if ("showResults" in data) {
        await db.livePoll.update({ where: { id: pollId }, data: { showResults: data.showResults } });
        apiLogger.info({ eventId, pollId, showResults: data.showResults, userId: session.user.id }, "live-polls:results-visibility");
        return NextResponse.json({ ok: true });
      }
      // Edit: drafts only, so nobody's answer ever refers to changed options.
      if (poll.status !== "DRAFT") {
        apiLogger.warn({ eventId, pollId, status: poll.status }, "live-polls:edit-not-draft");
        return NextResponse.json({ error: "Only a draft can be edited." }, { status: 409 });
      }
      await db.livePoll.update({
        where: { id: pollId },
        data: {
          question: data.question,
          options: data.options.map((label) => ({ id: randomUUID().slice(0, 8), label })),
          allowMultiple: data.allowMultiple,
        },
      });
      apiLogger.info({ eventId, pollId, userId: session.user.id }, "live-polls:edited");
      return NextResponse.json({ ok: true });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "live-polls:patch-failed");
    return NextResponse.json({ error: "Failed to update the poll" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  const ROUTE = "events/[eventId]/webinar/polls/[pollId]:DELETE";
  try {
    const [session, { eventId, pollId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      apiLogger.warn({ eventId, pollId }, "live-polls:unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const g = await gateFor(session, eventId, ROUTE);
    if ("error" in g) return g.error;

    return await runWithTenant(g.orgId, async () => {
      const ctx = await pollContextFor(g.gate.eventWhere);
      if (!ctx?.sessionId) {
        apiLogger.warn({ eventId, pollId }, "live-polls:event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const poll = await db.livePoll.findFirst({
        where: { id: pollId, eventId: ctx.eventId, sessionId: ctx.sessionId },
        select: { id: true, _count: { select: { votes: true } } },
      });
      if (!poll) {
        apiLogger.warn({ eventId, pollId }, "live-polls:poll-not-found");
        return NextResponse.json({ error: "Poll not found" }, { status: 404 });
      }
      if (poll._count.votes > 0) {
        apiLogger.warn({ eventId, pollId, votes: poll._count.votes }, "live-polls:delete-has-votes");
        return NextResponse.json(
          { error: `${poll._count.votes} people answered this poll, so it is kept as a record. Export it if you need the answers.` },
          { status: 409 },
        );
      }
      await db.livePoll.delete({ where: { id: pollId } });
      apiLogger.info({ eventId, pollId, userId: session.user.id }, "live-polls:deleted");
      return NextResponse.json({ ok: true });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "live-polls:delete-failed");
    return NextResponse.json({ error: "Failed to delete the poll" }, { status: 500 });
  }
}
