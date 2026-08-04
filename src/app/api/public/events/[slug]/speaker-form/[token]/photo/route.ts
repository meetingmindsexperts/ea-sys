/**
 * Public speaker profile form — headshot upload (token-gated).
 *
 *   POST multipart { file } → validates (JPEG/PNG/WebP, magic bytes, 500KB —
 *   the same rules as every other photo upload in the system), stores via the
 *   shared uploadPhoto() provider (public /uploads/photos/YYYY/MM/ — photos
 *   are intentionally public, unlike the passport docs) and sets
 *   Speaker.photo immediately. Re-upload replaces. Locked after submission.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { uploadPhoto } from "@/lib/storage";
import { PROFILE_PHOTO_MAX_SIZE } from "@/lib/speaker-profile/constants";
import { loadProfileFormForSlug, resolveProfileFormEventOrg } from "@/lib/speaker-profile/server";

type RouteParams = { params: Promise<{ slug: string; token: string }> };

// Same allowlist + magic bytes as /api/upload/photo (that route is
// auth-gated and keeps its validation inline, so the public form re-declares
// the identical rules here).
const MAGIC: Array<{ mime: "image/jpeg" | "image/png" | "image/webp"; bytes: number[]; offset: number }> = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff], offset: 0 },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0 },
  { mime: "image/webp", bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 }, // RIFF....WEBP
];

function detectImageMime(buf: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  for (const m of MAGIC) {
    if (buf.length >= m.offset + m.bytes.length && m.bytes.every((b, i) => buf[m.offset + i] === b)) {
      return m.mime;
    }
  }
  return null;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug, token } = await params;
    const ip = getClientIp(req);
    const ipLimit = checkRateLimit({ key: `speaker-form-photo:${ip}`, limit: 60, windowMs: 3600_000 });
    const tokenLimit = checkRateLimit({
      key: `speaker-form-photo-token:${token.slice(0, 16)}`,
      limit: 20,
      windowMs: 3600_000,
    });
    if (!ipLimit.allowed || !tokenLimit.allowed) {
      const retryAfterSeconds = Math.max(ipLimit.retryAfterSeconds ?? 0, tokenLimit.retryAfterSeconds ?? 0);
      apiLogger.warn({ slug, ip, stage: "photo" }, "speaker-form-photo:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const org = await resolveProfileFormEventOrg(req, slug);
    if (!org) {
      apiLogger.warn({ slug, stage: "photo-org" }, "speaker-form-photo:invalid-token");
      return NextResponse.json({ error: "This link is invalid." }, { status: 404 });
    }
    return await runWithTenant(org, async () => {
      const row = await loadProfileFormForSlug(req, slug, token);
      if (!row) {
        apiLogger.warn({ slug, stage: "photo" }, "speaker-form-photo:invalid-token");
        return NextResponse.json({ error: "This link is invalid." }, { status: 404 });
      }
      if (row.status === "SUBMITTED") {
        apiLogger.warn({ slug, formId: row.id }, "speaker-form-photo:locked");
        return NextResponse.json(
          { error: "This form has been submitted — contact the organizers for changes.", code: "ALREADY_SUBMITTED" },
          { status: 409 },
        );
      }

      const formData = await req.formData();
      const file = formData.get("file") as File | null;
      if (!file) {
        apiLogger.warn({ slug, formId: row.id, stage: "no-file" }, "speaker-form-photo:no-file");
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
      }
      if (file.size > PROFILE_PHOTO_MAX_SIZE) {
        apiLogger.warn({ slug, formId: row.id, size: file.size, stage: "size" }, "speaker-form-photo:too-large");
        return NextResponse.json({ error: "Photo must be under 500KB" }, { status: 400 });
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const detected = detectImageMime(buffer);
      if (!detected) {
        apiLogger.warn({ slug, formId: row.id, claimedType: file.type, stage: "magic" }, "speaker-form-photo:invalid-magic-bytes");
        return NextResponse.json({ error: "Only JPEG, PNG and WebP images are allowed" }, { status: 400 });
      }

      const url = await uploadPhoto(buffer, file.name, detected);
      await db.speaker.update({ where: { id: row.speaker.id }, data: { photo: url } });

      apiLogger.info({ slug, formId: row.id, size: file.size }, "speaker-form-photo:uploaded");
      return NextResponse.json({ photo: url }, { status: 201 });
    });
  } catch (err) {
    apiLogger.error({ err }, "speaker-form-photo:failed");
    return NextResponse.json({ error: "Failed to upload photo" }, { status: 500 });
  }
}
