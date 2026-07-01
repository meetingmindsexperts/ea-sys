import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, denyFinance } from "@/lib/auth-guards";
import { checkRateLimit, getClientIp } from "@/lib/security";
import {
  applyPromoCodeToRegistration,
  removePromoCodeFromRegistration,
  type ApplyPromoErrorCode,
} from "@/services/promo-code-service";

/**
 * Organizer-facing apply / remove of a promo code against an existing
 * registration. Discount is stored on the registration (discountAmount +
 * promoCodeId); the pay-later checkout, quote PDF, and invoice already read it.
 *
 * Finance action → denyReviewer (blocks REVIEWER/SUBMITTER/REGISTRANT/MEMBER
 * write) + denyFinance (blocks MEMBER money visibility). Same promo rules as the
 * public/registrant path — organizers do NOT bypass a promo's own limits.
 */

const bodySchema = z.object({ code: z.string().min(1).max(50) });

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

/** Map a service error code to an HTTP status. */
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

async function authorize(eventId: string) {
  const session = await auth();
  if (!session?.user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const denied = denyReviewer(session);
  if (denied) return { error: denied };
  const financeDenied = denyFinance(session);
  if (financeDenied) return { error: financeDenied };

  const event = await db.event.findFirst({
    where: { id: eventId, organizationId: session.user.organizationId! },
    select: { id: true },
  });
  if (!event) return { error: NextResponse.json({ error: "Event not found" }, { status: 404 }) };

  return { session };
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { eventId, registrationId } = await params;
    const authd = await authorize(eventId);
    if (authd.error) return authd.error;

    const rl = checkRateLimit({ key: `promo-apply:${authd.session.user.id}`, limit: 60, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "events/registrations/promo:rate-limited", retryAfterSeconds: rl.retryAfterSeconds });
      return NextResponse.json(
        { error: "Too many attempts. Please wait a moment." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      apiLogger.warn({ msg: "events/registrations/promo:invalid-input", eventId, registrationId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "A promo code is required", details: parsed.error.flatten() }, { status: 400 });
    }

    const result = await applyPromoCodeToRegistration({
      registrationId,
      eventId,
      code: parsed.data.code,
      source: "rest",
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.message, code: result.code }, { status: statusFor(result.code) });
    }

    apiLogger.info({ msg: "events/registrations/promo:applied", eventId, registrationId, ip: getClientIp(req) });
    return NextResponse.json({ success: true, ...result.financials, replaced: result.replaced });
  } catch (error) {
    apiLogger.error({ err: error, msg: "events/registrations/promo:apply-failed" });
    return NextResponse.json({ error: "Failed to apply promo code" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { eventId, registrationId } = await params;
    const authd = await authorize(eventId);
    if (authd.error) return authd.error;

    const result = await removePromoCodeFromRegistration({ registrationId, eventId, source: "rest" });
    if (!result.ok) {
      const status = result.code === "REGISTRATION_NOT_FOUND" ? 404 : result.code === "ALREADY_SETTLED" ? 400 : 500;
      return NextResponse.json({ error: result.message, code: result.code }, { status });
    }

    apiLogger.info({ msg: "events/registrations/promo:removed", eventId, registrationId, removed: result.removed, ip: getClientIp(req) });
    return NextResponse.json({ success: true, removed: result.removed });
  } catch (error) {
    apiLogger.error({ err: error, msg: "events/registrations/promo:remove-failed" });
    return NextResponse.json({ error: "Failed to remove promo code" }, { status: 500 });
  }
}
