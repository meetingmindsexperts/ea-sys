import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { REVIEWABLE_ABSTRACT_STATUSES, excludeOwnAbstracts, mustConfirmEmailToReview, type ReviewerIdentity } from "@/lib/abstract-reviewer-access";

/**
 * Reviewer portal feed.
 *
 * Returns the abstracts assigned to the current user (`AbstractReviewer`
 * rows), grouped by event. Being on an event's reviewer pool lists nothing by
 * itself (owner, Nov 10, 2026: a reviewer sees what they are assigned, not
 * every abstract; until then the pool listed the whole event).
 *
 * Open to any signed-in account: the assignment is the whole rule, and
 * the role is not part of it (src/lib/abstract-reviewer-access.ts). A person's
 * own abstracts never appear. `?summary=1` answers only whether they have any
 * of this and any abstract of their own, which decides the sidebar's links.
 *
 * For each abstract, reports the user's own submission status so the portal
 * can render PENDING / SUBMITTED / NEEDS_UPDATE badges without a second call.
 *
 * MULTI-TENANCY (Abstract sweep, Domain #11): this route is DELIBERATELY NOT
 * wrapped in runWithTenant. It is CROSS-ORG BY DESIGN — a single reviewer's feed
 * unions abstracts across EVERY event/org where they hold a pool membership or an
 * AbstractReviewer row, so there is no single tenant org to scope to at request
 * time (the reviewer User is org-independent, organizationId = null). Same class
 * as the deferred REGISTRANT self-service routes: it belongs to the open Phase-1
 * identity-model decision (shared User + per-event Membership), NOT this sweep.
 * On the RLS-enabled platform this read fail-closes until that decision lands;
 * on master (RLS off) it is unaffected. See docs/MULTI_TENANCY.md §13.
 */

function submissionStatusOf(sub: { updatedAt: Date } | null | undefined, abstractSubmittedAt: Date) {
  if (!sub) return "PENDING";
  return sub.updatedAt.getTime() < abstractSubmittedAt.getTime() ? "NEEDS_UPDATE" : "SUBMITTED";
}

/** Whether the feed would list anything for this person, for the sidebar. Stops at the first. */
async function hasReviewWork(user: ReviewerIdentity): Promise<boolean> {
  const reviewable = { ...excludeOwnAbstracts(user), status: { in: [...REVIEWABLE_ABSTRACT_STATUSES] } };
  const assignment = await db.abstractReviewer.findFirst({
    where: { userId: user.id, abstract: { ...reviewable, event: { status: { not: "CANCELLED" } } } },
    select: { id: true },
  });
  return !!assignment;
}

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;
    const identity = { id: userId, email: session.user.email };
    if (new URL(req.url).searchParams.get("summary") === "1") {
      const [reviewWork, ownAbstract] = await Promise.all([
        hasReviewWork(identity),
        db.abstract.findFirst({ where: { speaker: { userId } }, select: { id: true } }),
      ]);
      return NextResponse.json({ hasReviewWork: reviewWork, hasAbstracts: !!ownAbstract });
    }
    // Nothing to read until the address is proven (abstract-reviewer-access.ts).
    const account = await db.user.findUnique({ where: { id: userId }, select: { role: true, emailConfirmedAt: true, tokenVersion: true } });
    if (mustConfirmEmailToReview(account, session.user.tokenVersion ?? 0)) {
      apiLogger.info({ msg: "my-reviews:awaiting-email-confirmation", userId });
      return NextResponse.json({ rows: [], total: 0, needsEmailConfirmation: true });
    }
    const notOwn = excludeOwnAbstracts(identity);

    // Only abstracts that are actually up for review appear in the portal
    // (review H6): a DRAFT is the author's private work-in-progress and a
    // WITHDRAWN abstract is dead.
    const assignments = await db.abstractReviewer.findMany({
      where: {
        userId,
        abstract: { ...notOwn, status: { in: [...REVIEWABLE_ABSTRACT_STATUSES] }, event: { status: { not: "CANCELLED" } } },
      },
      select: {
        role: true,
        conflictFlag: true,
        abstract: {
          select: {
            id: true,
            serialId: true,
            title: true,
            status: true,
            submittedAt: true,
            event: { select: { id: true, name: true, slug: true, startDate: true, endDate: true } },
          },
        },
      },
    });

    const assigned = assignments.map((row) => ({
      abstractId: row.abstract.id,
      serialId: row.abstract.serialId,
      title: row.abstract.title,
      status: row.abstract.status,
      submittedAt: row.abstract.submittedAt,
      event: row.abstract.event,
      role: row.role,
      conflictFlag: row.conflictFlag,
    }));

    const abstractIds = assigned.map((row) => row.abstractId);
    const ownSubmissions = abstractIds.length
      ? await db.abstractReviewSubmission.findMany({
          where: { abstractId: { in: abstractIds }, reviewerUserId: userId },
          select: { abstractId: true, overallScore: true, submittedAt: true, updatedAt: true },
        })
      : [];
    const subsByAbstract = new Map(ownSubmissions.map((s) => [s.abstractId, s]));

    const rows = assigned.map((row) => {
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
        submissionStatus: submissionStatusOf(sub, row.submittedAt),
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
