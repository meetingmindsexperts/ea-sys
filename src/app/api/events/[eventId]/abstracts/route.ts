import crypto from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AbstractStatus, PresentationType } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db, tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { getNextAbstractSerialId } from "@/lib/abstract-serial";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { abstractListStatusFilter } from "@/lib/abstract-draft-visibility";
import { getClientIp } from "@/lib/security";
import { meanOverallScore } from "@/lib/abstract-review";
import { sendAbstractSubmissionConfirmation } from "@/lib/abstract-notifications";
import { notifyEventAdmins } from "@/lib/notifications";
import { refreshEventStats } from "@/lib/event-stats";
import { coAuthorsSchema, normalizeCoAuthors } from "@/lib/abstract-coauthors";
import { MAX_ABSTRACT_WORDS, withinAbstractWordLimit } from "@/lib/abstract-content";
import { isPresentationTypeEnabled, readEnabledPresentationTypes } from "@/lib/abstract-presentation-types";
import { missingProfileFields, profileIncompletePayload, PROFILE_COMPLETENESS_SELECT } from "@/lib/submitter-profile-completeness";
import {
  isThemeMissing, THEME_REQUIRED_CODE, THEME_REQUIRED_MESSAGE,
  isSubThemeMissing, SUB_THEME_REQUIRED_CODE, SUB_THEME_REQUIRED_MESSAGE,
} from "@/lib/abstract-theme-requirement";

const abstractStatusSchema = z.nativeEnum(AbstractStatus);

const presentationTypeSchema = z.nativeEnum(PresentationType);

