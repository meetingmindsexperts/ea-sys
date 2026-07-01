import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import {
  applyPromoCodeToRegistration,
  removePromoCodeFromRegistration,
  type ApplyPromoErrorCode,
} from "@/services/promo-code-service";

/**
 * Registrant self-service apply / remove of a promo code on their OWN
 * registration — the "chose pay-later, came back with a code" flow in
 * /my-registration. Ownership = own the registration (userId) OR share the
 * attendee email (same rule as the registrant GET + resend-confirmation), so
 * orphan rows still work. Same promo rules as everywhere else.
 */

const bodySchema = z.object({ code: z.string().min(1).max(50) });

interface RouteParams {
  params: Promise<{ registrationId: string }>;
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

/** Resolve + ownership-check the registration; returns its eventId. */
async function ownedRegistration(registrationId: string, userId: string, email: string) {
  return db.registration.findFirst({
    where: {
      id: registrationId,
      OR: [{ userId }, { attendee: { email } }],
    },
    select: { id: true, eventId: true },
  });
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { registrationId }] = await Promise.all([auth(), params]);
    if (!session?.user?.id || !session.user.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rl = checkRateLimit({ key: `registrant-promo:${session.user.id}`, limit: 20, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "registrant/promo:rate-limited", retryAfterSeconds: rl.retryAfterSeconds });
      return NextResponse.json(
        { error: "Too many attempts. Please wait a moment before trying another code." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const reg = await ownedRegistration(registrationId, session.user.id, session.user.email.toLowerCase());
    if (!reg) return NextResponse.json({ error: "Registration not found" }, { status: 404 });

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      apiLogger.warn({ msg: "registrant/promo:invalid-input", registrationId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Please enter a promo code", details: parsed.error.flatten() }, { status: 400 });
    }

    const result = await applyPromoCodeToRegistration({
      registrationId,
      eventId: reg.eventId,
      code: parsed.data.code,
      source: "registrant",
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.message, code: result.code }, { status: statusFor(result.code) });
    }

    apiLogger.info({ msg: "registrant/promo:applied", registrationId, userId: session.user.id, ip: getClientIp(req) });
    return NextResponse.json({ success: true, ...result.financials, replaced: result.replaced });
  } catch (error) {
    apiLogger.error({ err: error, msg: "registrant/promo:apply-failed" });
    return NextResponse.json({ error: "Failed to apply promo code" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [session, { registrationId }] = await Promise.all([auth(), params]);
    if (!session?.user?.id || !session.user.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const reg = await ownedRegistration(registrationId, session.user.id, session.user.email.toLowerCase());
    if (!reg) return NextResponse.json({ error: "Registration not found" }, { status: 404 });

    const result = await removePromoCodeFromRegistration({ registrationId, eventId: reg.eventId, source: "registrant" });
    if (!result.ok) {
      const status = result.code === "REGISTRATION_NOT_FOUND" ? 404 : result.code === "ALREADY_SETTLED" ? 400 : 500;
      return NextResponse.json({ error: result.message, code: result.code }, { status });
    }

    apiLogger.info({ msg: "registrant/promo:removed", registrationId, userId: session.user.id, removed: result.removed });
    return NextResponse.json({ success: true, removed: result.removed });
  } catch (error) {
    apiLogger.error({ err: error, msg: "registrant/promo:remove-failed" });
    return NextResponse.json({ error: "Failed to remove promo code" }, { status: 500 });
  }
}
