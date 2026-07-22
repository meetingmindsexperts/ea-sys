/**
 * Public speaker-reimbursement — receipt/passport upload (token-gated).
 *
 *   POST multipart { file, kind } → stores the file + creates the document
 *   row. Only while the form is PENDING (a submitted form is locked).
 *
 * PDF / JPG / PNG only, magic-byte validated, 10MB, max 15 documents per
 * reimbursement. Files land under public/uploads/reimbursements/{eventId}/
 * — which the public /uploads catch-all BLOCKS; staff read them via the
 * authed documents route, and the speaker only ever sees filename metadata.
 */
import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { documentKindSchema, MAX_REIMBURSEMENT_DOCUMENTS } from "@/lib/reimbursement/constants";
import { loadReimbursementForSlug } from "@/lib/reimbursement/server";

type RouteParams = { params: Promise<{ slug: string; token: string }> };

export const REIMBURSEMENT_DOC_MAX_SIZE = 10 * 1024 * 1024;

const ALLOWED: Record<string, { ext: string; magic: number[][] }> = {
  "application/pdf": { ext: "pdf", magic: [[0x25, 0x50, 0x44, 0x46, 0x2d]] }, // %PDF-
  "image/jpeg": { ext: "jpg", magic: [[0xff, 0xd8, 0xff]] },
  "image/png": { ext: "png", magic: [[0x89, 0x50, 0x4e, 0x47]] },
};

function magicMatches(buf: Buffer, magics: number[][]): boolean {
  return magics.some((magic) => buf.length >= magic.length && magic.every((b, i) => buf[i] === b));
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug, token } = await params;
    const ip = getClientIp(req);
    const ipLimit = checkRateLimit({ key: `reimb-upload:${ip}`, limit: 120, windowMs: 3600_000 });
    const tokenLimit = checkRateLimit({
      key: `reimb-upload-token:${token.slice(0, 16)}`,
      limit: 40,
      windowMs: 3600_000,
    });
    if (!ipLimit.allowed || !tokenLimit.allowed) {
      const retryAfterSeconds = Math.max(
        ipLimit.retryAfterSeconds ?? 0,
        tokenLimit.retryAfterSeconds ?? 0,
      );
      apiLogger.warn({ slug, ip, stage: "upload" }, "reimbursement-upload:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const row = await loadReimbursementForSlug(req, slug, token);
    if (!row) {
      apiLogger.warn({ slug, stage: "upload" }, "reimbursement-upload:invalid-token");
      return NextResponse.json({ error: "This reimbursement link is invalid." }, { status: 404 });
    }
    // Post-submission uploads are ALLOWED (append-only — see the header):
    // a forgotten/illegible receipt can be added without an organizer
    // reopen. Removal after submission stays blocked (sibling DELETE route).
    if (row.documents.length >= MAX_REIMBURSEMENT_DOCUMENTS) {
      apiLogger.warn({ slug, reimbursementId: row.id, stage: "upload-cap" }, "reimbursement-upload:too-many");
      return NextResponse.json(
        { error: `Maximum ${MAX_REIMBURSEMENT_DOCUMENTS} documents per form.` },
        { status: 400 },
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const kindParsed = documentKindSchema.safeParse(String(formData.get("kind") ?? ""));
    if (!file) {
      apiLogger.warn({ slug, reimbursementId: row.id, stage: "no-file" }, "reimbursement-upload:no-file");
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    if (!kindParsed.success) {
      apiLogger.warn({ slug, reimbursementId: row.id, stage: "bad-kind" }, "reimbursement-upload:invalid-kind");
      return NextResponse.json({ error: "Invalid document kind" }, { status: 400 });
    }
    const allowed = ALLOWED[file.type];
    if (!allowed) {
      apiLogger.warn(
        { slug, reimbursementId: row.id, claimedType: file.type, stage: "mime" },
        "reimbursement-upload:invalid-mime",
      );
      return NextResponse.json({ error: "Only PDF, JPG and PNG files are allowed" }, { status: 400 });
    }
    if (file.size > REIMBURSEMENT_DOC_MAX_SIZE) {
      apiLogger.warn(
        { slug, reimbursementId: row.id, size: file.size, stage: "size" },
        "reimbursement-upload:too-large",
      );
      return NextResponse.json({ error: "File must be under 10MB" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (!magicMatches(buffer, allowed.magic)) {
      apiLogger.warn(
        { slug, reimbursementId: row.id, claimedType: file.type, stage: "magic" },
        "reimbursement-upload:invalid-magic-bytes",
      );
      return NextResponse.json(
        { error: "File content does not match its declared type" },
        { status: 400 },
      );
    }

    const dirRel = path.join("uploads", "reimbursements", row.eventId);
    const dirAbs = path.resolve(process.cwd(), "public", dirRel);
    await fs.mkdir(dirAbs, { recursive: true });
    const storedName = `${randomUUID()}.${allowed.ext}`;
    await fs.writeFile(path.join(dirAbs, storedName), buffer);
    const url = `/${dirRel.split(path.sep).join("/")}/${storedName}`;

    const document = await db.speakerReimbursementDocument.create({
      data: {
        reimbursementId: row.id,
        kind: kindParsed.data,
        url,
        filename: file.name.slice(0, 255),
        mimeType: file.type,
        size: file.size,
      },
      select: { id: true, kind: true, filename: true, size: true, createdAt: true },
    });

    // A document appended AFTER submission changes what finance sees on a
    // signed form — audit it (with IP) so it shows on the speaker's Activity
    // timeline. Pre-submission uploads are covered by the submit audit's
    // document-kind list. Fire-and-forget: the upload already committed.
    if (row.status === "SUBMITTED") {
      db.auditLog
        .create({
          data: {
            eventId: row.eventId,
            userId: null,
            action: "DOCUMENT_ADDED",
            entityType: "SPEAKER_REIMBURSEMENT",
            entityId: row.id,
            changes: {
              actor: "SPEAKER",
              speakerId: row.speaker.id,
              postSubmission: true,
              kind: kindParsed.data,
              filename: document.filename,
              size: file.size,
              ip,
            },
            ipAddress: ip,
          },
        })
        .catch((err) =>
          apiLogger.error({ err, reimbursementId: row.id }, "reimbursement-upload:audit-failed"),
        );
    }

    apiLogger.info(
      { slug, reimbursementId: row.id, kind: kindParsed.data, size: file.size, postSubmission: row.status === "SUBMITTED" },
      "reimbursement-upload:uploaded",
    );
    return NextResponse.json({ document }, { status: 201 });
  } catch (err) {
    apiLogger.error({ err }, "reimbursement-upload:failed");
    return NextResponse.json({ error: "Failed to upload document" }, { status: 500 });
  }
}
