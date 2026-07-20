import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import {
  applyPromoCodeToRegistration,
  removePromoCodeFromRegistration,
  type ApplyPromoErrorCode,
} from "@/services/promo-code-service";

/**
 * Public (no-auth) apply / remove of a promo code on an existing unpaid
 * registration — the "organizer emailed a code after registration" flow on
 * the post-registration confirmation page (/e/[slug]/confirmation?id=…).
 *
 * Security posture (same class as the sibling /document route, which serves
 * the quote PDF for the same id):
 *   - Registration CUIDs are unguessable; slug + id must match so a known id
 *     can't be replayed against another event.
 *   - All promo rules are enforced by the shared promo-code-service (unpaid
 *     registrations only, code active + in its date window + applicable to
 *     the registration type + usage caps, replace-not-stack) — this route
 *     adds no bypasses; the mutation can only lower the holder's own price
 *     with a code the organizer issued.
 *   - Per-IP rate limit (below) keeps code guessing impractical on top of
 *     the codes' own per-email/usage caps.
 */

const bodySchema = z.object({ code: z.string().min(1).max(50) });

interface RouteParams {
  params: Promise<{ slug: string; registrationId: string }>;
}

function statusFor(code: ApplyPromoErrorCode): number {
  switch (code) {
    case "REGISTRATION_NOT_FOUND":
      return 404;
    case "ALREADY_SETTLED":
    case "FREE_REGISTRATION":
    case "INVALID_CODE":
    case "NOT_APPLICABLE":
    case "EXHAUSTED":
    case "EMAIL_LIMIT":
      return 400;
    default:
      return 500;
  }
}

/** Resolve the registration bound to the event slug (never by id alone). */
async function slugBoundRegistration(slug: string, registrationId: string) {
  return db.registration.findFirst({
    where: { id: registrationId, event: { slug } },
    select: { id: true, eventId: true },
  });
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug, registrationId } = await params;

    const rl = checkRateLimit({
      key: `public-promo:${getClientIp(req)}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "public/promo:rate-limited", slug, retryAfterSeconds: rl.retryAfterSeconds });
      return NextResponse.json(
        { error: "Too many attempts. Please wait a moment before trying another code." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const reg = await slugBoundRegistration(slug, registrationId);
    if (!reg) {
      apiLogger.warn({ msg: "public/promo:registration-not-found", slug, registrationId });
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      apiLogger.warn({ msg: "public/promo:invalid-input", registrationId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Please enter a promo code", details: parsed.error.flatten() }, { status: 400 });
    }

    const result = await applyPromoCodeToRegistration({
      registrationId,
      eventId: reg.eventId,
      code: parsed.data.code,
      source: "public",
    });

    if (!result.ok) {
      apiLogger.warn({ msg: "public/promo:apply-rejected", registrationId, code: result.code, ip: getClientIp(req) });
      return NextResponse.json({ error: result.message, code: result.code }, { status: statusFor(result.code) });
    }

    apiLogger.info({ msg: "public/promo:applied", registrationId, slug, ip: getClientIp(req) });
    return NextResponse.json({ success: true, ...result.financials, replaced: result.replaced });
  } catch (error) {
    apiLogger.error({ err: error, msg: "public/promo:apply-failed" });
    return NextResponse.json({ error: "Failed to apply promo code" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { slug, registrationId } = await params;

    const rl = checkRateLimit({
      key: `public-promo:${getClientIp(req)}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "public/promo:rate-limited", slug, retryAfterSeconds: rl.retryAfterSeconds });
      return NextResponse.json(
        { error: "Too many attempts. Please try again later." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const reg = await slugBoundRegistration(slug, registrationId);
    if (!reg) {
      apiLogger.warn({ msg: "public/promo:registration-not-found", slug, registrationId });
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const result = await removePromoCodeFromRegistration({ registrationId, eventId: reg.eventId, source: "public" });
    if (!result.ok) {
      apiLogger.warn({ msg: "public/promo:remove-rejected", registrationId, code: result.code });
      const status = result.code === "REGISTRATION_NOT_FOUND" ? 404 : result.code === "ALREADY_SETTLED" ? 400 : 500;
      return NextResponse.json({ error: result.message, code: result.code }, { status });
    }

    apiLogger.info({ msg: "public/promo:removed", registrationId, slug, removed: result.removed, ip: getClientIp(req) });
    return NextResponse.json({ success: true, removed: result.removed });
  } catch (error) {
    apiLogger.error({ err: error, msg: "public/promo:remove-failed" });
    return NextResponse.json({ error: "Failed to remove promo code" }, { status: 500 });
  }
}
