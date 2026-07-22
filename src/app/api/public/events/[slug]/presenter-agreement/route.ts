import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { eventMatchesRequestTenant } from "@/lib/public-event";
import { rateLimited } from "@/lib/api-errors";
import { checkRateLimit, getClientIp, hashVerificationToken } from "@/lib/security";
import {
  resolvePresenterAgreementHtml,
  PRESENTER_AGREEMENT_IDENTIFIER_PREFIX,
} from "@/lib/presenter-agreement";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

const IDENTIFIER_PREFIX = PRESENTER_AGREEMENT_IDENTIFIER_PREFIX;

async function validateToken(rawToken: string, clientIp: string) {
  const hashedToken = hashVerificationToken(rawToken);
  const tokenRecord = await db.verificationToken.findUnique({ where: { token: hashedToken } });

  if (!tokenRecord) {
    apiLogger.info({ msg: "Presenter agreement token not found", ip: clientIp });
    return { error: "This link is invalid or has already been used. Please contact the event organizer for a new link.", status: 400 as const };
  }

  if (tokenRecord.expires < new Date()) {
    await db.verificationToken.delete({ where: { token: hashedToken } }).catch(() => {});
    apiLogger.info({ msg: "Expired presenter agreement token accessed", identifier: tokenRecord.identifier, ip: clientIp });
    return { error: "This link has expired. Please contact the event organizer for a new link.", status: 400 as const };
  }

  if (!tokenRecord.identifier.startsWith(IDENTIFIER_PREFIX)) {
    apiLogger.warn({ msg: "Token with wrong identifier prefix used on presenter-agreement endpoint", identifier: tokenRecord.identifier });
    return { error: "This link is not a presenter agreement link.", status: 400 as const };
  }

  const speakerId = tokenRecord.identifier.slice(IDENTIFIER_PREFIX.length);
  return { speakerId, hashedToken };
}

// ── GET: Validate token and return agreement details ──────────────────────

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;
    const { searchParams } = new URL(req.url);
    const rawToken = searchParams.get("token");
    const clientIp = getClientIp(req);

    if (!rawToken) {
      return NextResponse.json({ error: "Token is required" }, { status: 400 });
    }

    const ipLimit = checkRateLimit({
      key: `presenter-agreement-get:ip:${clientIp}`,
      limit: 20,
      windowMs: 15 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return rateLimited(ipLimit, { route: "public/presenter-agreement", ip: clientIp, message: "Too many requests" });
    }

    const tokenResult = await validateToken(rawToken, clientIp);
    if ("error" in tokenResult) {
      return NextResponse.json({ error: tokenResult.error }, { status: tokenResult.status });
    }

    const { speakerId } = tokenResult;

    const speaker = await db.speaker.findFirst({
      where: { id: speakerId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        title: true,
        presenterAgreementAcceptedAt: true,
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            organizationId: true,
            bannerImage: true,
            organization: { select: { name: true, logo: true } },
          },
        },
      },
    });

    if (!speaker) {
      return NextResponse.json({ error: "Presenter not found." }, { status: 404 });
    }

    if (speaker.event.slug !== slug) {
      return NextResponse.json({ error: "This link does not belong to this event." }, { status: 400 });
    }
    if (!(await eventMatchesRequestTenant(req, speaker.event.organizationId))) {
      apiLogger.warn({ slug, speakerId: speaker.id }, "presenter-agreement:tenant-mismatch");
      return NextResponse.json({ error: "This link does not belong to this event." }, { status: 400 });
    }

    // Merge so the page shows the same text as the emailed PDF. If the context
    // can't be built we MUST NOT fall back to the unmerged template (literal
    // `{{token}}` strings + snapshot divergence break byte-for-byte parity).
    const resolved = await resolvePresenterAgreementHtml(speaker.event.id, speaker.id);
    if (!resolved) {
      apiLogger.error({ msg: "presenter-agreement:context-build-failed", speakerId: speaker.id, eventId: speaker.event.id });
      return NextResponse.json(
        { error: "Unable to load agreement at this time. Please contact the event organizer." },
        { status: 500 },
      );
    }

    return NextResponse.json({
      alreadyAccepted: speaker.presenterAgreementAcceptedAt !== null,
      acceptedAt: speaker.presenterAgreementAcceptedAt,
      speaker: {
        id: speaker.id,
        firstName: speaker.firstName,
        lastName: speaker.lastName,
        email: speaker.email,
        title: speaker.title,
      },
      event: {
        id: speaker.event.id,
        name: speaker.event.name,
        slug: speaker.event.slug,
        bannerImage: speaker.event.bannerImage,
        organization: speaker.event.organization,
      },
      agreementHtml: resolved.html,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error validating presenter agreement token" });
    return NextResponse.json({ error: "Failed to load agreement" }, { status: 500 });
  }
}

