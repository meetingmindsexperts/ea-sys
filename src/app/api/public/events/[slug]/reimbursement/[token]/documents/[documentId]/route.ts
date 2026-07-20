/**
 * Public speaker-reimbursement — remove an uploaded document (token-gated).
 * Only while the form is PENDING; the doc must belong to THIS token's
 * reimbursement. Unlinks the stored file best-effort after the row delete.
 */
import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { loadReimbursementForSlug } from "@/lib/reimbursement/server";

type RouteParams = { params: Promise<{ slug: string; token: string; documentId: string }> };

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { slug, token, documentId } = await params;
    const ip = getClientIp(req);
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `reimb-doc-delete:${ip}`,
      limit: 120,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ slug, ip, stage: "doc-delete" }, "reimbursement-doc-delete:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const row = await loadReimbursementForSlug(slug, token);
    if (!row) {
      apiLogger.warn({ slug, stage: "doc-delete" }, "reimbursement-doc-delete:invalid-token");
      return NextResponse.json({ error: "This reimbursement link is invalid." }, { status: 404 });
    }
    if (row.status === "SUBMITTED") {
      apiLogger.warn(
        { slug, reimbursementId: row.id, stage: "doc-delete-locked" },
        "reimbursement-doc-delete:locked",
      );
      return NextResponse.json(
        { error: "This form has already been submitted.", code: "ALREADY_SUBMITTED" },
        { status: 409 },
      );
    }

    const doc = await db.speakerReimbursementDocument.findFirst({
      where: { id: documentId, reimbursementId: row.id },
      select: { id: true, url: true },
    });
    if (!doc) {
      apiLogger.warn({ slug, documentId, stage: "doc-delete" }, "reimbursement-doc-delete:not-found");
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    await db.speakerReimbursementDocument.delete({ where: { id: doc.id } });
    if (doc.url.startsWith("/uploads/reimbursements/")) {
      const abs = path.resolve(process.cwd(), "public", doc.url.slice(1));
      await fs.unlink(abs).catch((err) =>
        apiLogger.warn({ err, abs }, "reimbursement-doc-delete:unlink-failed"),
      );
    }

    apiLogger.info({ slug, reimbursementId: row.id, documentId }, "reimbursement-doc-delete:deleted");
    return NextResponse.json({ ok: true });
  } catch (err) {
    apiLogger.error({ err }, "reimbursement-doc-delete:failed");
    return NextResponse.json({ error: "Failed to remove document" }, { status: 500 });
  }
}
