import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * GET — the signed-in SUBMITTER's surface context for this event:
 * `{ submitterSource, abstractCount, proposalCount }`.
 *
 * Powers the submitter surface separation (July 30, 2026): the sidebar and the
 * page-level redirect guard both feed this into src/lib/submitter-surfaces.ts
 * to decide whether this person sees Abstracts, Session Proposals, or both.
 * Own-speaker only by construction (resolved via userId) — no ids accepted.
 */

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (session.user.role !== "SUBMITTER") {
      apiLogger.warn({
        msg: "submitter-context:non-submitter",
        eventId,
        userId: session.user.id,
        role: session.user.role,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const speaker = await db.speaker.findFirst({
      where: { eventId, userId: session.user.id },
      select: {
        submitterSource: true,
        _count: { select: { abstracts: true, sessionProposals: true } },
      },
    });

    if (!speaker) {
      // A SUBMITTER with no speaker on this event has no surface here at all —
      // the caller treats this as "not linked" (buildEventAccessWhere wouldn't
      // have granted them the event anyway).
      apiLogger.warn({
        msg: "submitter-context:no-speaker",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Not linked to this event" }, { status: 404 });
    }

    return NextResponse.json({
      submitterSource: speaker.submitterSource,
      abstractCount: speaker._count.abstracts,
      proposalCount: speaker._count.sessionProposals,
    });
  } catch (err) {
    apiLogger.error({ err }, "submitter-context:GET failed");
    return NextResponse.json({ error: "Failed to load submitter context" }, { status: 500 });
  }
}
