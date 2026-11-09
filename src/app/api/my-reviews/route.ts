import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { REVIEWABLE_ABSTRACT_STATUSES, excludeOwnAbstracts, mustConfirmEmailToReview, type ReviewerIdentity } from "@/lib/abstract-reviewer-access";

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
 * Open to any signed-in account: the two entry points are the whole rule, and
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

/** Whether the feed would list anything for this person, for the sidebar. Stops at the first of each. */
async function hasReviewWork(user: ReviewerIdentity): Promise<boolean> {
  const reviewable = { ...excludeOwnAbstracts(user), status: { in: [...REVIEWABLE_ABSTRACT_STATUSES] } };
  const [fromPool, assignment] = await Promise.all([
    db.abstract.findFirst({
      where: {
        ...reviewable,
        event: { status: { not: "CANCELLED" }, settings: { path: ["reviewerUserIds"], array_contains: user.id } },
      },
      select: { id: true },
    }),
    db.abstractReviewer.findFirst({
      where: { userId: user.id, abstract: { ...reviewable, event: { status: { not: "CANCELLED" } } } },
      select: { id: true },
    }),
  ]);
  return !!fromPool || !!assignment;
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
    const account = await db.user.findUnique({ where: { id: userId }, select: { role: true, emailConfirmedAt: true } });
    if (mustConfirmEmailToReview(account)) {
      apiLogger.info({ msg: "my-reviews:awaiting-email-confirmation", userId });
      return NextResponse.json({ rows: [], total: 0, needsEmailConfirmation: true });
    }
    const notOwn = excludeOwnAbstracts(identity);

    // Pull both sources in parallel:
    //   1. Abstracts in events where the user is in settings.reviewerUserIds
    //      (event-level pool — same JSON-path filter buildEventAccessWhere
    //      uses for the REVIEWER role). Filtering at the DB avoids scanning
    //      every event in the deployment.
    //   2. Abstracts with an explicit AbstractReviewer row for this user
    //      (per-abstract assignment, independent of the pool).
    // Only abstracts that are actually up for review appear in the portal
    // (review H6): a DRAFT is the author's private work-in-progress and a
    // WITHDRAWN abstract is dead — neither should surface to reviewers as
    // PENDING work (both list routes already filter drafts via
    // abstractListStatusFilter; the portal feed forgot to).
    const [abstractsFromPool, explicitAssignments] = await Promise.all([
      db.abstract.findMany({
        where: {
          ...notOwn,
          status: { in: [...REVIEWABLE_ABSTRACT_STATUSES] },
          event: {
            status: { not: "CANCELLED" },
            settings: { path: ["reviewerUserIds"], array_contains: userId },
          },
        },
        select: {
          id: true,
          serialId: true,
          title: true,
          status: true,
          submittedAt: true,
          eventId: true,
          event: { select: { id: true, name: true, slug: true, startDate: true, endDate: true } },
        },
      }),
      db.abstractReviewer.findMany({
        where: {
          userId,
          abstract: { ...notOwn, status: { in: [...REVIEWABLE_ABSTRACT_STATUSES] }, event: { status: { not: "CANCELLED" } } },
        },
        select: {
          abstractId: true,
          role: true,
          conflictFlag: true,
          abstract: {
            select: {
              id: true,
              serialId: true,
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
      serialId: number | null;
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
        serialId: a.serialId,
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
        serialId: row.abstract.serialId,
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
        submissionStatus: submissionStatusOf(sub, row.submittedAt),
      };
    });

    // Sort by event start date desc, then within each event what was assigned
    // to this person before the rest of the pool, pending first in each.
    rows.sort((a, b) => {
      const eventCmp = b.event.startDate.getTime() - a.event.startDate.getTime();
      if (eventCmp !== 0) return eventCmp;
      if (a.source !== b.source) return a.source === "assigned" ? -1 : 1;
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
