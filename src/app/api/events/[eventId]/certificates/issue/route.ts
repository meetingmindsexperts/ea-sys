/**
 * POST /api/events/[eventId]/certificates/issue
 *   body: { type: CertificateType }
 *   → 201 { runId, totalCount, status }
 *
 * Creates a new CertificateIssueRun for the given cert type.
 *
 * Guards:
 *   - Design-approval flag must be set on the event (cert design has
 *     been signed off by SUPER_ADMIN). Otherwise 403.
 *   - For CME: cmeHours + at least one accreditation must be set.
 *   - Only one non-terminal run per (event, type) — concurrent click
 *     returns 409 with the existing runId so the UI can navigate to it.
 *
 * Side effects:
 *   - INSERT CertificateIssueRun (status=PENDING)
 *   - INSERT CertificateIssueRunItem for each eligible recipient
 *   - Audit log row (source: "dashboard"/"mcp" depending on caller)
 *
 * The cron worker (every minute via /api/cron/certificate-issues) picks
 * the new run up next tick and starts the RENDERING phase.
 */

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { eligibleForType } from "@/lib/certificates/eligibility";
import type { CertificateType } from "@prisma/client";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const bodySchema = z.object({
  type: z.enum(["ATTENDANCE", "PRESENTER", "POSTER", "CME"]),
});

export async function POST(req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  try {
    const [session, p, rawBody] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => ({})),
    ]);
    eventId = p.eventId;
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      apiLogger.warn({
        msg: "cert-issue:validation-failed",
        eventId,
        errors: parsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const type = parsed.data.type as CertificateType;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId },
      select: { id: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Design-approval gate — same flag the dashboard's Design approval
    // card writes. Without sign-off, the Issue button must not work.
    const cmeSettings = readCmeSettings(event.settings);
    if (!cmeSettings.designApprovedBy) {
      return NextResponse.json(
        {
          error: "Certificate design hasn't been approved yet. A SUPER_ADMIN must approve the design before issuing.",
          code: "DESIGN_NOT_APPROVED",
        },
        { status: 403 },
      );
    }

    // Concurrent-run guard — only one non-terminal run per (event, type).
    // Returns 409 with the existing runId so the UI can show it.
    const existing = await db.certificateIssueRun.findFirst({
      where: {
        eventId,
        type,
        status: { in: ["PENDING", "RENDERING", "AWAITING_REVIEW", "SENDING"] },
      },
      select: { id: true, status: true },
    });
    if (existing) {
      return NextResponse.json(
        {
          error: `A ${type} issue run is already in progress (status: ${existing.status}). Wait for it to complete or cancel it first.`,
          code: "RUN_IN_PROGRESS",
          runId: existing.id,
        },
        { status: 409 },
      );
    }

    // Eligibility query — returns full recipient list + any blocking
    // exclusions (e.g. "CME hours not set"). If exclusions block the
    // whole list (eligible.length === 0 due to event-level blockers),
    // we surface that as a 422 instead of inserting a zero-item run.
    const elig = await eligibleForType(type, eventId);
    if (elig.eligible.length === 0) {
      return NextResponse.json(
        {
          error: elig.exclusions.length > 0
            ? `No eligible recipients. Reasons: ${elig.exclusions.map((e) => e.reason).join("; ")}`
            : "No eligible recipients for this cert type.",
          code: "NO_ELIGIBLE_RECIPIENTS",
          exclusions: elig.exclusions,
        },
        { status: 422 },
      );
    }

    // Create the run + items in one transaction. Items carry the
    // snapshot of recipient name + email so the UI list is stable even
    // if the underlying Registration/Speaker is later modified.
    const eventIdLocked = eventId;  // narrow undefined-able for the transaction closure
    const run = await db.$transaction(async (tx) => {
      const created = await tx.certificateIssueRun.create({
        data: {
          eventId: eventIdLocked,
          type,
          status: "PENDING",
          totalCount: elig.eligible.length,
          triggeredByUserId: session.user.id,
        },
        select: { id: true },
      });
      await tx.certificateIssueRunItem.createMany({
        data: elig.eligible.map((r) => ({
          runId: created.id,
          registrationId: r.registrationId,
          speakerId: r.speakerId,
          recipientName: r.recipientName,
          recipientEmail: r.recipientEmail,
        })),
      });
      return created;
    });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "CREATE",
          entityType: "CertificateIssueRun",
          entityId: run.id,
          changes: {
            type,
            totalCount: elig.eligible.length,
            source: "dashboard",
          },
        },
      })
      .catch((err) => apiLogger.warn({ err, msg: "cert-issue:audit-failed", eventId, runId: run.id }));

    apiLogger.info({
      msg: "cert-issue:run-created",
      eventId,
      runId: run.id,
      type,
      totalCount: elig.eligible.length,
      userId: session.user.id,
    });

    return NextResponse.json(
      {
        runId: run.id,
        totalCount: elig.eligible.length,
        status: "PENDING",
        nextStep: "Cron worker picks up PENDING runs within 60 seconds. Poll GET /runs/{runId} for status.",
      },
      { status: 201 },
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-issue:failed", eventId });
    return NextResponse.json({ error: "Failed to start certificate issue run" }, { status: 500 });
  }
}

function readCmeSettings(raw: Prisma.JsonValue): { designApprovedBy?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, Prisma.JsonValue>;
  const cme = obj.cme;
  if (!cme || typeof cme !== "object" || Array.isArray(cme)) return {};
  return cme as { designApprovedBy?: string };
}
