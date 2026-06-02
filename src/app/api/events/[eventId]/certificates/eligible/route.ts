/**
 * GET /api/events/[eventId]/certificates/eligible?type=ATTENDANCE|PRESENTER|POSTER|CME
 *
 * Returns the eligible recipient list + exclusion reasons (the operator
 * UI shows the count + a few sample names + any "missing CME hours"
 * banners). Read-only.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { eligibleForType } from "@/lib/certificates/eligibility";
import type { CertificateType } from "@prisma/client";

const VALID: CertificateType[] = ["ATTENDANCE", "PRESENTER", "POSTER", "CME"];

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
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(req.url);
    const typeRaw = url.searchParams.get("type");
    if (!typeRaw || !VALID.includes(typeRaw as CertificateType)) {
      return NextResponse.json(
        { error: `Invalid type. Must be one of: ${VALID.join(", ")}`, code: "INVALID_TYPE" },
        { status: 400 },
      );
    }
    const type = typeRaw as CertificateType;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const result = await eligibleForType(type, eventId);
    return NextResponse.json({
      type: result.type,
      eligibleCount: result.eligible.length,
      eligible: result.eligible.slice(0, 100), // cap response size; full list goes via the issue POST
      exclusions: result.exclusions,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-eligible:failed" });
    return NextResponse.json({ error: "Failed to compute eligibility" }, { status: 500 });
  }
}
