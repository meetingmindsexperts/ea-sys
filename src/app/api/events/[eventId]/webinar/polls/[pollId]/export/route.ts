/**
 * GET a live poll's results as CSV (Oct 6, 2026): the counts per option, then
 * each person's answer (name, email, choices, time). Personal data, so it
 * needs webinar.attendance.export (the attendance export's key) and is
 * recorded as an export.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordExport } from "@/lib/audit-data-transfer";
import { escapeCsvCell } from "@/lib/csv-escape";
import { requireOrgId } from "@/lib/require-org";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenant } from "@/lib/tenant-context";
import { percentOf, readChoices, readPollOptions, tallyPoll } from "@/lib/webinar/live-polls";
import { pollContextFor } from "@/lib/webinar/live-polls-server";

type RouteParams = { params: Promise<{ eventId: string; pollId: string }> };

const row = (cells: (string | number | null | undefined)[]) => cells.map((c) => escapeCsvCell(c == null ? "" : String(c))).join(",");

export async function GET(req: Request, { params }: RouteParams) {
  const ROUTE = "events/[eventId]/webinar/polls/[pollId]/export:GET";
  try {
    const [session, { eventId, pollId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      apiLogger.warn({ eventId, pollId }, "live-polls:unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.attendance.export", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    return await runWithTenant(orgGuard.orgId, async () => {
      const ctx = await pollContextFor(gate.eventWhere);
      if (!ctx?.sessionId) {
        apiLogger.warn({ eventId, pollId }, "live-polls:event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const poll = await db.livePoll.findFirst({
        where: { id: pollId, eventId: ctx.eventId, sessionId: ctx.sessionId },
        select: { id: true, question: true, options: true },
      });
      if (!poll) {
        apiLogger.warn({ eventId, pollId }, "live-polls:poll-not-found");
        return NextResponse.json({ error: "Poll not found" }, { status: 404 });
      }
      const votes = await db.livePollVote.findMany({
        where: { pollId },
        orderBy: { createdAt: "asc" },
        select: {
          choices: true,
          createdAt: true,
          registration: { select: { serialId: true, status: true, attendee: { select: { firstName: true, lastName: true, email: true } } } },
        },
      });
      const options = readPollOptions(poll.options);
      const label = new Map(options.map((o) => [o.id, o.label]));
      // Counts leave out cancelled registrations (as on screen); their rows stay
      // below, marked, as the record of who answered.
      const tally = tallyPoll(options, votes.filter((v) => v.registration.status !== "CANCELLED"));
      const lines = [
        row(["Question", poll.question]),
        row(["Voters", tally.voters]),
        "",
        row(["Option", "Votes", "Percent"]),
        ...options.map((o) => row([o.label, tally.counts[o.id], `${percentOf(tally.counts[o.id], tally.voters)}%`])),
        "",
        row(["Name", "Email", "Registration #", "Registration status", "Answer", "Answered at (UTC)"]),
        ...votes.map((v) =>
          row([
            `${v.registration.attendee.firstName} ${v.registration.attendee.lastName}`.trim(),
            v.registration.attendee.email,
            v.registration.serialId ?? "",
            v.registration.status === "CANCELLED" ? "Cancelled (not counted)" : v.registration.status,
            readChoices(v.choices).map((c) => label.get(c) ?? c).join("; "),
            v.createdAt.toISOString(),
          ]),
        ),
      ];
      recordExport(req, {
        entityType: "LivePollVote",
        eventId: ctx.eventId,
        organizationId: orgGuard.orgId,
        userId: session.user.id,
        role: session.user.role,
        rowCount: votes.length,
        format: "csv",
      });
      apiLogger.info({ eventId, pollId, rows: votes.length, userId: session.user.id }, "live-polls:exported");
      return new NextResponse(lines.join("\n"), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="poll-${pollId}.csv"`,
          "Cache-Control": "private, no-store",
        },
      });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "live-polls:export-failed");
    return NextResponse.json({ error: "Failed to export the poll" }, { status: 500 });
  }
}
