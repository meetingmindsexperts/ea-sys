import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp, hashVerificationToken } from "@/lib/security";
import { DEFAULT_SPEAKER_AGREEMENT_HTML } from "@/lib/default-terms";
import { refreshEventStats } from "@/lib/event-stats";
import { buildSpeakerEmailContext, mergeAgreementHtml } from "@/lib/speaker-agreement";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

const IDENTIFIER_PREFIX = "speaker-agreement:";

async function validateToken(rawToken: string, clientIp: string) {
  const hashedToken = hashVerificationToken(rawToken);
  const tokenRecord = await db.verificationToken.findUnique({
    where: { token: hashedToken },
  });

  if (!tokenRecord) {
    apiLogger.info({ msg: "Speaker agreement token not found", ip: clientIp });
    return { error: "This link is invalid or has already been used. Please contact the event organizer for a new link.", status: 400 as const };
  }

  if (tokenRecord.expires < new Date()) {
    await db.verificationToken.delete({ where: { token: hashedToken } }).catch(() => {});
    apiLogger.info({ msg: "Expired speaker agreement token accessed", identifier: tokenRecord.identifier, ip: clientIp });
    return { error: "This link has expired. Please contact the event organizer for a new link.", status: 400 as const };
  }

  if (!tokenRecord.identifier.startsWith(IDENTIFIER_PREFIX)) {
    apiLogger.warn({ msg: "Token with wrong identifier prefix used on speaker-agreement endpoint", identifier: tokenRecord.identifier });
    return { error: "This link is not a speaker agreement link.", status: 400 as const };
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
      key: `speaker-agreement-get:ip:${clientIp}`,
      limit: 20,
      windowMs: 15 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
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
        agreementAcceptedAt: true,
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            bannerImage: true,
            speakerAgreementHtml: true,
            organization: { select: { name: true, logo: true } },
          },
        },
      },
    });

    if (!speaker) {
      return NextResponse.json({ error: "Speaker not found." }, { status: 404 });
    }

    if (speaker.event.slug !== slug) {
      return NextResponse.json({ error: "This link does not belong to this event." }, { status: 400 });
    }

    const rawAgreementHtml = speaker.event.speakerAgreementHtml || DEFAULT_SPEAKER_AGREEMENT_HTML;

    // Token-merge so the page shows the same text the speaker got in the
    // PDF attached to their email — non-negotiable, the speaker accepts
    // what they read. If the context can't be built we MUST NOT fall back
    // to the unmerged template (it'd contain literal `{{token}}` strings
    // and the snapshot stored on accept would diverge from what the user
    // sees, both of which break the byte-for-byte parity guarantee).
    const context = await buildSpeakerEmailContext(speaker.event.id, speaker.id);
    if (!context) {
      apiLogger.error({
        msg: "speaker-agreement:context-build-failed",
        speakerId: speaker.id,
        eventId: speaker.event.id,
      });
      return NextResponse.json(
        { error: "Unable to load agreement at this time. Please contact the event organizer." },
        { status: 500 },
      );
    }
    const agreementHtml = mergeAgreementHtml(rawAgreementHtml, context);

    return NextResponse.json({
      alreadyAccepted: speaker.agreementAcceptedAt !== null,
      acceptedAt: speaker.agreementAcceptedAt,
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
      agreementHtml,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error validating speaker agreement token" });
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
      key: `speaker-agreement-post:ip:${clientIp}`,
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const body = await req.json().catch(() => ({}));
    const parsed = postSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "Invalid speaker agreement acceptance payload", errors: parsed.error.flatten() });
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
        agreementAcceptedAt: true,
        event: { select: { id: true, slug: true, speakerAgreementHtml: true } },
      },
    });

    if (!speaker) {
      return NextResponse.json({ error: "Speaker not found." }, { status: 404 });
    }

    if (speaker.event.slug !== slug) {
      return NextResponse.json({ error: "This link does not belong to this event." }, { status: 400 });
    }

    if (speaker.agreementAcceptedAt) {
      // Idempotent — first acceptance wins. We deliberately do NOT update
      // `agreementTextSnapshot` on re-acceptance, so the legally-binding
      // text remains locked at the moment of first click even if the
      // organizer edits the agreement HTML after that point.
      await db.verificationToken.delete({ where: { token: hashedToken } }).catch(() => {});
      apiLogger.info({
        msg: "Speaker agreement re-acceptance attempted (already accepted)",
        speakerId: speaker.id,
        eventId: speaker.event.id,
        ip: clientIp,
      });
      return NextResponse.json({ success: true, alreadyAccepted: true, acceptedAt: speaker.agreementAcceptedAt });
    }

    // Snapshot the merged HTML so the accepted text is literally what the
    // speaker saw — not the pre-merge template with `{{speakerName}}` in it.
    // Mirror the GET handler: never store the unmerged template.
    const rawSnapshot = speaker.event.speakerAgreementHtml || DEFAULT_SPEAKER_AGREEMENT_HTML;
    const context = await buildSpeakerEmailContext(speaker.event.id, speaker.id);
    if (!context) {
      apiLogger.error({
        msg: "speaker-agreement:context-build-failed-on-accept",
        speakerId: speaker.id,
        eventId: speaker.event.id,
        ip: clientIp,
      });
      return NextResponse.json(
        { error: "Unable to record acceptance at this time. Please contact the event organizer." },
        { status: 500 },
      );
    }
    const snapshot = mergeAgreementHtml(rawSnapshot, context);
    const acceptedAt = new Date();

    await db.$transaction([
      db.speaker.update({
        where: { id: speaker.id },
        data: {
          agreementAcceptedAt: acceptedAt,
          agreementAcceptedIp: clientIp,
          agreementTextSnapshot: snapshot,
          agreementAcceptedBy: "SPEAKER",
        },
      }),
      db.verificationToken.delete({ where: { token: hashedToken } }),
    ]);

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(speaker.event.id);

    apiLogger.info({
      msg: "Speaker agreement accepted",
      speakerId: speaker.id,
      eventId: speaker.event.id,
      ip: clientIp,
    });

    return NextResponse.json({ success: true, acceptedAt });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error accepting speaker agreement" });
    return NextResponse.json({ error: "Failed to accept agreement" }, { status: 500 });
  }
}
