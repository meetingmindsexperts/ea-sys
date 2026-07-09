/**
 * POST /api/events/[eventId]/certificates/issue
 *   body: { templateId: string, recipientIds?: { registrationIds?: string[];
 *                                                speakerIds?: string[] } }
 *   → 201 { runId, totalCount, status }
 *
 * Creates a new CertificateIssueRun bound to a specific template (v3
 * multi-template model, 2026-06-02). Eligibility derives from the
 * template's category — Attendance hits checked-in registrations,
 * Appreciation hits speakers + poster authors. Optional `recipientIds`
 * narrows to a subset within the eligible pool (operator-chosen).
 *
 * Guards:
 *   - Template must belong to the (org-bound) event.
 *   - For Appreciation referencing CME hours via template tokens — no
 *     gate; missing CME data renders as empty string per template.ts.
 *   - Only one non-terminal run per (event, category) — concurrent click
 *     returns 409 with the existing runId so the UI can navigate to it.
 *     Note: scoped to category, not template, because one cert per
 *     recipient per category is the eligibility invariant.
 *
 * Design-approval gate REMOVED on 2026-06-02. The PDF-overlay model
 * makes the design tangible (operator sees the canvas + Preview button)
 * so the dedicated SUPER_ADMIN sign-off step is no longer warranted.
 *
 * Side effects:
 *   - INSERT CertificateIssueRun (status=PENDING, certificateTemplateId set)
 *   - INSERT CertificateIssueRunItem for each eligible recipient
 *   - Audit log row (source: "dashboard"/"mcp" depending on caller)
 *
 * The cron worker (every minute via /api/cron/certificate-issues) picks
 * the new run up next tick and starts the RENDERING phase.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { eligibleForType } from "@/lib/certificates/eligibility";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const bodySchema = z.object({
  templateId: z.string().min(1),
  // Tag-driven manual selection (2026-06-02 evening). Required — the
  // organizer must pick a tag, and only people in the template's
  // category pool carrying that tag get certs. Length cap is generous
  // (matches the longest tag we've seen in prod + headroom).
  tag: z.string().min(1).max(100),
  // Cover-email content the operator confirmed at Issue time. Stored
  // as a snapshot on the run row so a later template edit doesn't
  // change emails for an in-flight run. Both required — the dialog
  // pre-fills from the template default OR the system default, and
  // the operator confirms (no empty-confirm path).
  emailSubject: z.string().min(1).max(200),
  emailBody: z.string().min(1).max(10000),
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
      apiLogger.warn({ msg: "cert-issue:no-org", userId: session.user.id, eventId });
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
    const { templateId, tag, emailSubject, emailBody } = parsed.data;

    // Combined lookup — template must belong to an event in the user's org.
    const template = await db.certificateTemplate.findFirst({
      where: {
        id: templateId,
        event: { organizationId: session.user.organizationId },
      },
      select: { id: true, eventId: true, category: true, name: true, backgroundPdfUrl: true },
    });
    if (!template || template.eventId !== eventId) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    // Eligibility query — pulls recipients in the category pool
    // carrying the picked tag, minus anyone already holding a cert
    // FROM THIS TEMPLATE (per-template dedup — a person can hold several
    // role-specific certs of the same category).
    const elig = await eligibleForType(template.category, eventId, tag, template.id);
    const eligible = elig.eligible;

    if (eligible.length === 0) {
      apiLogger.warn({
        msg: "cert-issue:no-eligible-recipients",
        eventId,
        userId: session.user.id,
        templateId: template.id,
        category: template.category,
        tag,
        availableTagsCount: elig.availableTags.length,
      });
      const knownTag = elig.availableTags.find((t) => t.tag === tag);
      const hint = knownTag
        ? `All ${knownTag.count} people tagged "${tag}" in this event already hold an ${template.category} cert.`
        : `No one in this event has the tag "${tag}" (in the ${template.category.toLowerCase()} pool). Tag people first, or pick a different tag.`;
      return NextResponse.json(
        {
          error: hint,
          code: "NO_ELIGIBLE_RECIPIENTS",
          tag,
          availableTags: elig.availableTags,
        },
        { status: 422 },
      );
    }

    // Concurrent-run guard + create — INSIDE a single transaction so two
    // fast-clicks across two tabs (or via MCP race) can't both pass the
    // findFirst before either inserts. Returns null on race so the
    // caller can branch on it cleanly.
    const eventIdLocked = eventId;
    const userIdLocked = session.user.id;
    const txResult = await db.$transaction(async (tx) => {
      const existing = await tx.certificateIssueRun.findFirst({
        where: {
          eventId: eventIdLocked,
          type: template.category,
          status: { in: ["PENDING", "RENDERING", "AWAITING_REVIEW", "SENDING"] },
        },
        select: { id: true, status: true, certificateTemplate: { select: { name: true } } },
      });
      if (existing) {
        return { kind: "exists" as const, existing };
      }
      const created = await tx.certificateIssueRun.create({
        data: {
          eventId: eventIdLocked,
          type: template.category,
          certificateTemplateId: template.id,
          // Dual-write for the bundle model — single-template runs list
          // themselves in templateIds too, so bundle-aware readers never
          // need the legacy-column fallback for new rows.
          templateIds: [template.id],
          status: "PENDING",
          totalCount: eligible.length,
          triggeredByUserId: userIdLocked,
          // Snapshot the operator-confirmed cover-email content. The
          // send phase reads from here, not from the template, so a
          // later template edit doesn't change emails for THIS run.
          emailSubject,
          emailBody,
        },
        select: { id: true },
      });
      await tx.certificateIssueRunItem.createMany({
        data: eligible.map((r) => ({
          runId: created.id,
          registrationId: r.registrationId,
          speakerId: r.speakerId,
          recipientName: r.recipientName,
          recipientEmail: r.recipientEmail,
        })),
      });
      return { kind: "created" as const, created };
    });

    if (txResult.kind === "exists") {
      const templateLabel = txResult.existing.certificateTemplate?.name ?? template.category;
      apiLogger.warn({
        msg: "cert-issue:run-already-in-progress",
        eventId,
        userId: session.user.id,
        templateId: template.id,
        existingRunId: txResult.existing.id,
        existingStatus: txResult.existing.status,
      });
      return NextResponse.json(
        {
          error: `A ${template.category} issue run is already in progress for "${templateLabel}" (status: ${txResult.existing.status}). Wait for it to complete or cancel it first.`,
          code: "RUN_IN_PROGRESS",
          runId: txResult.existing.id,
        },
        { status: 409 },
      );
    }

    const run = txResult.created;

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "CREATE",
          entityType: "CertificateIssueRun",
          entityId: run.id,
          changes: {
            type: template.category,
            templateId: template.id,
            templateName: template.name,
            tag,
            totalCount: eligible.length,
            source: "dashboard",
          },
        },
      })
      .catch((err) => apiLogger.warn({ err, msg: "cert-issue:audit-failed", eventId, runId: run.id }));

    apiLogger.info({
      msg: "cert-issue:run-created",
      eventId,
      runId: run.id,
      templateId: template.id,
      templateName: template.name,
      category: template.category,
      totalCount: eligible.length,
      userId: session.user.id,
    });

    return NextResponse.json(
      {
        runId: run.id,
        totalCount: eligible.length,
        status: "PENDING",
        templateId: template.id,
        nextStep: "Cron worker picks up PENDING runs within 60 seconds. Poll GET /runs/{runId} for status.",
      },
      { status: 201 },
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-issue:failed", eventId });
    return NextResponse.json({ error: "Failed to start certificate issue run" }, { status: 500 });
  }
}
