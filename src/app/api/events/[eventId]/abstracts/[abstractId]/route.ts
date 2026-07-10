import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { refreshEventStats } from "@/lib/event-stats";
import { coAuthorsSchema, normalizeCoAuthors } from "@/lib/abstract-coauthors";
import { MAX_ABSTRACT_WORDS, withinAbstractWordLimit } from "@/lib/abstract-content";
import {
  changeAbstractStatus,
  type AbstractTransitionStatus,
  type ChangeAbstractStatusErrorCode,
} from "@/services/abstract-service";
import { optimisticLockField } from "@/lib/optimistic-lock";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom, brandingCc } from "@/lib/email";
import { getTitleLabel } from "@/lib/utils";
import { notifyEventAdmins } from "@/lib/notifications";

// HTTP status mapping for the service's domain error codes. Kept local to
// the REST caller — the service never knows about HTTP.
const HTTP_STATUS_FOR_ABSTRACT_ERROR: Record<ChangeAbstractStatusErrorCode, number> = {
  ABSTRACT_NOT_FOUND: 404,
  ABSTRACT_WITHDRAWN: 400,
  INSUFFICIENT_REVIEWS: 400,
  INVALID_STATUS: 400,
  UNKNOWN: 500,
};

// Sprint B: review scoring moved to AbstractReviewSubmission rows.
// This PUT handles abstract metadata + status transitions only.
// Individual reviewer submissions go through POST /submissions.
const updateAbstractSchema = z.object({
  ...optimisticLockField,
  title: z.string().min(1).max(500).optional(),
  content: z
    .string()
    .min(1)
    .max(50000)
    .refine(withinAbstractWordLimit, { message: `Abstract must be ${MAX_ABSTRACT_WORDS} words or fewer` })
    .optional(),
  trackId: z.string().max(100).nullable().optional(),
  themeId: z.string().max(100).nullable().optional(),
  specialty: z.string().max(255).optional(),
  presentationType: z.enum(["ORAL", "POSTER", "ORAL_POSTER", "VIDEO", "WORKSHOP"]).nullable().optional(),
  coAuthors: coAuthorsSchema.optional(),
  status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED", "WITHDRAWN"]).optional(),
  /** Organizer/chair override: bypass the requiredReviewCount gate. Logged. */
  forceStatus: z.boolean().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; abstractId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, abstractId }] = await Promise.all([auth(), params]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [event, abstract] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true },
      }),
      db.abstract.findFirst({
        where: {
          id: abstractId,
          eventId,
        },
        include: {
          speaker: true,
          track: true,
          theme: { select: { id: true, name: true } },
          eventSession: {
            include: {
              track: true,
              speakers: {
                include: {
                  speaker: true,
                },
              },
            },
          },
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!abstract) {
      return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    }

    if (
      session.user.role === "SUBMITTER" &&
      abstract.speaker?.userId !== session.user.id
    ) {
      return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    }

    return NextResponse.json(abstract);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching abstract" });
    return NextResponse.json(
      { error: "Failed to fetch abstract" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, abstractId }] = await Promise.all([auth(), params]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [event, existingAbstract] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true, organizationId: true, name: true, settings: true },
      }),
      db.abstract.findFirst({
        where: {
          id: abstractId,
          eventId,
        },
        include: { speaker: { select: { userId: true } } },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!existingAbstract) {
      return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = updateAbstractSchema.safeParse(body);

    if (!validated.success) {
      const details = validated.error.flatten();
      apiLogger.warn({ msg: "Abstract update validation failed", eventId, abstractId, userId: session.user.id, errors: details });
      return NextResponse.json(
        { error: "Invalid input", details },
        { status: 400 }
      );
    }

    const data = validated.data;

    const isAdmin =
      session.user.role === "SUPER_ADMIN" || session.user.role === "ADMIN" || session.user.role === "ORGANIZER";
    const isReviewer = session.user.role === "REVIEWER";
    const canReview = isAdmin || isReviewer;
    const reviewStatuses = ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"];

    // SUBMITTER restrictions: own abstracts only; can act ONLY while DRAFT
    // (edit + submit). Once submitted, editing + withdrawal are locked — the
    // author must contact the organizer team. Can never set review statuses.
    if (session.user.role === "SUBMITTER") {
      if (existingAbstract.speaker?.userId !== session.user.id) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (data.status && reviewStatuses.includes(data.status)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      // Withdrawal is an organizer action — authors can't withdraw.
      if (data.status === "WITHDRAWN") {
        return NextResponse.json(
          {
            error: "To withdraw an abstract, please contact the organizer team.",
            code: "WITHDRAW_NOT_ALLOWED",
          },
          { status: 403 }
        );
      }
      // Only a DRAFT is editable/submittable by its author. Any submitted (or
      // later) abstract is locked to the author.
      if (existingAbstract.status !== "DRAFT") {
        return NextResponse.json(
          {
            error: "This abstract has already been submitted. To edit or withdraw it, please contact the organizer team.",
            code: "SUBMITTED_LOCKED",
          },
          { status: 403 }
        );
      }
      // Submitters can't force status transitions
      if (data.forceStatus) {
        return NextResponse.json({ error: "Only admins can force status" }, { status: 403 });
      }
    }

    // Only ADMIN/SUPER_ADMIN/ORGANIZER/REVIEWER can set review statuses
    if (!canReview && data.status && reviewStatuses.includes(data.status)) {
      return NextResponse.json(
        { error: "Only reviewers and admins can set review status" },
        { status: 403 }
      );
    }

    // forceStatus override is admin-only
    if (data.forceStatus && !isAdmin) {
      return NextResponse.json(
        { error: "Only admins can bypass the review-count gate" },
        { status: 403 }
      );
    }

    // Verify track exists if provided
    if (data.trackId) {
      const track = await db.track.findFirst({
        where: { id: data.trackId, eventId },
      });
      if (!track) {
        return NextResponse.json({ error: "Track not found" }, { status: 404 });
      }
    }

    // Verify theme belongs to this event if provided
    if (data.themeId) {
      const theme = await db.abstractTheme.findFirst({
        where: { id: data.themeId, eventId },
        select: { id: true },
      });
      if (!theme) {
        return NextResponse.json({ error: "Theme not found" }, { status: 404 });
      }
    }

    const isReview = data.status && reviewStatuses.includes(data.status);
    // A (re)submission = moving the abstract INTO SUBMITTED from one of its
    // EDITABLE states — DRAFT (first submit) OR REVISION_REQUESTED (resubmit
    // after addressing feedback). Both re-stamp submittedAt and re-notify.
    // Crucially, →SUBMITTED from a DECIDED/terminal state (ACCEPTED / REJECTED /
    // WITHDRAWN / UNDER_REVIEW) is NOT a submission — it's an un-decision, and
    // must be refused by the H1 guard below rather than silently treated as a
    // resubmission (which the old `!== "SUBMITTED"` definition did).
    const isSubmission =
      data.status === "SUBMITTED" &&
      (existingAbstract.status === "DRAFT" || existingAbstract.status === "REVISION_REQUESTED");
    // Presentation type is mandatory to submit (a DRAFT can have it blank).
    if (isSubmission && !(data.presentationType ?? existingAbstract.presentationType)) {
      return NextResponse.json(
        { error: "Presentation type is required to submit an abstract", code: "PRESENTATION_TYPE_REQUIRED" },
        { status: 400 }
      );
    }
    // WITHDRAWN transitions aren't in `reviewStatuses` (reviewers don't set
    // that) but still need the service's terminal-state bookkeeping.
    const isTerminal = data.status === "WITHDRAWN" && existingAbstract.status !== "WITHDRAWN";

    // Review + terminal transitions go through the service so the gate
    // check, audit log, notification, and stats refresh are identical to
    // the MCP agent path. Field-only updates (title/content/trackId/etc.)
    // and DRAFT → SUBMITTED transitions stay inline — they aren't exposed
    // via MCP and have no drift risk.
    if ((isReview || isTerminal) && data.status) {
      const result = await changeAbstractStatus({
        eventId,
        // Use the EVENT's org (always set), not the caller's — a REVIEWER is
        // org-independent (organizationId = null), which previously produced a
        // Prisma validation error inside changeAbstractStatus's org-scoped where.
        organizationId: event.organizationId,
        userId: session.user.id,
        abstractId,
        newStatus: data.status as AbstractTransitionStatus,
        forceStatus: data.forceStatus === true,
        source: "rest",
        requestIp: getClientIp(req),
      });

      if (!result.ok) {
        const status = HTTP_STATUS_FOR_ABSTRACT_ERROR[result.code] ?? 500;
        return NextResponse.json(
          { error: result.message, code: result.code, ...(result.meta ?? {}) },
          { status },
        );
      }

      // Apply any concurrent field updates in the same request. The service
      // already persisted `status` + `reviewedAt`; this pass handles the
      // other fields so a single PUT can set e.g. track + ACCEPTED together
      // (matching the pre-refactor behaviour).
      const fieldUpdates = {
        ...(data.title && { title: data.title }),
        ...(data.content && { content: data.content }),
        ...(data.trackId !== undefined && { trackId: data.trackId }),
        ...(data.themeId !== undefined && { themeId: data.themeId }),
        ...(data.specialty !== undefined && { specialty: data.specialty || null }),
        ...(data.presentationType !== undefined && { presentationType: data.presentationType }),
        ...(data.coAuthors !== undefined && { coAuthors: normalizeCoAuthors(data.coAuthors) }),
      };
      const hasFieldUpdates = Object.keys(fieldUpdates).length > 0;

      const include = {
        speaker: true,
        track: true,
        eventSession: true,
        event: { select: { slug: true, name: true } },
      };
      // Only one DB round-trip on each branch — if field updates are present,
      // `update` returns the post-write row; otherwise `findFirst` returns
      // the post-service-write row.
      const abstract = hasFieldUpdates
        ? await db.abstract.update({ where: { id: abstractId }, data: fieldUpdates, include })
        : await db.abstract.findFirst({ where: { id: abstractId }, include });
      return NextResponse.json(abstract);
    }

    // H1: the field-only path must NEVER perform an arbitrary status
    // transition. Review + terminal transitions already routed to the gated
    // service above (which validates them + audits + notifies). The ONLY
    // status write allowed on this blind path is a (re)submission INTO
    // SUBMITTED, or a status equal to the current one (a no-op re-save). Any
    // other value — e.g. a REVIEWER or a REGISTRANT PUTting {status:"DRAFT"}
    // or {status:"SUBMITTED"} to un-decide an ACCEPTED/WITHDRAWN abstract —
    // would slip past every gate and blindly write, reversing the decision
    // and (for SUBMITTED) re-firing the submission email. Refuse it.
    if (data.status && !isSubmission && data.status !== existingAbstract.status) {
      apiLogger.warn({
        msg: "abstract:invalid-status-transition-on-field-path",
        abstractId, eventId, userId: session.user.id, role: session.user.role,
        from: existingAbstract.status, to: data.status,
      });
      return NextResponse.json(
        {
          error: "That status change can't be made here — use the review decision or withdraw actions.",
          code: "INVALID_STATUS_TRANSITION",
        },
        { status: 400 },
      );
    }

    // Non-status-change path: field-only updates (optionally with a
    // DRAFT → SUBMITTED transition by the submitter).
    //
    // Optimistic lock (W2-F8). When supplied, the conditional updateMany
    // rejects stale writes — multiple reviewers/chair editing the same
    // abstract simultaneously is a real concurrency hazard.
    const expectedUpdatedAt = data.expectedUpdatedAt;
    if (!expectedUpdatedAt) {
      apiLogger.warn({
        msg: "optimistic-lock:missing-expectedUpdatedAt",
        resource: "abstract",
        resourceId: abstractId,
      });
    }

    const updateRes = await db.abstract.updateMany({
      where: {
        id: abstractId,
        ...(expectedUpdatedAt && { updatedAt: new Date(expectedUpdatedAt) }),
      },
      data: {
        ...(data.title && { title: data.title }),
        ...(data.content && { content: data.content }),
        ...(data.trackId !== undefined && { trackId: data.trackId }),
        ...(data.themeId !== undefined && { themeId: data.themeId }),
        ...(data.specialty !== undefined && { specialty: data.specialty || null }),
        ...(data.presentationType !== undefined && { presentationType: data.presentationType }),
        ...(data.coAuthors !== undefined && { coAuthors: normalizeCoAuthors(data.coAuthors) }),
        ...(data.status && { status: data.status }),
        ...(isSubmission && { submittedAt: new Date() }),
        updatedAt: new Date(),
      },
    });

    if (updateRes.count === 0) {
      const stillExists = await db.abstract.findFirst({
        where: { id: abstractId, eventId },
        select: { id: true },
      });
      if (!stillExists) {
        return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
      }
      apiLogger.info({ msg: "abstract:stale-write-rejected", abstractId, eventId, userId: session.user.id });
      return NextResponse.json(
        {
          error: "This abstract was modified by someone else after you opened it. Reload the latest version and try again.",
          code: "STALE_WRITE",
        },
        { status: 409 }
      );
    }

    const abstract = await db.abstract.findUniqueOrThrow({
      where: { id: abstractId },
      include: {
        speaker: true,
        track: true,
        eventSession: true,
        event: { select: { slug: true, name: true } },
      },
    });

    refreshEventStats(eventId);

    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UPDATE",
        entityType: "Abstract",
        entityId: abstract.id,
        changes: {
          before: { status: existingAbstract.status },
          after: { status: abstract.status },
          source: "api",
          fieldsChanged: Object.keys(data),
          ip: getClientIp(req),
        },
      },
    }).catch((err) => apiLogger.error({ err, eventId, abstractId }, "abstract-update:audit-log-failed"));

    // (Re)submission notification — the PUT path was previously silent on
    // submit, so a REVISION_REQUESTED→SUBMITTED resubmit went unnoticed by
    // reviewers/organizers and unconfirmed to the author. Mirror the create
    // POST: confirm to the submitter + notify organizers the abstract is back
    // for review. Both non-blocking.
    if (isSubmission && abstract.speaker) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
      const isResubmit = existingAbstract.status === "REVISION_REQUESTED";
      const vars = {
        title: getTitleLabel(abstract.speaker.title),
        firstName: abstract.speaker.firstName,
        lastName: abstract.speaker.lastName,
        eventName: abstract.event?.name || "",
        abstractTitle: abstract.title,
        managementLink: `${appUrl}/login?callbackUrl=${encodeURIComponent("/events")}`,
      };
      (async () => {
        const tpl = await getEventTemplate(eventId, "abstract-submission-confirmation")
          || getDefaultTemplate("abstract-submission-confirmation");
        if (!tpl) { apiLogger.warn({ msg: "No template found for abstract-submission-confirmation" }); return; }
        const branding = tpl && "branding" in tpl ? tpl.branding : { eventName: vars.eventName };
        const rendered = renderAndWrap(tpl, vars, branding);
        await sendEmail({
          to: [{ email: abstract.speaker!.email, name: `${abstract.speaker!.firstName} ${abstract.speaker!.lastName}` }],
          cc: brandingCc(branding, [{ email: abstract.speaker!.email }], [abstract.speaker!.additionalEmail]),
          ...rendered,
          from: brandingFrom(branding),
          emailType: "abstract_submission_confirmation",
          stream: "transactional",
          logContext: {
            organizationId: session.user.organizationId ?? null,
            eventId,
            entityType: "SPEAKER",
            entityId: abstract.speaker!.id,
            templateSlug: "abstract-submission-confirmation",
            triggeredByUserId: session.user.id,
          },
        });
      })().catch((err) => apiLogger.error({ err, msg: "Failed to send abstract resubmission confirmation email" }));

      notifyEventAdmins(eventId, {
        type: "ABSTRACT",
        title: isResubmit ? "Abstract Resubmitted" : "New Abstract Submitted",
        message: `"${abstract.title}" ${isResubmit ? "resubmitted (revision)" : "submitted"} by ${abstract.speaker.firstName} ${abstract.speaker.lastName}`,
        link: `/events/${eventId}/abstracts`,
      }).catch((err) => apiLogger.error({ err, msg: "Failed to send abstract submission notification" }));
    }

    return NextResponse.json(abstract);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating abstract" });
    return NextResponse.json(
      { error: "Failed to update abstract" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, abstractId }] = await Promise.all([auth(), params]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (session.user.role !== "SUPER_ADMIN") {
      return NextResponse.json(
        { error: "Only super admins can delete abstracts" },
        { status: 403 }
      );
    }

    const [event, abstract] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true },
      }),
      db.abstract.findFirst({
        where: {
          id: abstractId,
          eventId,
        },
        include: {
          eventSession: true,
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!abstract) {
      return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    }

    // Don't allow deletion if linked to a session
    if (abstract.eventSession) {
      return NextResponse.json(
        { error: "Cannot delete abstract that is linked to a session" },
        { status: 400 }
      );
    }

    await db.abstract.delete({
      where: { id: abstractId },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "Abstract",
        entityId: abstractId,
        changes: { deleted: abstract, ip: getClientIp(req) },
      },
    });

    apiLogger.info({ msg: "Abstract deleted", eventId, abstractId, title: abstract.title, userId: session.user.id });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting abstract" });
    return NextResponse.json(
      { error: "Failed to delete abstract" },
      { status: 500 }
    );
  }
}
