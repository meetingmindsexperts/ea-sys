/**
 * POST /api/events/[eventId]/email-attachments
 *
 * Multipart upload of ONE operator-picked file (PDF/DOC/DOCX, 5 MB) for a
 * speaker email: single send, bulk send, reimbursement invitation. Returns a
 * {@link StoredAttachmentRef} the send body then carries instead of bytes.
 *
 * Why a separate upload (Sep 8, 2026): attachments used to travel inline as
 * base64 in the send's JSON body, which the middleware caps at 1 MB, so the
 * advertised limits were unreachable. Multipart gets the upload ceiling on
 * its own (no allow-list entry to forget), the file lands in storage (S3 on
 * prod) under a PRIVATE prefix keyed by event, and a queued send stores a
 * path, not a blob. The nightly email-attachment-prune job collects files no
 * queued send still references.
 *
 * Guards: session + the speaker-email write boundary (WEBINAR_STAFF_ALLOW,
 * matching the single-send route), event via buildEventAccessWhere, 60/hr
 * per user, extension resolved from the file (some OSes report an empty
 * type for .doc/.docx), size cap, magic bytes. Every refusal logs.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { uploadFile } from "@/lib/storage";
import { UPLOAD_SEGMENT } from "@/lib/upload-prefixes";
import {
  MAX_MANUAL_ATTACHMENT_BYTES,
  MAX_MANUAL_ATTACHMENT_MB,
  resolveAttachmentMime,
  type StoredAttachmentRef,
} from "@/lib/email-attachment-limits";
import {
  attachmentExtension,
  checkAttachmentBytes,
  sanitizeAttachmentFilename,
} from "@/lib/email-attachments";

const ROUTE = "events/[eventId]/email-attachments:POST";

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      apiLogger.warn({ msg: "email-attachments:unauthorized", eventId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW, route: ROUTE });
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "email-attachments:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const rl = checkRateLimit({
      key: `email-attachment-upload:${session.user.id}`,
      limit: 60,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      return rateLimited(rl, { route: ROUTE, eventId, userId: session.user.id, limit: 60, windowSeconds: 3600 });
    }

    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      apiLogger.warn({ msg: "email-attachments:no-file", eventId, userId: session.user.id });
      return NextResponse.json({ error: "No file provided", code: "NO_FILE" }, { status: 400 });
    }

    const contentType = resolveAttachmentMime({ name: file.name, type: file.type });
    const ext = contentType ? attachmentExtension(contentType) : null;
    if (!contentType || !ext) {
      apiLogger.warn({ msg: "email-attachments:unsupported-type", eventId, userId: session.user.id, claimedType: file.type, name: file.name });
      return NextResponse.json(
        { error: `Unsupported file type for "${file.name}". Only PDF, DOC, and DOCX are allowed.`, code: "UNSUPPORTED_TYPE" },
        { status: 400 },
      );
    }
    if (file.size > MAX_MANUAL_ATTACHMENT_BYTES) {
      apiLogger.warn({ msg: "email-attachments:too-large", eventId, userId: session.user.id, size: file.size });
      return NextResponse.json(
        { error: `The attachment "${file.name}" is over the ${MAX_MANUAL_ATTACHMENT_MB} MB per-file limit.`, code: "TOO_LARGE" },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const check = checkAttachmentBytes(buffer, contentType, file.name);
    if (!check.ok) {
      apiLogger.warn({ msg: "email-attachments:bytes-rejected", eventId, userId: session.user.id, code: check.code, claimedType: file.type });
      return NextResponse.json({ error: check.error, code: check.code }, { status: 400 });
    }

    const storedPath = await uploadFile(
      buffer,
      `${randomUUID()}.${ext}`,
      contentType,
      `${UPLOAD_SEGMENT.emailAttachments}/${eventId}`,
    );

    const ref: StoredAttachmentRef & { size: number } = {
      storedPath,
      name: sanitizeAttachmentFilename(file.name, contentType),
      contentType,
      size: buffer.length,
    };
    apiLogger.info({ msg: "email-attachments:uploaded", eventId, userId: session.user.id, storedPath, size: buffer.length, contentType });
    return NextResponse.json(ref, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "email-attachments:upload-failed" });
    return NextResponse.json({ error: "Failed to upload attachment" }, { status: 500 });
  }
}
