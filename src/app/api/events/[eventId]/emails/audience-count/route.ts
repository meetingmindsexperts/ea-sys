/**
 * How many emails a bulk send would produce, computed by the SAME resolver the
 * send uses (review HIGH 1, Sep 9, 2026).
 *
 *   GET /api/events/[eventId]/emails/audience-count
 *       ?recipientType=abstracts&emailType=abstract-reminder[&status=][&recipientIds=a,b]
 *
 * Abstracts only for now: the dialog's own count works from rows the page holds,
 * and the abstracts list hides DRAFTs from staff by design, so a Submission
 * Reminder (which mails exactly draft authors) counted "0" while the server
 * mailed every draft. Registrations and speakers keep their client-side counts,
 * which see every row they need.
 *
 * ACCESS: the enqueue route's boundary (denyReviewer + WEBINAR_STAFF_ALLOW,
 * event through buildEventAccessWhere). A contradiction between the type and
 * the status is the precheck's 400 INVALID_FILTER, so the count can never say
 * a number the send would then refuse.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { BulkEmailError, countAbstractEmailRecipients } from "@/lib/bulk-email";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const MAX_RECIPIENT_IDS = 500;

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/emails/audience-count:GET" });
    if ("error" in orgGuard) return orgGuard.error;
    const denied = denyReviewer(session, {
      allow: WEBINAR_STAFF_ALLOW,
      route: "events/[eventId]/emails/audience-count:GET",
    });
    if (denied) return denied;

    const url = new URL(req.url);
    const recipientType = url.searchParams.get("recipientType") ?? "";
    const emailType = url.searchParams.get("emailType") ?? "";
    const status = url.searchParams.get("status") ?? undefined;
    const recipientIds = (url.searchParams.get("recipientIds") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_RECIPIENT_IDS);

    if (recipientType !== "abstracts" || !emailType) {
      apiLogger.warn({ eventId, recipientType, emailType, userId: session.user.id }, "audience-count:unsupported");
      return NextResponse.json(
        { error: "Only the abstracts audience is counted server-side.", code: "UNSUPPORTED" },
        { status: 400 },
      );
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "audience-count:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
      try {
        const count = await countAbstractEmailRecipients({
          eventId,
          emailType,
          status,
          recipientIds: recipientIds.length ? recipientIds : undefined,
        });
        return NextResponse.json({ count });
      } catch (err) {
        if (err instanceof BulkEmailError) {
          apiLogger.warn(
            { eventId, emailType, status, code: err.code, error: err.message },
            "audience-count:invalid-filter",
          );
          return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
        }
        throw err;
      }
    });
  } catch (err) {
    apiLogger.error({ err }, "audience-count:failed");
    return NextResponse.json({ error: "Failed to count recipients" }, { status: 500 });
  }
}
