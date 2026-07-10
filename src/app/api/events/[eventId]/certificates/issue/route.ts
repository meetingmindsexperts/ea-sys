/**
 * POST /api/events/[eventId]/certificates/issue
 *   body (bundle model, 2026-07-09):
 *     { templateIds: string[] (1..3), emailSubject, emailBody }
 *   body (legacy single-template, kept for back-compat):
 *     { templateId: string, tag: string, emailSubject, emailBody }
 *   → 201 { runId, totalCount, status, templateIds, perTemplate }
 *
 * Creates a CertificateIssueRun. In the bundle model each selected
 * template's STORED tag decides its recipient pool (no per-action tag),
 * and per-template pools are merged per PERSON (registration + linked
 * speaker) so one run item — and later ONE email — carries every cert
 * the person earns. The legacy shape applies its explicit tag to the
 * single template's pool.
 *
 * Guards:
 *   - Every template must belong to the (org-bound) event.
 *   - Bundle shape: every template must carry a tag (TEMPLATE_MISSING_TAG).
 *   - ONE non-terminal MANUAL run per event (was per-category — a
 *     mixed-category bundle would slip a category-scoped guard).
 *     Auto-issue + reissue runs are exempt, as before.
 *
 * Design-approval gate REMOVED on 2026-06-02. The PDF-overlay model
 * makes the design tangible (operator sees the canvas + Preview button)
 * so the dedicated SUPER_ADMIN sign-off step is no longer warranted.
 *
 * Side effects:
 *   - INSERT CertificateIssueRun (status=PENDING, templateIds set;
 *     certificateTemplateId only for single-template runs)
 *   - INSERT CertificateIssueRunItem per PERSON (both facet ids when
 *     the person earns certs on both)
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
import { eligibleForTemplates } from "@/lib/certificates/eligibility";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const bodySchema = z
  .object({
    // ── Bundle model (2026-07-09): 1..3 templates per run; each template's
    // STORED tag decides its pool (no per-action tag), entries merged per
    // PERSON so one email carries all the certs a person earns.
    templateIds: z.array(z.string().min(1).max(100)).min(1).max(3).optional(),
    // ── Legacy single-template shape (kept for pre-bundle clients): the
    // explicit tag overrides the stored one.
    templateId: z.string().min(1).optional(),
    tag: z.string().min(1).max(100).optional(),
    // Cover-email content the operator confirmed at Issue time. Stored
    // as a snapshot on the run row so a later template edit doesn't
    // change emails for an in-flight run. Both required — the dialog
    // pre-fills from the template default (single) / bundle default
    // (multi), and the operator confirms (no empty-confirm path).
    emailSubject: z.string().min(1).max(200),
    emailBody: z.string().min(1).max(10000),
  })
  .superRefine((data, ctx) => {
    if (!data.templateIds?.length && !(data.templateId && data.tag)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["templateIds"],
        message: "Provide templateIds (bundle model) or legacy templateId + tag",
      });
    }
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
    const requestedTemplateIds = parsed.data.templateIds?.length
      ? parsed.data.templateIds
      : [templateId!];

    // Combined lookup — every template must belong to the (org-bound) event.
    const templates = await db.certificateTemplate.findMany({
      where: {
        id: { in: requestedTemplateIds },
        eventId,
        event: { organizationId: session.user.organizationId },
      },
      select: { id: true, category: true, name: true, autoIssueTag: true },
    });
    if (templates.length !== new Set(requestedTemplateIds).size) {
      apiLogger.warn({
        msg: "cert-issue:template-not-found",
        eventId,
        userId: session.user.id,
        requestedTemplateIds,
        foundCount: templates.length,
      });
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }
    const isBundleShape = Boolean(parsed.data.templateIds?.length);

    // Bundle model: each template's STORED tag drives its pool, so every
    // selected template must carry one. (Legacy shape passes an explicit
    // per-action tag instead.)
    if (isBundleShape) {
      const untagged = templates.filter((t) => !t.autoIssueTag?.trim());
      if (untagged.length > 0) {
        apiLogger.warn({
          msg: "cert-issue:template-missing-tag",
          eventId,
          userId: session.user.id,
          untaggedTemplateIds: untagged.map((t) => t.id),
        });
        return NextResponse.json(
          {
            error: `Template${untagged.length > 1 ? "s" : ""} ${untagged
              .map((t) => `"${t.name}"`)
              .join(", ")} ha${untagged.length > 1 ? "ve" : "s"} no tag — set a tag on the template first (the tag decides who receives it).`,
            code: "TEMPLATE_MISSING_TAG",
          },
          { status: 400 },
        );
      }
    }

    // Eligibility — per-template pool (stored tag, minus already-issued for
    // that template), merged per PERSON so one run item = one email carrying
    // every cert the person earns. The legacy shape reuses the same merge
    // with its explicit tag substituted for the stored one.
    const merged = await eligibleForTemplates(
      eventId,
      templates.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        autoIssueTag: isBundleShape ? t.autoIssueTag : tag!,
      })),
    );
    const people = merged.people;

    if (people.length === 0) {
      apiLogger.warn({
        msg: "cert-issue:no-eligible-recipients",
        eventId,
        userId: session.user.id,
        templateIds: requestedTemplateIds,
        perTemplate: merged.perTemplate,
      });
      const hint = isBundleShape
        ? `No one qualifies for the selected template${templates.length > 1 ? "s" : ""} — either nobody holds the template tag(s) (${merged.perTemplate
            .map((p) => `"${p.tag}"`)
            .join(", ")}) or everyone tagged already holds those certificates.`
        : `No one in this event has the tag "${tag}" in the ${templates[0].category.toLowerCase()} pool, or everyone tagged already holds this certificate. Tag people first, or pick a different tag.`;
      return NextResponse.json(
        {
          error: hint,
          code: "NO_ELIGIBLE_RECIPIENTS",
          perTemplate: merged.perTemplate,
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
    // Run's display category: ATTENDANCE when any template is ATTENDANCE
    // (the "primary" category for mixed bundles), else APPRECIATION.
    const runType = templates.some((t) => t.category === "ATTENDANCE")
      ? ("ATTENDANCE" as const)
      : ("APPRECIATION" as const);
    const txResult = await db.$transaction(async (tx) => {
      // ONE non-terminal MANUAL run per event (was per-category — a
      // mixed-category bundle run would slip a category-scoped guard).
      // Slight tightening; manual runs drain in minutes. Auto-issue +
      // reissue runs stay outside the guard, as before.
      const existing = await tx.certificateIssueRun.findFirst({
        where: {
          eventId: eventIdLocked,
          autoIssue: false,
          reissue: false,
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
          type: runType,
          // Legacy pointer only meaningful for single-template runs; a
          // multi-template bundle leaves it null and lists templateIds.
          certificateTemplateId: templates.length === 1 ? templates[0].id : null,
          templateIds: templates.map((t) => t.id),
          status: "PENDING",
          totalCount: people.length,
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
        data: people.map((r) => ({
          runId: created.id,
          registrationId: r.registrationId,
          speakerId: r.speakerId,
          recipientName: r.recipientName,
          recipientEmail: r.recipientEmail,
          // The subset of the run's templates THIS person earned — the
          // render phase issues exactly these (facet presence alone can't
          // disambiguate two same-category templates).
          templateIds: r.templateIds,
        })),
      });
      return { kind: "created" as const, created };
    });

    if (txResult.kind === "exists") {
      const templateLabel = txResult.existing.certificateTemplate?.name ?? "certificates";
      apiLogger.warn({
        msg: "cert-issue:run-already-in-progress",
        eventId,
        userId: session.user.id,
        templateIds: requestedTemplateIds,
        existingRunId: txResult.existing.id,
        existingStatus: txResult.existing.status,
      });
      return NextResponse.json(
        {
          error: `A certificate issue run is already in progress for "${templateLabel}" (status: ${txResult.existing.status}). Wait for it to complete or cancel it first.`,
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
            type: runType,
            templateIds: templates.map((t) => t.id),
            templateNames: templates.map((t) => t.name),
            ...(isBundleShape ? {} : { tag }),
            totalCount: people.length,
            source: "dashboard",
          },
        },
      })
      .catch((err) => apiLogger.warn({ err, msg: "cert-issue:audit-failed", eventId, runId: run.id }));

    apiLogger.info({
      msg: "cert-issue:run-created",
      eventId,
      runId: run.id,
      templateIds: templates.map((t) => t.id),
      templateNames: templates.map((t) => t.name),
      category: runType,
      totalCount: people.length,
      userId: session.user.id,
    });

    return NextResponse.json(
      {
        runId: run.id,
        totalCount: people.length,
        status: "PENDING",
        templateIds: templates.map((t) => t.id),
        templateId: templates.length === 1 ? templates[0].id : undefined,
        perTemplate: merged.perTemplate,
        nextStep: "Cron worker picks up PENDING runs within 60 seconds. Poll GET /runs/{runId} for status.",
      },
      { status: 201 },
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-issue:failed", eventId });
    return NextResponse.json({ error: "Failed to start certificate issue run" }, { status: 500 });
  }
}
