import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp, checkRateLimit } from "@/lib/security";
import { DEFAULT_SPEAKER_AGREEMENT_HTML } from "@/lib/default-terms";

interface RouteParams {
  params: Promise<{ eventId: string; speakerId: string }>;
}

const patchSchema = z.object({
  accepted: z.boolean(),
});

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, speakerId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const rateLimit = checkRateLimit({
      key: `speaker-agreement-patch:${session.user.id}`,
      limit: 60,
      windowMs: 60 * 1000,
    });
    if (!rateLimit.allowed) {
      apiLogger.warn({ msg: "Speaker agreement PATCH rate limit hit", userId: session.user.id });
      return NextResponse.json(
        { error: "Too many requests. Please slow down." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
      );
    }

    const body = await req.json().catch(() => ({}));
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "Invalid speaker agreement PATCH payload", errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const [event, speaker] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          ...(session.user.organizationId ? { organizationId: session.user.organizationId } : {}),
        },
        select: { id: true, speakerAgreementHtml: true },
      }),
      db.speaker.findFirst({
        where: { id: speakerId, eventId },
        select: { id: true, agreementAcceptedAt: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!speaker) {
      return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
    }

    const clientIp = getClientIp(req);
    const snapshot = event.speakerAgreementHtml || DEFAULT_SPEAKER_AGREEMENT_HTML;

    const updated = await db.speaker.update({
      where: { id: speaker.id },
      data: parsed.data.accepted
        ? {
            agreementAcceptedAt: new Date(),
            agreementAcceptedIp: clientIp,
            agreementAcceptedBy: `ORGANIZER:${session.user.id}`,
            agreementTextSnapshot: snapshot,
          }
        : {
            agreementAcceptedAt: null,
            agreementAcceptedIp: null,
            agreementAcceptedBy: null,
            agreementTextSnapshot: null,
          },
      select: {
        id: true,
        agreementAcceptedAt: true,
        agreementAcceptedIp: true,
        agreementAcceptedBy: true,
      },
    });

    // Fire-and-forget audit log
    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: parsed.data.accepted ? "SPEAKER_AGREEMENT_ACCEPTED" : "SPEAKER_AGREEMENT_REVOKED",
          entityType: "Speaker",
          entityId: speaker.id,
          changes: {
            accepted: parsed.data.accepted,
            actor: "ORGANIZER",
            ip: clientIp,
          },
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "Failed to write speaker agreement audit log" }));

    apiLogger.info({
      msg: parsed.data.accepted ? "Speaker agreement marked accepted by organizer" : "Speaker agreement revoked by organizer",
      speakerId: speaker.id,
      eventId,
      userId: session.user.id,
    });

    return NextResponse.json({ success: true, speaker: updated });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating speaker agreement" });
    return NextResponse.json({ error: "Failed to update agreement" }, { status: 500 });
  }
}
