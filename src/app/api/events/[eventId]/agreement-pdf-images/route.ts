import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit, getClientIp } from "@/lib/security";
import {
  AGREEMENT_PDF_IMAGE_MAX_SIZE,
  AGREEMENT_IMAGE_COLUMN,
  SpeakerAgreementTemplateError,
  saveAgreementPdfImage,
  deleteAgreementPdfImage,
} from "@/lib/speaker-agreement";

/**
 * Letterhead images for the generated agreement PDFs (July 17, 2026). The
 * speaker and presenter agreements each carry their own header/footer pair —
 * `scope` picks which. POST uploads a banner (PNG/JPEG only — pdfkit cannot
 * embed WebP; enforced by magic bytes in the shared save helper, mirroring
 * the sibling .docx template route). DELETE clears a slot. The event GET
 * already returns all four columns, so there is no dedicated GET here.
 */

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const scopeSchema = z.enum(["speaker", "presenter"]);
const slotSchema = z.enum(["header", "footer"]);

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const rl = checkRateLimit({
      key: `agreement-pdf-image-upload:${session.user.id}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "events/agreement-pdf-images:rate-limited", retryAfterSeconds: rl.retryAfterSeconds });
      return NextResponse.json(
        { error: "Upload rate limit reached. Maximum 20 uploads per hour." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const formData = await req.formData();
    const scopeParse = scopeSchema.safeParse(formData.get("scope"));
    const slotParse = slotSchema.safeParse(formData.get("slot"));
    if (!scopeParse.success || !slotParse.success) {
      apiLogger.warn({
        msg: "events/agreement-pdf-images:invalid-scope-or-slot",
        scope: formData.get("scope"),
        slot: formData.get("slot"),
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "scope must be 'speaker' or 'presenter' and slot must be 'header' or 'footer'" },
        { status: 400 },
      );
    }
    const file = formData.get("file") as File | null;
    if (!file) {
      apiLogger.warn({ msg: "events/agreement-pdf-images:no-file", userId: session.user.id });
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    if (file.size > AGREEMENT_PDF_IMAGE_MAX_SIZE) {
      apiLogger.warn({ msg: "events/agreement-pdf-images:too-large", size: file.size, userId: session.user.id });
      return NextResponse.json({ error: "Image must be under 2MB" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    let url: string;
    try {
      ({ url } = await saveAgreementPdfImage({
        eventId,
        organizationId: session.user.organizationId!,
        buffer,
        scope: scopeParse.data,
        slot: slotParse.data,
        actorUserId: session.user.id,
      }));
    } catch (err) {
      if (err instanceof SpeakerAgreementTemplateError) {
        const status = err.code === "EVENT_NOT_FOUND" ? 404 : 400;
        apiLogger.warn({ msg: "events/agreement-pdf-images:rejected", code: err.code, userId: session.user.id });
        return NextResponse.json({ error: err.message, code: err.code }, { status });
      }
      throw err;
    }

    await db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "Event",
          entityId: eventId,
          changes: {
            field: AGREEMENT_IMAGE_COLUMN[scopeParse.data][slotParse.data],
            url,
            ip: getClientIp(req),
          },
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "events/agreement-pdf-images:audit-failed", eventId }));

    return NextResponse.json({ scope: scopeParse.data, slot: slotParse.data, url });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error uploading agreement PDF image" });
    return NextResponse.json({ error: "Failed to upload image" }, { status: 500 });
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

    const { searchParams } = new URL(req.url);
    const scopeParse = scopeSchema.safeParse(searchParams.get("scope"));
    const slotParse = slotSchema.safeParse(searchParams.get("slot"));
    if (!scopeParse.success || !slotParse.success) {
      apiLogger.warn({
        msg: "events/agreement-pdf-images:invalid-scope-or-slot",
        scope: searchParams.get("scope"),
        slot: searchParams.get("slot"),
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "scope must be 'speaker' or 'presenter' and slot must be 'header' or 'footer'" },
        { status: 400 },
      );
    }

    try {
      await deleteAgreementPdfImage({
        eventId,
        organizationId: session.user.organizationId!,
        scope: scopeParse.data,
        slot: slotParse.data,
      });
    } catch (err) {
      if (err instanceof SpeakerAgreementTemplateError && err.code === "EVENT_NOT_FOUND") {
        apiLogger.warn({ msg: "events/agreement-pdf-images:delete-event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      throw err;
    }

    await db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "DELETE",
          entityType: "Event",
          entityId: eventId,
          changes: {
            field: AGREEMENT_IMAGE_COLUMN[scopeParse.data][slotParse.data],
            ip: getClientIp(req),
          },
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "events/agreement-pdf-images:audit-failed", eventId }));

    return NextResponse.json({ scope: scopeParse.data, slot: slotParse.data, url: null });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting agreement PDF image" });
    return NextResponse.json({ error: "Failed to delete image" }, { status: 500 });
  }
}
