import crypto from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AbstractStatus, PresentationType } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom, brandingCc } from "@/lib/email";
import { notifyEventAdmins } from "@/lib/notifications";
import { refreshEventStats } from "@/lib/event-stats";

const abstractStatusSchema = z.nativeEnum(AbstractStatus);

const presentationTypeSchema = z.nativeEnum(PresentationType);

const createAbstractSchema = z.object({
  speakerId: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(50000),
  specialty: z.string().max(255).optional(),
  presentationType: presentationTypeSchema.optional(),
  trackId: z.string().max(100).optional(),
  themeId: z.string().max(100).optional(),
  status: abstractStatusSchema.default("SUBMITTED"),
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

    // For SUBMITTER, restrict to their own abstracts via speaker.userId
    const submitterFilter = session.user.role === "SUBMITTER"
      ? { speaker: { userId: session.user.id } }
      : {};

    // Parallelize event validation and abstracts fetch
    const [event, abstracts] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true },
      }),
      db.abstract.findMany({
        where: {
          eventId,
          ...(status && { status }),
          ...(trackId && { trackId }),
          ...(speakerId && { speakerId }),
          ...submitterFilter,
        },
        include: {
          speaker: true,
          track: true,
          theme: { select: { id: true, name: true } },
          eventSession: true,
          // Sprint B: fold submission rollup into the list response so the
          // dashboard card can render meanOverallScore + reviewCount without
          // an extra per-row fetch. Only pick fields needed for the mean.
          submissions: { select: { overallScore: true } },
        },
        orderBy: { submittedAt: "desc" },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const enriched = abstracts.map((a) => {
      const scores = a.submissions
        .map((s) => s.overallScore)
        .filter((s): s is number => s != null);
      const meanOverallScore = scores.length
        ? Math.round((scores.reduce((x, y) => x + y, 0) / scores.length) * 10) / 10
        : null;
      const rest: Omit<typeof a, "submissions"> & { submissions?: typeof a.submissions } = { ...a };
      delete rest.submissions;
      return {
        ...rest,
        reviewCount: a.submissions.length,
        meanOverallScore,
      };
    });

    // Add cache headers for better performance
    const response = NextResponse.json(enriched);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
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

    const { speakerId, title, content, specialty, presentationType, trackId, themeId, status } = validated.data;

    // SUBMITTER can only submit for their own speaker record
    const speakerWhere = session.user.role === "SUBMITTER"
      ? { id: speakerId, eventId, userId: session.user.id }
      : { id: speakerId, eventId };

    // Parallelize event, speaker, track, and theme validation
    const [event, speaker, track, theme] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true },
      }),
      db.speaker.findFirst({
        where: speakerWhere,
        select: { id: true },
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
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!speaker) {
      return NextResponse.json(
        { error: session.user.role === "SUBMITTER" ? "Forbidden" : "Speaker not found" },
        { status: session.user.role === "SUBMITTER" ? 403 : 404 }
      );
    }

    if (trackId && !track) {
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    if (themeId && !theme) {
      return NextResponse.json({ error: "Theme not found" }, { status: 404 });
    }

    const abstract = await db.abstract.create({
      data: {
        eventId,
        speakerId,
        title,
        content,
        specialty: specialty || null,
        presentationType: presentationType || null,
        trackId: trackId || null,
        themeId: themeId || null,
        status,
        managementToken: crypto.randomBytes(32).toString("hex"),
        submittedAt: status === "SUBMITTED" ? new Date() : undefined,
      },
      include: {
        speaker: true,
        track: true,
      },
    });

    // Send abstract submission confirmation email (non-blocking)
    if (abstract.speaker && (status === "SUBMITTED" || status === "DRAFT")) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
      const managementLink = `${appUrl}/login?callbackUrl=${encodeURIComponent("/events")}`;
      const vars = {
        firstName: abstract.speaker.firstName,
        lastName: abstract.speaker.lastName,
        eventName: "",
        abstractTitle: abstract.title,
        managementLink,
      };
      // Fetch event name for the email
      db.event.findUnique({ where: { id: eventId }, select: { name: true } })
        .then(async (ev) => {
          vars.eventName = ev?.name || "";
          const tpl = await getEventTemplate(eventId, "abstract-submission-confirmation")
            || getDefaultTemplate("abstract-submission-confirmation");
          if (!tpl) { apiLogger.warn({ msg: "No template found for abstract-submission-confirmation" }); return; }
          const branding = tpl && "branding" in tpl ? tpl.branding : { eventName: vars.eventName as string };
          const rendered = renderAndWrap(tpl, vars, branding);
          return sendEmail({
            to: [{ email: abstract.speaker!.email, name: `${abstract.speaker!.firstName} ${abstract.speaker!.lastName}` }],
            cc: brandingCc(
              branding,
              [{ email: abstract.speaker!.email }],
              [abstract.speaker!.additionalEmail],
            ),
            ...rendered,
            from: brandingFrom(branding),
            logContext: {
              eventId,
              entityType: "SPEAKER",
              entityId: abstract.speaker!.id,
              templateSlug: "abstract-submission-confirmation",
              triggeredByUserId: session.user.id,
            },
          });
        })
        .catch((err) => apiLogger.error({ err, msg: "Failed to send abstract submission confirmation email" }));
    }

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    // Notify admins/organizers (non-blocking)
    notifyEventAdmins(eventId, {
      type: "ABSTRACT",
      title: "New Abstract Submitted",
      message: `"${title}" submitted by ${abstract.speaker?.firstName} ${abstract.speaker?.lastName}`,
      link: `/events/${eventId}/abstracts`,
    }).catch((err) => apiLogger.error({ err, msg: "Failed to send abstract submission notification" }));

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
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating abstract" });
    return NextResponse.json(
      { error: "Failed to create abstract" },
      { status: 500 }
    );
  }
}
