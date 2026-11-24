import { readReviewScoreScale } from "@/lib/abstract-score";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { resolveEventTenant } from "@/lib/tenant/event-tenant";
import { apiLogger } from "@/lib/logger";
import { normalizeCoAuthors } from "@/lib/abstract-coauthors";
import { REVIEWABLE_ABSTRACT_STATUSES, isOwnAbstract, mustConfirmEmailToReview } from "@/lib/abstract-reviewer-access";
import { NEITHER_FORMAT, NEITHER_FORMAT_LABEL, recommendableFormats } from "@/lib/recommended-formats";
import { presentationTypeLabels } from "@/lib/abstract-presentation-types";
import { loadPresentationTypes } from "@/lib/abstract-presentation-types-server";

/**
 * One abstract, for the person reviewing it: what the review page reads.
 *
 * Authorised by the review rule (abstract-reviewer-access.ts), not by event
 * access: someone assigned to a single abstract holds no event at all, and a
 * SUBMITTER's events are the ones holding their speaker record. The authors'
 * contact details are never selected, nor another reviewer's score.
 */

interface RouteParams {
  params: Promise<{ eventId: string; abstractId: string }>;
}

const NOT_FOUND = { error: "Abstract not found", code: "REVIEW_NOT_FOUND" };

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, abstractId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const user = { id: session.user.id, email: session.user.email };

    const account = await db.user.findUnique({ where: { id: user.id }, select: { role: true, emailConfirmedAt: true, tokenVersion: true } });
    if (mustConfirmEmailToReview(account, session.user.tokenVersion ?? 0)) {
      apiLogger.warn({ msg: "my-reviews:email-not-confirmed", eventId, abstractId, userId: user.id });
      return NextResponse.json({ error: "Confirm your email address to review abstracts.", code: "EMAIL_NOT_CONFIRMED" }, { status: 403 });
    }

    // The caller may hold no organisation, so the event names the lane. The
    // discovery reads on the privileged client, so its filter is bound to the
    // caller's own ASSIGNMENT to this abstract (review of 9c0a24c5): someone
    // not assigned is never put in the event's organisation's lane at all.
    // They are answered as before: the same 404 the unassigned always got.
    const tenant = await resolveEventTenant({
      id: eventId,
      status: { not: "CANCELLED" },
      abstracts: { some: { id: abstractId, reviewers: { some: { userId: user.id } } } },
    });
    if (!tenant) {
      apiLogger.warn({ msg: "my-reviews:event-not-found-or-not-assigned", eventId, abstractId, userId: user.id });
      return NextResponse.json(NOT_FOUND, { status: 404 });
    }

    return await runWithTenant(tenant.organizationId, async () => {
      const [event, abstract, assignment, submission, criteria, presentationTypes] = await Promise.all([
        db.event.findFirst({
          where: { id: eventId },
          select: { id: true, name: true, startDate: true, endDate: true, settings: true },
        }),
        db.abstract.findFirst({
          where: { id: abstractId, eventId, status: { notIn: ["DRAFT", "WITHDRAWN"] } },
          select: {
            id: true,
            serialId: true,
            title: true,
            content: true,
            status: true,
            specialty: true,
            presentationType: true,
            coAuthors: true,
            submittedAt: true,
            track: { select: { name: true } },
            theme: { select: { name: true } },
            subTheme: { select: { name: true } },
            speaker: {
              select: { userId: true, email: true, firstName: true, lastName: true, jobTitle: true, organization: true, country: true },
            },
          },
        }),
        db.abstractReviewer.findUnique({
          where: { abstractId_userId: { abstractId, userId: user.id } },
          select: { role: true, conflictFlag: true },
        }),
        db.abstractReviewSubmission.findUnique({
          where: { abstractId_reviewerUserId: { abstractId, reviewerUserId: user.id } },
          select: { overallScore: true, criteriaScores: true, reviewNotes: true, recommendedFormat: true, updatedAt: true },
        }),
        db.reviewCriterion.findMany({
          where: { eventId },
          select: { id: true, name: true, weight: true },
          orderBy: { sortOrder: "asc" },
        }),
        loadPresentationTypes(tenant.organizationId),
      ]);

      // Assigned only: the event's reviewer pool grants no abstract by itself.
      if (!event || !abstract || !assignment) {
        apiLogger.warn({ msg: "my-reviews:not-a-reviewer", eventId, abstractId, userId: user.id, found: !!abstract });
        return NextResponse.json(NOT_FOUND, { status: 404 });
      }
      if (isOwnAbstract(abstract.speaker, user)) {
        apiLogger.warn({ msg: "my-reviews:own-abstract", eventId, abstractId, userId: user.id });
        return NextResponse.json({ error: "This is your own abstract, so you cannot review it.", code: "OWN_ABSTRACT" }, { status: 403 });
      }

      const eventSummary = { id: event.id, name: event.name, startDate: event.startDate, endDate: event.endDate };

      // A declared conflict stops the review, so it stops the reading too.
      if (assignment?.conflictFlag) {
        return NextResponse.json({
          conflict: true,
          event: eventSummary,
          abstract: { id: abstract.id, serialId: abstract.serialId, title: abstract.title },
        });
      }

      const { speaker, coAuthors, ...rest } = abstract;
      return NextResponse.json({
        conflict: false,
        event: eventSummary,
        abstract: {
          ...rest,
          author: {
            firstName: speaker.firstName,
            lastName: speaker.lastName,
            jobTitle: speaker.jobTitle,
            organization: speaker.organization,
            country: speaker.country,
          },
          coAuthors: normalizeCoAuthors(coAuthors),
        },
        assignmentRole: assignment?.role ?? null,
        canSubmit: (REVIEWABLE_ABSTRACT_STATUSES as readonly string[]).includes(abstract.status),
        formats: recommendableFormats(event.settings, presentationTypes),
        // Every name the page shows for a type or a recommendation, as the organisation calls it.
        typeNames: { ...presentationTypeLabels(presentationTypes), [NEITHER_FORMAT]: NEITHER_FORMAT_LABEL },
        criteria,
        // What each criterion is scored out of on this event (abstract-score.ts).
        scoreScale: readReviewScoreScale(event.settings),
        submission: submission
          ? { ...submission, stale: submission.updatedAt.getTime() < abstract.submittedAt.getTime() }
          : null,
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "my-reviews:detail-failed" });
    return NextResponse.json({ error: "Failed to load this abstract", code: "MY_REVIEW_LOAD_FAILED" }, { status: 500 });
  }
}
