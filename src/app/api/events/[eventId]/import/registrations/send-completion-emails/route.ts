import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { DEFAULT_LINK_EXPIRY_DAYS, linkExpiryDaysSchema } from "@/lib/link-expiry";
import { sendRegistrationForms, type PrepareRegistrationFormsErrorCode } from "@/services/registration-form-service";

/**
 * Send Registration Form: each person's own link to complete their
 * registration, at the rate chosen in the dialog, valid for the chosen number
 * of days (docs/REGISTRATION_FORM_LINKS_PLAN.md). The rules live in
 * registration-form-service; this route is auth, the limit and HTTP.
 */
const bodySchema = z.object({
  registrationIds: z.array(z.string().min(1)).min(1).max(500),
  /** A rate-name slug (`early-bird`) or "complimentary". Omitted by a page
   *  loaded before rates were chosen here: then Complimentary is NOT assumed;
   *  the request is refused so nobody is stamped by accident. */
  rate: z.string().trim().min(1).max(100),
  sponsorId: z.string().min(1).optional(),
  expiryDays: linkExpiryDaysSchema("Registration link").optional(),
});

const ERROR_STATUS: Record<PrepareRegistrationFormsErrorCode | "TEMPLATE_MISSING", number> = {
  EVENT_NOT_FOUND: 404,
  RATE_NOT_FOUND: 400,
  RATE_NOT_ALLOWED: 400,
  SPONSOR_NOT_FOUND: 400,
  TEMPLATE_MISSING: 500,
};

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/import/registrations/send-completion-emails:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "registrations.import", { route: "events/[eventId]/import/registrations/send-completion-emails:POST", eventId });
    if (!gate.ok) return gate.response;

    return await runWithTenant(orgGuard.orgId, async () => {
    const rateLimit = checkRateLimit({
      key: `send-completion-emails:org:${session.user.organizationId}`,
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
      apiLogger.warn({ msg: "events/import-registrations-send-completion-emails:rate-limited", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return NextResponse.json(
        { error: "Rate limit reached. Maximum 5 bulk sends per hour." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
      );
    }

    const body = await req.json();
    const validated = bodySchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "Send completion emails validation failed", errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    const { registrationIds, rate, sponsorId, expiryDays } = validated.data;
    // The grant's own event scope (custom roles): an event outside it is a
    // 404 here, before the service, which scopes by organisation only.
    const [event, signer] = await Promise.all([
      db.event.findFirst({ where: gate.eventWhere, select: { id: true } }),
      db.user.findUnique({ where: { id: session.user.id }, select: { emailSignature: true } }),
    ]);
    if (!event) {
      apiLogger.warn({ msg: "send-registration-forms:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const result = await sendRegistrationForms({
      eventId,
      organizationId: orgGuard.orgId,
      registrationIds,
      rate: rate === "complimentary" ? { kind: "complimentary" } : { kind: "rate", slug: rate },
      sponsorId: sponsorId ?? null,
      expiryDays: expiryDays ?? DEFAULT_LINK_EXPIRY_DAYS,
      actorUserId: session.user.id,
      source: "rest",
      appUrl: process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000",
      organizerName: [session.user.firstName, session.user.lastName].filter(Boolean).join(" "),
      organizerSignature: signer?.emailSignature ?? "",
    });
    if (!result.ok) {
      apiLogger.warn({ msg: "send-registration-forms:refused", eventId, code: result.code });
      return NextResponse.json({ error: result.message, code: result.code }, { status: ERROR_STATUS[result.code] });
    }

    if (result.sent === 0 && result.skipped.length > 0 && result.skipped.every((x) => x.reason === "NOT_FOUND")) {
      apiLogger.warn({ msg: "send-registration-forms:no-registrations-found", eventId, requested: registrationIds.length });
      return NextResponse.json({ error: "No registrations found for the provided IDs" }, { status: 404 });
    }

    return NextResponse.json({
      sent: result.sent,
      skipped: result.skipped.length,
      skippedDetails: result.skipped,
      errors: result.errors,
      rateName: result.rateName,
      rateClosesAt: result.rateClosesAt,
    });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Unhandled error in send-completion-emails endpoint" });
    return NextResponse.json({ error: "An unexpected error occurred while sending completion emails. Please try again." }, { status: 500 });
  }
}
