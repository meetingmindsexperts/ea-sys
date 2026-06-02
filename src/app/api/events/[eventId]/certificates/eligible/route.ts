/**
 * GET /api/events/[eventId]/certificates/eligible?type=ATTENDANCE|APPRECIATION
 *                                                 [&templateId=...]
 *
 * Returns the eligible recipient list + exclusion reasons. Read-only.
 *
 * Eligibility is category-scoped (one cert per recipient per category)
 * so the answer doesn't change between two templates of the same
 * category — the operator sees the same eligible pool whether they
 * picked "Standard Attendance" or "VIP Attendance" first. templateId
 * is accepted as a convenience: if provided, the route looks up the
 * template's category and runs the eligibility query against that.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { eligibleForType } from "@/lib/certificates/eligibility";
import type { CertificateType } from "@prisma/client";

const VALID: CertificateType[] = ["ATTENDANCE", "APPRECIATION"];

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-eligible:no-org", userId: session.user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(req.url);
    const typeRaw = url.searchParams.get("type");
    const templateId = url.searchParams.get("templateId");

    // Resolve category — from templateId if provided (one DB lookup
    // that doubles as the org-bound check on both event + template),
    // otherwise from the type param.
    let type: CertificateType;
    if (templateId) {
      const tmpl = await db.certificateTemplate.findFirst({
        where: {
          id: templateId,
          event: { organizationId: session.user.organizationId },
        },
        select: { eventId: true, category: true },
      });
      if (!tmpl || tmpl.eventId !== eventId) {
        apiLogger.warn({
          msg: "cert-eligible:template-not-found",
          eventId,
          userId: session.user.id,
          templateId,
        });
        return NextResponse.json({ error: "Template not found" }, { status: 404 });
      }
      type = tmpl.category;
    } else {
      if (!typeRaw || !VALID.includes(typeRaw as CertificateType)) {
        apiLogger.warn({
          msg: "cert-eligible:invalid-type",
          eventId,
          userId: session.user.id,
          typeRaw,
        });
        return NextResponse.json(
          {
            error: `Provide either templateId or type. Type must be one of: ${VALID.join(", ")}`,
            code: "INVALID_TYPE",
          },
          { status: 400 },
        );
      }
      type = typeRaw as CertificateType;

      const event = await db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId },
        select: { id: true },
      });
      if (!event) {
        apiLogger.warn({
          msg: "cert-eligible:event-not-found",
          eventId,
          userId: session.user.id,
        });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
    }

    const result = await eligibleForType(type, eventId);
    // Response cap exists to keep the JSON small on huge events (5000+
    // attendees). The Issue POST route accepts up to 10000 recipientIds
    // (subset narrowing) so this 100-row preview is intentionally a UI
    // sample, not a bulk-select surface. If the UI needs to render the
    // full list for selection it should paginate / virtualize via a
    // separate endpoint — flagged for v1.1.
    const SAMPLE_CAP = 100;
    return NextResponse.json({
      type: result.type,
      eligibleCount: result.eligible.length,
      eligible: result.eligible.slice(0, SAMPLE_CAP),
      sampleCap: SAMPLE_CAP,
      truncated: result.eligible.length > SAMPLE_CAP,
      exclusions: result.exclusions,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-eligible:failed" });
    return NextResponse.json({ error: "Failed to compute eligibility" }, { status: 500 });
  }
}
