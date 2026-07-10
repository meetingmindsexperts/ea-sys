/**
 * GET /api/email-logs/[emailLogId]/body
 *   → 200 { subject, to, createdAt, htmlBody }
 *
 * The stored audit copy of a sent email's final rendered HTML — populated
 * only for opt-in senders (certificate deliveries; EmailLogContext.storeBody).
 * Backs the "View email" action on the activity timeline.
 *
 * Auth: session + denyReviewer (same policy as the email-logs list route).
 * Org-scoped: the row's organizationId must match the caller's — rows
 * written without an org (some legacy transactional senders) are NOT
 * exposed here, which is fine: every body-storing sender stamps the org.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";

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

    const row = await db.emailLog.findFirst({
      where: { id: emailLogId, organizationId: session.user.organizationId },
      select: { subject: true, to: true, createdAt: true, htmlBody: true },
    });
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
