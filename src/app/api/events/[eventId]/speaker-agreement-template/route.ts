import { NextResponse } from "next/server";
import { deleteStoredFile } from "@/lib/storage";
import { UPLOAD_PREFIX } from "@/lib/upload-prefixes";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
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

async function loadEvent(eventWhere: Prisma.EventWhereInput) {
  return db.event.findFirst({
    where: eventWhere,
    select: { id: true, speakerAgreementTemplate: true },
  });
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/speaker-agreement-template:GET" });
    if ("error" in orgGuard) return orgGuard.error;
    // Whoever reads the event's speakers reads the template; it was readable on
    // any event in the organisation by any org account before (Oct 5, 2026).
    const gate = requirePermission(session, "speakers.read", { route: "events/[eventId]/speaker-agreement-template:GET", eventId, onMissing: "hide" });
    if (!gate.ok) return gate.response;

    const event = await loadEvent(gate.eventWhere);
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/speaker-agreement-template:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "speakers.agreements.manage", { route: "events/[eventId]/speaker-agreement-template:POST", eventId });
    if (!gate.ok) return gate.response;

    const rl = checkRateLimit({
      key: `agreement-template-upload:${session.user.id}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "events/speaker-agreement-template:rate-limited", retryAfterSeconds: rl.retryAfterSeconds });
      return NextResponse.json(
        { error: "Upload rate limit reached. Maximum 10 uploads per hour." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const event = await loadEvent(gate.eventWhere);
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
        organizationId: orgGuard.orgId,
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/speaker-agreement-template:DELETE" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "speakers.agreements.manage", { route: "events/[eventId]/speaker-agreement-template:DELETE", eventId });
    if (!gate.ok) return gate.response;

    const event = await loadEvent(gate.eventWhere);
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const previous = event.speakerAgreementTemplate as SpeakerAgreementTemplateMeta | null;
    if (previous?.url) {
      await deleteStoredFile(previous.url, UPLOAD_PREFIX.agreements);
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
