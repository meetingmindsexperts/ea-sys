/**
 * The HTTP side of speaker presentations, shared by the two doors: the
 * staff's speaker page and the speaker's own form link (Nov 19, 2026;
 * docs/SPEAKER_PRESENTATIONS_PLAN.md). The rules are the service's; this is
 * only how its answers are spoken over HTTP, once.
 *
 * Server-only.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import type { DirectUploadTarget } from "@/lib/storage";
import type { StartUploadResult } from "@/services/speaker-presentation-service";

export const startPresentationUploadSchema = z.object({
  slotKey: z.string().min(1).max(80),
  filename: z.string().min(1).max(300),
  size: z.number().int().positive(),
});

/** Every refusal the service can give, and the status it travels under. */
export const PRESENTATION_STATUS: Record<string, number> = {
  UPLOADS_UNAVAILABLE: 503,
  TYPE_NOT_ALLOWED: 400,
  FILE_TOO_LARGE: 400,
  FILE_EMPTY: 400,
  INVALID_SLOT: 409,
  TOO_MANY_FILES: 409,
  QUOTA_EXCEEDED: 409,
  NOT_AVAILABLE: 404,
  NOT_FOUND: 404,
  UPLOAD_NOT_FOUND: 409,
  SIGNATURE_MISMATCH: 400,
};

export function presentationRefusal(result: { code: string; message: string }): NextResponse {
  return NextResponse.json({ error: result.message, code: result.code }, { status: PRESENTATION_STATUS[result.code] ?? 400 });
}

/**
 * What the browser needs to send the file: the signed form for the bucket,
 * or, on the local provider, this door's own file route.
 */
export function startUploadResponse(result: Extract<StartUploadResult, { ok: true }>, fileRouteFor: (presentationId: string) => string): NextResponse {
  const upload: DirectUploadTarget | { via: "app"; url: string } =
    result.upload.via === "s3" ? result.upload : { via: "app", url: fileRouteFor(result.presentationId) };
  return NextResponse.json({ presentationId: result.presentationId, upload, contentType: result.contentType, maxBytes: result.maxBytes }, { status: 201 });
}

/** The file from a multipart body (the local provider's upload), or null. */
export async function readUploadedFile(req: Request): Promise<Buffer | null> {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) return null;
  return Buffer.from(await file.arrayBuffer());
}

/**
 * The speaker's own door is public (a token in the link), so it is limited
 * per address and per token, as the form's other uploads are. Answers the
 * 429 itself, or null to carry on.
 */
export function speakerFormPresentationLimit(ip: string, token: string, slug: string): NextResponse | null {
  const ipLimit = checkRateLimit({ key: `speaker-form-presentation:${ip}`, limit: 240, windowMs: 3600_000 });
  const tokenLimit = checkRateLimit({ key: `speaker-form-presentation-token:${token.slice(0, 16)}`, limit: 120, windowMs: 3600_000 });
  if (ipLimit.allowed && tokenLimit.allowed) return null;
  const retryAfterSeconds = Math.max(ipLimit.retryAfterSeconds ?? 0, tokenLimit.retryAfterSeconds ?? 0);
  apiLogger.warn({ slug, ip, stage: "presentation" }, "speaker-form-presentation:rate-limited");
  return NextResponse.json(
    { error: "Too many requests. Try again later.", retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}