// ── POST: Accept agreement (one-time use) ──────────────────────────────────

const postSchema = z.object({
  token: z.string().min(1),
  accepted: z.literal(true),
});

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;
    const clientIp = getClientIp(req);

    const ipLimit = checkRateLimit({
      key: `presenter-agreement-post:ip:${clientIp}`,
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return rateLimited(ipLimit, { route: "public/presenter-agreement", ip: clientIp, message: "Too many requests" });
    }

    const body = await req.json().catch(() => ({}));
    const parsed = postSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "Invalid presenter agreement acceptance payload", errors: parsed.error.flatten() });
      return NextResponse.json({ error: "You must accept the agreement to continue." }, { status: 400 });
    }

    const tokenResult = await validateToken(parsed.data.token, clientIp);
    if ("error" in tokenResult) {
      return NextResponse.json({ error: tokenResult.error }, { status: tokenResult.status });
    }

    const { speakerId, hashedToken } = tokenResult;

    const speaker = await db.speaker.findFirst({
      where: { id: speakerId },
      select: {
        id: true,
        presenterAgreementAcceptedAt: true,
        event: { select: { id: true, slug: true, organizationId: true } },
      },
    });

    if (!speaker) {
      return NextResponse.json({ error: "Presenter not found." }, { status: 404 });
    }

    if (speaker.event.slug !== slug) {
      return NextResponse.json({ error: "This link does not belong to this event." }, { status: 400 });
    }
    if (!(await eventMatchesRequestTenant(req, speaker.event.organizationId))) {
      apiLogger.warn({ slug, speakerId: speaker.id }, "presenter-agreement:tenant-mismatch");
      return NextResponse.json({ error: "This link does not belong to this event." }, { status: 400 });
    }

    if (speaker.presenterAgreementAcceptedAt) {
      // Idempotent — first acceptance wins; snapshot is NOT re-written, so the
      // accepted text stays locked even if the organizer edits it afterward.
      await db.verificationToken.delete({ where: { token: hashedToken } }).catch(() => {});
      apiLogger.info({
        msg: "Presenter agreement re-acceptance attempted (already accepted)",
        speakerId: speaker.id,
        eventId: speaker.event.id,
        ip: clientIp,
      });
      return NextResponse.json({ success: true, alreadyAccepted: true, acceptedAt: speaker.presenterAgreementAcceptedAt });
    }

    // Snapshot the MERGED HTML so the accepted text is exactly what the author
    // saw. Mirror the GET handler: never store the unmerged template.
    const resolved = await resolvePresenterAgreementHtml(speaker.event.id, speaker.id);
    if (!resolved) {
      apiLogger.error({ msg: "presenter-agreement:context-build-failed-on-accept", speakerId: speaker.id, eventId: speaker.event.id, ip: clientIp });
      return NextResponse.json(
        { error: "Unable to record acceptance at this time. Please contact the event organizer." },
        { status: 500 },
      );
    }
    const acceptedAt = new Date();

    await db.$transaction([
      db.speaker.update({
        where: { id: speaker.id },
        data: {
          presenterAgreementAcceptedAt: acceptedAt,
          presenterAgreementAcceptedIp: clientIp,
          presenterAgreementTextSnapshot: resolved.html,
          presenterAgreementAcceptedBy: "PRESENTER",
        },
      }),
      db.verificationToken.delete({ where: { token: hashedToken } }),
    ]);

    db.auditLog
      .create({
        data: {
          eventId: speaker.event.id,
          userId: null,
          action: "PRESENTER_AGREEMENT_ACCEPTED",
          entityType: "Speaker",
          entityId: speaker.id,
          changes: { actor: "PRESENTER", ip: clientIp, acceptedAt: acceptedAt.toISOString() },
          ipAddress: clientIp,
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "Failed to write presenter agreement acceptance audit log" }));

    apiLogger.info({ msg: "Presenter agreement accepted", speakerId: speaker.id, eventId: speaker.event.id, ip: clientIp });

    return NextResponse.json({ success: true, acceptedAt });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error accepting presenter agreement" });
    return NextResponse.json({ error: "Failed to accept agreement" }, { status: 500 });
  }
}
