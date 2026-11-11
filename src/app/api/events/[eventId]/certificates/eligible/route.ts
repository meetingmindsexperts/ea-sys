/**
 * GET /api/events/[eventId]/certificates/eligible?templateIds=a,b,c
 *
 * The Issue tab's preview: who a manual Issue run of these templates (1..3)
 * would send to. Each template's pool is the people ASSIGNED it
 * (src/lib/certificates/assignments.ts) who do not hold its certificate yet,
 * merged per PERSON. Returns { peopleCount, perTemplate, sample, truncated }.
 *
 * `?templateId=x` is accepted as one template (the pre-bundle spelling).
 * `?tag=` is refused: tags stopped deciding recipients on Nov 11, 2026, and a
 * page still sending one is showing a stale picker.
 *
 * No check-in / payment / session-role / poster gate.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { requirePermission } from "@/lib/permissions/require-permission";
import { apiLogger } from "@/lib/logger";
import { eligibleForTemplates } from "@/lib/certificates/eligibility";

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
    const gate = requirePermission(session, "certificates.read", { route: "events/[eventId]/certificates/eligible:GET", eventId });
    if (!gate.ok) return gate.response;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-eligible:no-org", userId: session.user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const orgId = session.user.organizationId; // tenancy: session org

    const url = new URL(req.url);
    if (url.searchParams.get("tag")) {
      apiLogger.warn({ msg: "cert-eligible:tag-refused", eventId, userId: session.user.id });
      return NextResponse.json(
        {
          error: "Tags no longer decide who receives a certificate. Reload the page and assign the certificate to people instead.",
          code: "TAGS_RETIRED",
        },
        { status: 400 },
      );
    }
    const templateIds = (url.searchParams.get("templateIds") ?? url.searchParams.get("templateId") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);
    if (templateIds.length === 0) {
      apiLogger.warn({ msg: "cert-eligible:missing-template-id", eventId, userId: session.user.id });
      return NextResponse.json(
        { error: "templateIds must contain at least one id", code: "MISSING_TEMPLATE_ID" },
        { status: 400 },
      );
    }

    // tenancy: swept CertificateTemplate read runs inside the session org.
    const templates = await runWithTenant(orgId, () =>
      db.certificateTemplate.findMany({
        where: {
          id: { in: templateIds },
          eventId,
          event: gate.eventWhere,
        },
        select: { id: true, name: true, category: true },
      }),
    );
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
    // tenancy: eligibility reads swept cert tables, run inside the session org.
    const merged = await runWithTenant(orgId, () => eligibleForTemplates(eventId, templates));
    return NextResponse.json({
      peopleCount: merged.people.length,
      perTemplate: merged.perTemplate,
      sample: merged.people.slice(0, SAMPLE_CAP),
      sampleCap: SAMPLE_CAP,
      truncated: merged.people.length > SAMPLE_CAP,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-eligible:failed" });
    return NextResponse.json({ error: "Failed to compute eligibility" }, { status: 500 });
  }
}
