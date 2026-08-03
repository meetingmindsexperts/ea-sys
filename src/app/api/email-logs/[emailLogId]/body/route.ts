/**
 * GET /api/email-logs/[emailLogId]/body
 *   → 200 { subject, to, createdAt, htmlBody }
 *
 * The stored audit copy of a sent email's final rendered HTML — populated
 * only for opt-in senders (certificate deliveries; EmailLogContext.storeBody).
 * Backs the "View email" action on the activity timeline.
 *
 * Auth: session + denyReviewer (same policy as the email-logs list route).
 * Org-scoped with the null-org fallback (Aug 3, 2026): some automated
 * senders (webinar confirmation, payment reminders) historically wrote
 * org-NULL rows — the LIST surfaces (entity Email History, the event
 * Email Activity table) showed them via their own entity/event ownership
 * checks, but this route's strict org match then 404'd the View button
 * ("Email not found"). A null-org row is now readable IFF its event
 * belongs to the caller's org (ownership by construction — same reasoning
 * as getEmailLogsFor's fallback). Null-org rows with NO event stay hidden
 * (fail closed). New rows are org-stamped at the executeBulkEmail choke
 * point, so the fallback only carries the historical rows.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";

interface RouteParams {
  params: Promise<{ emailLogId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  let emailLogId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    emailLogId = p.emailLogId;
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "email-log-body:no-org", userId: session.user.id, emailLogId });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // Captured as a const so the narrowing survives into the closure below
    // (the Contacts-pilot TS gotcha).
    const orgId = session.user.organizationId;

    // Tenancy (Domain #18): swept EmailLog read rides the caller's org lane.
    // The OR-null branch stays for master's historical rows; under platform
    // RLS it simply never matches (USING hides null-org rows) — and the
    // Domain #18 backfill stamps every event-derivable row anyway.
    const row = await runWithTenant(orgId, () =>
      db.emailLog.findFirst({
        where: {
          id: emailLogId,
          OR: [
            { organizationId: orgId },
            // Historical null-org rows: readable only when the row's event
            // provably belongs to the caller's org. A null-org row with no
            // event never matches (fail closed).
            { organizationId: null, event: { organizationId: orgId } },
          ],
        },
        select: { subject: true, to: true, createdAt: true, htmlBody: true },
      }),
    );
    if (!row) {
      apiLogger.warn({ msg: "email-log-body:not-found", emailLogId, userId: session.user.id });
      return NextResponse.json({ error: "Email not found" }, { status: 404 });
    }
    if (!row.htmlBody) {
      apiLogger.warn({ msg: "email-log-body:no-stored-body", emailLogId, userId: session.user.id });
      return NextResponse.json(
        { error: "No stored copy for this email — bodies are kept for certificate deliveries sent after July 10, 2026.", code: "NO_STORED_BODY" },
        { status: 404 },
      );
    }
    return NextResponse.json({
      subject: row.subject,
      to: row.to,
      createdAt: row.createdAt,
      htmlBody: row.htmlBody,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "email-log-body:failed", emailLogId });
    return NextResponse.json({ error: "Failed to load the email body" }, { status: 500 });
  }
}
