/**
 * Speaker reimbursement — organizer detail / reopen / delete.
 *
 *   GET    → the full row (sections B–F incl. bank details) + documents.
 *   PATCH  → { action: "reopen" } — flips SUBMITTED → PENDING so the speaker
 *            can correct a mistake (typo'd IBAN). Conditional claim on the
 *            expected prior status, audited. Submitted forms are otherwise
 *            LOCKED (v1 has no approval flow, so the lock point is submit).
 *   DELETE → removes the invite/submission + its uploaded files
 *            (best-effort unlink), audited.
 *
 * ACCESS: staff-only via denyReviewer on every handler (wire-transfer PII —
 * see the list route header).
 */
import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";

type RouteParams = { params: Promise<{ eventId: string; reimbursementId: string }> };

const patchSchema = z.object({ action: z.literal("reopen") });

async function loadInEvent(
  user: { id: string; role: string; organizationId?: string | null },
  eventId: string,
  reimbursementId: string,
) {
  const event = await db.event.findFirst({
    where: buildEventAccessWhere(user, eventId),
    select: { id: true },
  });
  if (!event) return null;
  // Bound through the event so a mis-scoped id can't reach a sibling event's
  // row (the atomic primary-query-binding rule).
  return db.speakerReimbursement.findFirst({
    where: { id: reimbursementId, eventId },
    select: { id: true, status: true },
  });
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, reimbursementId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "reimbursement:detail-event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const reimbursement = await db.speakerReimbursement.findFirst({
      where: { id: reimbursementId, eventId },
      include: {
        speaker: {
          select: { id: true, title: true, firstName: true, lastName: true, email: true },
        },
        documents: {
          select: { id: true, kind: true, filename: true, mimeType: true, size: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!reimbursement) {
      apiLogger.warn({ eventId, reimbursementId, userId: session.user.id }, "reimbursement:detail-not-found");
      return NextResponse.json({ error: "Reimbursement not found" }, { status: 404 });
    }
    return NextResponse.json({ reimbursement });
  } catch (err) {
    apiLogger.error({ err }, "reimbursement:detail-failed");
    return NextResponse.json({ error: "Failed to load reimbursement" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, reimbursementId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;

    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten(), eventId, reimbursementId }, "reimbursement:patch-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const row = await loadInEvent(session.user, eventId, reimbursementId);
    if (!row) {
      apiLogger.warn({ eventId, reimbursementId, userId: session.user.id }, "reimbursement:patch-not-found");
      return NextResponse.json({ error: "Reimbursement not found" }, { status: 404 });
    }

    // Conditional claim on the expected prior status: two concurrent reopens
    // (or a reopen racing a delete) can't both "win" — the loser gets a 409.
    const { count } = await db.speakerReimbursement.updateMany({
      where: { id: reimbursementId, eventId, status: "SUBMITTED" },
      data: { status: "PENDING" },
    });
    if (count === 0) {
      apiLogger.warn({ eventId, reimbursementId, status: row.status }, "reimbursement:reopen-not-submitted");
      return NextResponse.json(
        { error: "Only a submitted form can be reopened.", code: "NOT_SUBMITTED" },
        { status: 409 },
      );
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "SPEAKER_REIMBURSEMENT",
          entityId: reimbursementId,
          changes: { action: "reopen", before: "SUBMITTED", after: "PENDING" },
        },
      })
      .catch((err) => apiLogger.error({ err }, "reimbursement:audit-failed"));

    apiLogger.info({ eventId, reimbursementId, userId: session.user.id }, "reimbursement:reopened");
    return NextResponse.json({ ok: true, status: "PENDING" });
  } catch (err) {
    apiLogger.error({ err }, "reimbursement:patch-failed");
    return NextResponse.json({ error: "Failed to update reimbursement" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, reimbursementId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;

    const row = await loadInEvent(session.user, eventId, reimbursementId);
    if (!row) {
      apiLogger.warn({ eventId, reimbursementId, userId: session.user.id }, "reimbursement:delete-not-found");
      return NextResponse.json({ error: "Reimbursement not found" }, { status: 404 });
    }

    // Capture file urls before the cascade removes the rows, then unlink
    // best-effort after the delete (an orphaned file is a cleanup nit; a
    // dangling DB row would be worse).
    const docs = await db.speakerReimbursementDocument.findMany({
      where: { reimbursementId },
      select: { url: true },
    });
    await db.speakerReimbursement.delete({ where: { id: reimbursementId } });

    for (const doc of docs) {
      if (!doc.url.startsWith("/uploads/reimbursements/")) continue;
      const abs = path.resolve(process.cwd(), "public", doc.url.slice(1));
      await fs.unlink(abs).catch((err) =>
        apiLogger.warn({ err, abs }, "reimbursement:delete-unlink-failed"),
      );
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "DELETE",
          entityType: "SPEAKER_REIMBURSEMENT",
          entityId: reimbursementId,
          changes: { statusAtDelete: row.status, documents: docs.length },
        },
      })
      .catch((err) => apiLogger.error({ err }, "reimbursement:audit-failed"));

    apiLogger.info({ eventId, reimbursementId, userId: session.user.id }, "reimbursement:deleted");
    return NextResponse.json({ ok: true });
  } catch (err) {
    apiLogger.error({ err }, "reimbursement:delete-failed");
    return NextResponse.json({ error: "Failed to delete reimbursement" }, { status: 500 });
  }
}
