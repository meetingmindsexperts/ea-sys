/**
 * GET /api/events/[eventId]/certificates/eligible
 *
 * Two modes:
 *
 *   ?templateIds=a,b,c   (bundle model, 2026-07-09) — per-template pools come
 *     from each template's STORED tag, merged per PERSON. Returns
 *     { people, peopleCount, perTemplate, sample, truncated }. The Issue tab
 *     multi-select preview.
 *
 *   ?templateId={id}[&tag={tag}]   (legacy single-template) —
 *     - templateId only: the available-tag overview for the template's
 *       category pool (tag picker).
 *     - templateId + tag: also the filtered recipient list preview.
 *
 * Eligibility = category pool (ATTENDANCE → registrations; APPRECIATION
 * → speakers) MINUS recipients already holding a cert from that template.
 * No check-in / payment / session-role / poster gate.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { eligibleForType, eligibleForTemplates } from "@/lib/certificates/eligibility";

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
    const templateIdsParam = url.searchParams.get("templateIds");

    // ── Bundle mode: merged multi-template preview ──
    if (templateIdsParam) {
      const templateIds = templateIdsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3);
      if (templateIds.length === 0) {
        apiLogger.warn({ msg: "cert-eligible:empty-template-ids", eventId, userId: session.user.id });
        return NextResponse.json(
          { error: "templateIds must contain at least one id", code: "MISSING_TEMPLATE_ID" },
          { status: 400 },
        );
      }
      const templates = await db.certificateTemplate.findMany({
        where: {
          id: { in: templateIds },
          eventId,
          event: { organizationId: session.user.organizationId },
        },
        select: { id: true, name: true, category: true, autoIssueTag: true },
      });
      if (templates.length !== new Set(templateIds).size) {
        apiLogger.warn({
          msg: "cert-eligible:template-not-found",
          eventId,
          userId: session.user.id,
          templateIds,
          foundCount: templates.length,
        });
        return NextResponse.json({ error: "Template not found" }, { status: 404 });
      }
      const merged = await eligibleForTemplates(eventId, templates);
      return NextResponse.json({
        peopleCount: merged.people.length,
        perTemplate: merged.perTemplate,
        sample: merged.people.slice(0, SAMPLE_CAP),
        sampleCap: SAMPLE_CAP,
        truncated: merged.people.length > SAMPLE_CAP,
      });
    }

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

    const result = await eligibleForType(tmpl.category, eventId, tag, templateId);

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
