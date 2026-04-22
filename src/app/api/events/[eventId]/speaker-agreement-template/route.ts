import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit, getClientIp } from "@/lib/security";
import {
  SPEAKER_AGREEMENT_DOCX_MIME,
  SPEAKER_AGREEMENT_TEMPLATE_MAX_SIZE,
  SpeakerAgreementTemplateError,
  saveSpeakerAgreementTemplate,
  type SpeakerAgreementTemplateMeta,
} from "@/lib/speaker-agreement";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

async function loadEvent(eventId: string, organizationId: string) {
  return db.event.findFirst({
    where: { id: eventId, organizationId },
    select: { id: true, speakerAgreementTemplate: true },
  });
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await loadEvent(eventId, session.user.organizationId!);
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return NextResponse.json({
      template: (event.speakerAgreementTemplate as SpeakerAgreementTemplateMeta | null) ?? null,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching speaker agreement template" });
    return NextResponse.json({ error: "Failed to fetch template" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const rl = checkRateLimit({
      key: `agreement-template-upload:${session.user.id}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Upload rate limit reached. Maximum 10 uploads per hour." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const event = await loadEvent(eventId, session.user.organizationId!);
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (file.type !== SPEAKER_AGREEMENT_DOCX_MIME) {
      apiLogger.warn({ msg: "agreement-template:invalid-mime", claimedType: file.type, userId: session.user.id });
      return NextResponse.json({ error: "Only .docx files are allowed" }, { status: 400 });
    }

    if (file.size > SPEAKER_AGREEMENT_TEMPLATE_MAX_SIZE) {
      return NextResponse.json({ error: "Template must be under 2MB" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    let meta: SpeakerAgreementTemplateMeta;
    try {
      meta = await saveSpeakerAgreementTemplate({
        eventId,
        organizationId: session.user.organizationId!,
        buffer,
        filename: file.name,
        actorUserId: session.user.id,
      });
    } catch (err) {
      if (err instanceof SpeakerAgreementTemplateError) {
        const status = err.code === "EVENT_NOT_FOUND" ? 404 : 400;
        return NextResponse.json({ error: err.message, code: err.code }, { status });
      }
      throw err;
    }

    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UPDATE",
        entityType: "Event",
        entityId: eventId,
        changes: {
          field: "speakerAgreementTemplate",
          filename: meta.filename,
          ip: getClientIp(req),
        },
      },
    });

    return NextResponse.json({ template: meta });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error uploading speaker agreement template" });
    return NextResponse.json({ error: "Failed to upload template" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await loadEvent(eventId, session.user.organizationId!);
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const previous = event.speakerAgreementTemplate as SpeakerAgreementTemplateMeta | null;
    if (previous?.url?.startsWith("/uploads/agreements/")) {
      const previousAbs = path.resolve(process.cwd(), "public", previous.url.replace(/^\/+/, ""));
      const expectedRoot = path.resolve(process.cwd(), "public", "uploads", "agreements");
      if (previousAbs.startsWith(expectedRoot + path.sep)) {
        await fs.unlink(previousAbs).catch((err) =>
          apiLogger.warn({ err, msg: "agreement-template:delete-unlink-failed", previousAbs }),
        );
      }
    }

    await db.event.update({
      where: { id: eventId },
      data: { speakerAgreementTemplate: Prisma.DbNull },
    });

    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "Event",
        entityId: eventId,
        changes: { field: "speakerAgreementTemplate", ip: getClientIp(req) },
      },
    });

    return NextResponse.json({ template: null });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting speaker agreement template" });
    return NextResponse.json({ error: "Failed to delete template" }, { status: 500 });
  }
}