const createAbstractSchema = z.object({
  speakerId: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  content: z
    .string()
    .min(1)
    .max(50000)
    .refine(withinAbstractWordLimit, { message: `Abstract must be ${MAX_ABSTRACT_WORDS} words or fewer` }),
  specialty: z.string().max(255).optional(),
  presentationType: presentationTypeSchema.optional(),
  trackId: z.string().max(100).optional(),
  themeId: z.string().max(100).optional(),
  subThemeId: z.string().max(100).optional(),
  coAuthors: coAuthorsSchema.optional(),
  // H2: an abstract may only be BORN as DRAFT or SUBMITTED. Accepting the full
  // enum let a self-service SUBMITTER POST { status: "ACCEPTED" } and mint a
  // pre-accepted abstract with zero reviews, no submittedAt, and no
  // chair-override audit — the review-count gate + notifications only guard
  // TRANSITIONS, never birth status. (The GET filter keeps the full enum.)
  status: z.enum(["DRAFT", "SUBMITTED"]).default("SUBMITTED"),
}).superRefine((data, ctx) => {
  // Presentation type is mandatory to SUBMIT (a DRAFT save can leave it blank).
  if (data.status === "SUBMITTED" && !data.presentationType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["presentationType"],
      message: "Presentation type is required to submit an abstract",
    });
  }
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    // Parallelize params and auth for faster response
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get("status");
    const parsedStatus = statusParam ? abstractStatusSchema.safeParse(statusParam) : null;
    const status = parsedStatus?.success ? parsedStatus.data : undefined;
    const trackId = searchParams.get("trackId");
    const speakerId = searchParams.get("speakerId");
    // Cap the result set so a large CFP can't return an unbounded payload
    // (mirrors the MCP list_abstracts cap). Default 200, max 500.
    const limitParam = Number(searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 200;

    // For SUBMITTER, restrict to their own abstracts via speaker.userId
    const submitterFilter = session.user.role === "SUBMITTER"
      ? { speaker: { userId: session.user.id } }
      : {};

    // A DRAFT is the submitter's private work-in-progress. Never surface drafts
    // to organizers / admins / reviewers — only the owning SUBMITTER (via
    // submitterFilter above) sees their own drafts.
    const statusFilter = abstractListStatusFilter({
      canSeeDrafts: session.user.role === "SUBMITTER",
      requestedStatus: status,
    });

    // Resolve the event FIRST — its org opens the tenant wrap. buildEventAccessWhere
    // scopes by role (a SUBMITTER → their own linked event), so event.organizationId
    // is the RESOURCE org even for an org-null submitter/reviewer caller.
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
    const abstracts = await db.abstract.findMany({
      where: {
        eventId,
        ...(statusFilter !== undefined && { status: statusFilter }),
        ...(trackId && { trackId }),
        ...(speakerId && { speakerId }),
        ...submitterFilter,
      },
      include: {
        speaker: true,
        track: true,
        theme: { select: { id: true, name: true } },
        subTheme: { select: { id: true, name: true } },
        eventSession: true,
        // Sprint B: fold submission rollup into the list response so the
        // dashboard card can render meanOverallScore + reviewCount without
        // an extra per-row fetch. Only pick fields needed for the mean.
        submissions: { select: { overallScore: true } },
        _count: { select: { reviewers: true } },
      },
      orderBy: { submittedAt: "desc" },
      take: limit,
    });

    const enriched = abstracts.map((a) => {
      const rest: Omit<typeof a, "submissions"> & { submissions?: typeof a.submissions } = { ...a };
      delete rest.submissions;
      return {
        ...rest,
        reviewCount: a.submissions.length,
        assignedReviewerCount: a._count.reviewers,
        // Shared rounding so the list mean matches the detail aggregate.
        meanOverallScore: meanOverallScore(a.submissions.map((s) => s.overallScore)),
      };
    });

    // Add cache headers for better performance
    const response = NextResponse.json(enriched);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching abstracts" });
    return NextResponse.json(
      { error: "Failed to fetch abstracts" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    // Parallelize params, auth, and body parsing
    const [{ eventId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (session.user.role === "REVIEWER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const validated = createAbstractSchema.safeParse(body);

    if (!validated.success) {
      const details = validated.error.flatten();
      apiLogger.warn({ msg: "Abstract create validation failed", eventId, userId: session.user.id, errors: details });
      return NextResponse.json(
        { error: "Invalid input", details },
        { status: 400 }
      );
    }

    const { speakerId, title, content, specialty, presentationType, trackId, themeId, subThemeId, coAuthors, status } = validated.data;

    // SUBMITTER can only submit for their own speaker record
    const speakerWhere = session.user.role === "SUBMITTER"
      ? { id: speakerId, eventId, userId: session.user.id }
      : { id: speakerId, eventId };

    // Resolve the event FIRST — its org opens the tenant wrap (RESOURCE org, so a
    // SUBMITTER creating their own abstract works even though their session org is
    // null). The theme lookup below reads a swept table, so it must run INSIDE.
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, settings: true, organizationId: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
    // Parallelize speaker, track, and theme validation
    const [speaker, track, theme] = await Promise.all([
      db.speaker.findFirst({
        where: speakerWhere,
        select: { id: true, ...PROFILE_COMPLETENESS_SELECT },
      }),
      trackId
        ? db.track.findFirst({
            where: { id: trackId, eventId },
            select: { id: true },
          })
        : Promise.resolve(null),
      themeId
        ? db.abstractTheme.findFirst({
            where: { id: themeId, eventId },
            // Children come along so the sub-theme gate and the "does this
            // sub-theme belong to this theme?" check share one query.
            select: { id: true, subThemes: { select: { id: true } } },
          })
        : Promise.resolve(null),
    ]);

    if (!speaker) {
      return NextResponse.json(
        { error: session.user.role === "SUBMITTER" ? "Forbidden" : "Speaker not found" },
        { status: session.user.role === "SUBMITTER" ? 403 : 404 }
      );
    }

    // Hard gate (Aug 5, 2026): a SUBMITTER must complete their profile
    // (role/specialty/org/job title/phone/city/country) before creating an
    // abstract. The form redirects to My Details first — this refusal covers
    // a direct API call. Staff creating on a speaker's behalf are exempt.
    if (session.user.role === "SUBMITTER") {
      const missing = missingProfileFields(speaker);
      if (missing.length > 0) {
        apiLogger.warn({ msg: "abstract-create:profile-incomplete-block", eventId, userId: session.user.id, missing });
        return NextResponse.json(profileIncompletePayload(missing), { status: 403 });
      }
    }

    if (trackId && !track) {
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    if (themeId && !theme) {
      return NextResponse.json({ error: "Theme not found" }, { status: 404 });
    }

    // Theme is mandatory to SUBMIT when the event HAS themes (owner, Aug 7
    // 2026). Conditional by necessity: an event whose organiser created none
    // would otherwise be unsubmittable. Drafts are exempt, same as
    // presentation type. The count runs only on the submit path.
    if (status === "SUBMITTED" && !themeId) {
      const themeCount = await db.abstractTheme.count({ where: { eventId } });
      if (isThemeMissing(themeCount > 0, themeId)) {
        apiLogger.warn({ msg: "abstract-create:theme-required", eventId, userId: session.user.id });
        return NextResponse.json(
          { error: THEME_REQUIRED_MESSAGE, code: THEME_REQUIRED_CODE },
          { status: 400 },
        );
      }
    }

    // Sub-theme: belongs to the chosen theme, and is required to SUBMIT when
    // that theme has any. Ownership first — a sub-theme id from another theme
    // is a 404, not a silently accepted classification.
    if (subThemeId && !theme?.subThemes.some((st) => st.id === subThemeId)) {
      apiLogger.warn({ msg: "abstract-create:sub-theme-not-in-theme", eventId, themeId, subThemeId, userId: session.user.id });
      return NextResponse.json({ error: "Sub-theme not found for that theme" }, { status: 404 });
    }
    if (status === "SUBMITTED" && isSubThemeMissing((theme?.subThemes.length ?? 0) > 0, subThemeId)) {
      apiLogger.warn({ msg: "abstract-create:sub-theme-required", eventId, themeId, userId: session.user.id });
      return NextResponse.json(
        { error: SUB_THEME_REQUIRED_MESSAGE, code: SUB_THEME_REQUIRED_CODE },
        { status: 400 },
      );
    }

    // The event only offers the presentation types its organizer enabled
    // (Content → Abstracts; settings.abstractPresentationTypes — absent =
    // all). The forms filter their dropdowns, but a form can be bypassed, so
    // enforce here too.
    if (presentationType && !isPresentationTypeEnabled(event.settings, presentationType)) {
      apiLogger.warn({ msg: "abstract-create:presentation-type-not-offered", eventId, presentationType, userId: session.user.id });
      return NextResponse.json(
        {
          error: `This event does not offer ${presentationType} presentations. Offered: ${readEnabledPresentationTypes(event.settings).join(", ")}.`,
          code: "PRESENTATION_TYPE_NOT_OFFERED",
        },
        { status: 400 },
      );
    }

    // Serial + create share one transaction so a failed insert rolls the
    // counter back (registration-serial pattern — no gaps from failures).
    const abstract = await tenantTransaction(async (tx) => {
      const serialId = await getNextAbstractSerialId(tx, eventId, event.organizationId);
      return tx.abstract.create({
        data: {
          eventId,
          organizationId: event.organizationId, // tenancy: the event's org (resource)
          speakerId,
          title,
          content,
          specialty: specialty || null,
          presentationType: presentationType || null,
          trackId: trackId || null,
          themeId: themeId || null,
          subThemeId: subThemeId || null,
          coAuthors: normalizeCoAuthors(coAuthors),
          status,
          serialId,
          managementToken: crypto.randomBytes(32).toString("hex"),
          submittedAt: status === "SUBMITTED" ? new Date() : undefined,
        },
        include: {
          speaker: true,
          track: true,
          theme: { select: { name: true } },
          subTheme: { select: { name: true } },
        },
      });
    });

    // Send abstract submission confirmation email (non-blocking). Only on an
    // actual SUBMITTED — a DRAFT save must NOT email "your abstract was
    // submitted" (it isn't yet, and it's invisible to reviewers).
    // ONE implementation shared with the resubmit PUT + the manual resend
    // route: sendAbstractSubmissionConfirmation (never throws).
    if (abstract.speaker && status === "SUBMITTED") {
      db.event.findUnique({ where: { id: eventId }, select: { name: true, slug: true } })
        .then((ev) =>
          sendAbstractSubmissionConfirmation({
            eventId,
            organizationId: session.user.organizationId ?? null,
            eventName: ev?.name || "",
            // Drives the branded /e/{slug}/login CTA. Null falls back to the
            // internal login rather than minting a broken /e//login URL.
            eventSlug: ev?.slug ?? null,
            abstractId: abstract.id,
            abstractTitle: abstract.title,
            serialId: abstract.serialId,
            speaker: abstract.speaker!,
            triggeredByUserId: session.user.id,
          }),
        )
        .catch((err) => apiLogger.error({ err, msg: "Failed to send abstract submission confirmation email" }));
    }

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    // Notify admins/organizers (non-blocking) — only on an actual submission,
    // not a DRAFT save (a draft isn't actionable + "New Abstract Submitted"
    // would be misleading).
    if (status === "SUBMITTED") {
      notifyEventAdmins(eventId, {
        type: "ABSTRACT",
        title: "New Abstract Submitted",
        message: `"${title}" submitted by ${abstract.speaker?.firstName} ${abstract.speaker?.lastName}`,
        link: `/events/${eventId}/abstracts`,
      }).catch((err) => apiLogger.error({ err, msg: "Failed to send abstract submission notification" }));
    }

    // Log the action (non-blocking for better response time)
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "Abstract",
        entityId: abstract.id,
        changes: { ...JSON.parse(JSON.stringify({ abstract })), ip: getClientIp(req) },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    apiLogger.info({ msg: "Abstract created", eventId, abstractId: abstract.id, speakerId, title, userId: session.user.id });

    return NextResponse.json(abstract, { status: 201 });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating abstract" });
    return NextResponse.json(
      { error: "Failed to create abstract" },
      { status: 500 }
    );
  }
}
