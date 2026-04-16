import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * Reviewer portal feed.
 *
 * Returns every abstract visible to the current user as a reviewer, grouped
 * by event. Union of two entry points:
 *   1) Abstracts in events where `event.settings.reviewerUserIds` contains
 *      the user's id (global event-level reviewer).
 *   2) Abstracts with an explicit `AbstractReviewer` row for this user
 *      (per-abstract assignment — workload distribution / COI flag).
 *
 * For each abstract, reports the user's own submission status so the portal
 * can render PENDING / SUBMITTED / NEEDS_UPDATE badges without a second call.
 */

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    // Pull both sources in parallel:
    //   1. Abstracts in events where the user is in settings.reviewerUserIds
    //      (event-level pool — same JSON-path filter buildEventAccessWhere
    //      uses for the REVIEWER role). Filtering at the DB avoids scanning
    //      every event in the deployment.
    //   2. Abstracts with an explicit AbstractReviewer row for this user
    //      (per-abstract assignment, independent of the pool).
    const [abstractsFromPool, explicitAssignments] = await Promise.all([
      db.abstract.findMany({
        where: {
          event: {
            status: { not: "CANCELLED" },
            settings: { path: ["reviewerUserIds"], array_contains: userId },
          },
        },
        select: {
          id: true,
          title: true,
          status: true,
          submittedAt: true,
          eventId: true,
          event: { select: { id: true, name: true, slug: true, startDate: true, endDate: true } },
        },
      }),
      db.abstractReviewer.findMany({
        where: { userId },
        select: {
          abstractId: true,
          role: true,
          conflictFlag: true,
          abstract: {
            select: {
              id: true,
              title: true,
              status: true,
              submittedAt: true,
              eventId: true,
              event: { select: { id: true, name: true, slug: true, startDate: true, endDate: true } },
            },
          },
        },
      }),
    ]);

    // Merge — de-dup by abstract id. Explicit assignment row wins so we keep
    // the role + conflictFlag metadata attached.
    type Row = {
      abstractId: string;
      title: string;
      status: string;
      submittedAt: Date;
      event: { id: string; name: string; slug: string; startDate: Date; endDate: Date };
      role: string | null;
      conflictFlag: boolean;
      source: "assigned" | "event-pool";
    };
    const merged = new Map<string, Row>();
    for (const a of abstractsFromPool) {
      merged.set(a.id, {
        abstractId: a.id,
        title: a.title,
        status: a.status,
        submittedAt: a.submittedAt,
        event: a.event,
        role: null,
        conflictFlag: false,
        source: "event-pool",
      });
    }
    for (const row of explicitAssignments) {
      merged.set(row.abstract.id, {
        abstractId: row.abstract.id,
        title: row.abstract.title,
        status: row.abstract.status,
        submittedAt: row.abstract.submittedAt,
        event: row.abstract.event,
        role: row.role,
        conflictFlag: row.conflictFlag,
        source: "assigned",
      });
    }

    const abstractIds = [...merged.keys()];
    const ownSubmissions = abstractIds.length
      ? await db.abstractReviewSubmission.findMany({
          where: { abstractId: { in: abstractIds }, reviewerUserId: userId },
          select: { abstractId: true, overallScore: true, submittedAt: true, updatedAt: true },
        })
      : [];
    const subsByAbstract = new Map(ownSubmissions.map((s) => [s.abstractId, s]));

    const rows = [...merged.values()].map((row) => {
      const sub = subsByAbstract.get(row.abstractId);
      return {
        ...row,
        submission: sub
          ? {
              overallScore: sub.overallScore,
              submittedAt: sub.submittedAt,
              updatedAt: sub.updatedAt,
              stale: sub.updatedAt.getTime() < row.submittedAt.getTime(),
            }
          : null,
        submissionStatus: !sub
          ? "PENDING"
          : sub.updatedAt.getTime() < row.submittedAt.getTime()
            ? "NEEDS_UPDATE"
            : "SUBMITTED",
      };
    });

    // Sort by event start date desc, then pending first within each event.
    rows.sort((a, b) => {
      const eventCmp = b.event.startDate.getTime() - a.event.startDate.getTime();
      if (eventCmp !== 0) return eventCmp;
      const order: Record<string, number> = { PENDING: 0, NEEDS_UPDATE: 1, SUBMITTED: 2 };
      return (order[a.submissionStatus] ?? 3) - (order[b.submissionStatus] ?? 3);
    });

    return NextResponse.json({ rows, total: rows.length });
  } catch (err) {
    apiLogger.error({ err, msg: "my-reviews:list-failed" });
    return NextResponse.json(
      { error: "Failed to load your reviews", code: "MY_REVIEWS_LOAD_FAILED" },
      { status: 500 },
    );
  }
}
