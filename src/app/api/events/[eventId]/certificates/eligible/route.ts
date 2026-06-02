/**
 * GET /api/events/[eventId]/certificates/eligible?templateId={id}[&tag={tag}]
 *
 * Tag-driven manual selection (2026-06-02 evening).
 *
 *   - With templateId only: returns the available-tag overview for the
 *     template's category pool (each tag + count of people carrying it,
 *     plus untaggedCount). The UI uses this to populate the tag picker.
 *
 *   - With templateId + tag: ALSO returns the filtered recipient list
 *     (first SAMPLE_CAP rows shown as a preview before the operator
 *     clicks Issue).
 *
 * Either way the response carries `availableTags` so the UI can keep
 * the picker populated as the operator switches tags.
 *
 * Eligibility = category pool (ATTENDANCE → registrations; APPRECIATION
 * → speakers) MINUS recipients already holding a cert of this category.
 * No check-in / payment / session-role / poster gate.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { eligibleForType } from "@/lib/certificates/eligibility";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const SAMPLE_CAP = 100;

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
    const templateId = url.searchParams.get("templateId");
    const tag = url.searchParams.get("tag");

    if (!templateId) {
      apiLogger.warn({
        msg: "cert-eligible:missing-template-id",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "templateId query parameter is required", code: "MISSING_TEMPLATE_ID" },
        { status: 400 },
      );
    }

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

    const result = await eligibleForType(tmpl.category, eventId, tag);

    return NextResponse.json({
      type: result.type,
      tag: result.tag,
      availableTags: result.availableTags,
      untaggedCount: result.untaggedCount,
      // When tag isn't supplied, the recipient list is intentionally
      // empty — the UI uses availableTags to drive the picker first.
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
