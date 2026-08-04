/**
 * Public speaker profile form — passport / cover-letter upload (token-gated).
 *
 *   POST multipart { file, slot } → stores the file + creates/REPLACES the
 *   slot's SpeakerDocument row (kind OTHER, fixed label — the same rows the
 *   organizer's Documents card shows). ONE document per slot; a re-upload
 *   replaces the previous one (old row deleted, old file unlinked
 *   best-effort). Only while the form is PENDING — a submitted form is
 *   locked (the organizer reopens from the speaker page).
 *
 * PDF / JPG / PNG, magic-byte validated, 10MB. Files land under
 * public/uploads/speaker-docs/{eventId}/ — which the public /uploads
 * catch-all BLOCKS (passport = sensitive PII); staff stream them via the
 * authed documents file route.
 */
import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import {
  PROFILE_DOC_LABELS,
  PROFILE_DOC_MAX_SIZE,
  PROFILE_DOC_SLOTS,
  profileSlotForLabel,
  type ProfileDocSlot,
} from "@/lib/speaker-profile/constants";
import { loadProfileFormForSlug, resolveProfileFormEventOrg } from "@/lib/speaker-profile/server";

type RouteParams = { params: Promise<{ slug: string; token: string }> };

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
    const ipLimit = checkRateLimit({ key: `speaker-form-upload:${ip}`, limit: 120, windowMs: 3600_000 });
    const tokenLimit = checkRateLimit({
      key: `speaker-form-upload-token:${token.slice(0, 16)}`,
      limit: 40,
      windowMs: 3600_000,
    });
    if (!ipLimit.allowed || !tokenLimit.allowed) {
      const retryAfterSeconds = Math.max(ipLimit.retryAfterSeconds ?? 0, tokenLimit.retryAfterSeconds ?? 0);
      apiLogger.warn({ slug, ip, stage: "upload" }, "speaker-form-upload:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const org = await resolveProfileFormEventOrg(req, slug);
    if (!org) {
      apiLogger.warn({ slug, stage: "upload-org" }, "speaker-form-upload:invalid-token");
      return NextResponse.json({ error: "This link is invalid." }, { status: 404 });
    }
    return await runWithTenant(org, async () => {
      const row = await loadProfileFormForSlug(req, slug, token);
      if (!row) {
        apiLogger.warn({ slug, stage: "upload" }, "speaker-form-upload:invalid-token");
        return NextResponse.json({ error: "This link is invalid." }, { status: 404 });
      }
      if (row.status === "SUBMITTED") {
        apiLogger.warn({ slug, formId: row.id }, "speaker-form-upload:locked");
        return NextResponse.json(
          { error: "This form has been submitted — contact the organizers for changes.", code: "ALREADY_SUBMITTED" },
          { status: 409 },
        );
      }

      const formData = await req.formData();
      const file = formData.get("file") as File | null;
      const slot = String(formData.get("slot") ?? "") as ProfileDocSlot;
      if (!file) {
        apiLogger.warn({ slug, formId: row.id, stage: "no-file" }, "speaker-form-upload:no-file");
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
      }
      if (!PROFILE_DOC_SLOTS.includes(slot)) {
        apiLogger.warn({ slug, formId: row.id, slot, stage: "bad-slot" }, "speaker-form-upload:invalid-slot");
        return NextResponse.json({ error: "Invalid document slot" }, { status: 400 });
      }
      const allowed = ALLOWED[file.type];
      if (!allowed) {
        apiLogger.warn({ slug, formId: row.id, claimedType: file.type, stage: "mime" }, "speaker-form-upload:invalid-mime");
        return NextResponse.json({ error: "Only PDF, JPG and PNG files are allowed" }, { status: 400 });
      }
      if (file.size > PROFILE_DOC_MAX_SIZE) {
        apiLogger.warn({ slug, formId: row.id, size: file.size, stage: "size" }, "speaker-form-upload:too-large");
        return NextResponse.json({ error: "File must be under 10MB" }, { status: 400 });
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!magicMatches(buffer, allowed.magic)) {
        apiLogger.warn({ slug, formId: row.id, claimedType: file.type, stage: "magic" }, "speaker-form-upload:invalid-magic-bytes");
        return NextResponse.json({ error: "File content does not match its declared type" }, { status: 400 });
      }

      const dirRel = path.join("uploads", "speaker-docs", row.eventId);
      const dirAbs = path.resolve(process.cwd(), "public", dirRel);
      await fs.mkdir(dirAbs, { recursive: true });
      const storedName = `${randomUUID()}.${allowed.ext}`;
      await fs.writeFile(path.join(dirAbs, storedName), buffer);
      const url = `/${dirRel.split(path.sep).join("/")}/${storedName}`;

      const label = PROFILE_DOC_LABELS[slot];
      // Replace-in-place: one document per slot. Alias-matched (an
      // organizer-uploaded "Passport" is this slot too). Old row deleted in
      // the same tx as the create; the old FILE is unlinked after commit,
      // best-effort (an orphan file is cheap — the INC-004 direction).
      const previous = row.speaker.documents.find((d) => profileSlotForLabel(d.label) === slot) ?? null;
      const previousUrl = previous
        ? (await db.speakerDocument.findUnique({ where: { id: previous.id }, select: { url: true } }))?.url ?? null
        : null;
      const document = await tenantTransaction(async (tx) => {
        if (previous) {
          await tx.speakerDocument.deleteMany({ where: { id: previous.id, speakerId: row.speaker.id } });
        }
        return tx.speakerDocument.create({
          data: {
            speakerId: row.speaker.id,
            organizationId: row.event.organizationId,
            kind: "OTHER",
            label,
            url,
            filename: file.name.slice(0, 255),
            mimeType: file.type,
            size: file.size,
            uploadedById: null, // the speaker themselves — no User row behind them
          },
          select: { id: true, label: true, filename: true, size: true, createdAt: true },
        });
      });
      if (previousUrl?.startsWith("/uploads/speaker-docs/")) {
        const rel = previousUrl.replace(/^\//, "");
        const abs = path.resolve(process.cwd(), "public", rel);
        if (abs.startsWith(path.resolve(process.cwd(), "public", "uploads", "speaker-docs") + path.sep)) {
          fs.unlink(abs).catch(() => {
            apiLogger.warn({ formId: row.id, previousUrl }, "speaker-form-upload:old-file-unlink-failed");
          });
        }
      }

      apiLogger.info({ slug, formId: row.id, slot, size: file.size, replaced: !!previous }, "speaker-form-upload:uploaded");
      return NextResponse.json({ document, replaced: !!previous }, { status: 201 });
    });
  } catch (err) {
    apiLogger.error({ err }, "speaker-form-upload:failed");
    return NextResponse.json({ error: "Failed to upload document" }, { status: 500 });
  }
}
