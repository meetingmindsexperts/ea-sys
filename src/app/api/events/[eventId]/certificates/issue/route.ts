/**
 * POST /api/events/[eventId]/certificates/issue
 *   body: { templateIds: string[] (1..3), emailSubject, emailBody }
 *         (`templateId: string` is accepted as one template, the pre-bundle
 *         spelling)
 *   returns 201 { runId, totalCount, status, templateIds, perTemplate }
 *
 * Creates a CertificateIssueRun. Each selected template goes to the people
 * ASSIGNED it (src/lib/certificates/assignments.ts) who do not hold it yet,
 * and per-template pools are merged per PERSON (registration + linked
 * speaker) so one run item, and later ONE email, carries every cert the
 * person earns.
 *
 * Guards:
 *   - Every template must belong to the (org-bound) event.
 *   - A body carrying `tag` is refused (TAGS_RETIRED): tags stopped deciding
 *     recipients on Nov 11, 2026, and silently reading such a request as
 *     "everyone assigned" would send to a different set of people than the
 *     stale page showed.
 *   - No non-terminal MANUAL run may OVERLAP the requested template set
 *     (same-template double-issue guard). Disjoint sets run concurrently:
 *     manual runs park indefinitely at AWAITING_REVIEW, so an event-wide
 *     guard would let one forgotten run block all issuance. Auto-issue +
 *     reissue runs are exempt.
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
import { db, tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { requirePermission } from "@/lib/permissions/require-permission";
import { apiLogger } from "@/lib/logger";
import { eligibleForTemplates } from "@/lib/certificates/eligibility";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const bodySchema = z
  .object({
    // 1..3 templates per run; each goes to the people assigned it, entries
    // merged per PERSON so one email carries all the certs a person earns.
    templateIds: z.array(z.string().min(1).max(100)).min(1).max(3).optional(),
    // The pre-bundle spelling of one template.
    templateId: z.string().min(1).optional(),
    // Read only to refuse it (TAGS_RETIRED, see the header).
    tag: z.unknown().optional(),
    // Cover-email content the operator confirmed at Issue time. Stored
    // as a snapshot on the run row so a later template edit doesn't
    // change emails for an in-flight run. Both required — the dialog
    // pre-fills from the template default (single) / bundle default
    // (multi), and the operator confirms (no empty-confirm path).
    emailSubject: z.string().min(1).max(200),
    emailBody: z.string().min(1).max(10000),
  })
  .superRefine((data, ctx) => {
    if (!data.templateIds?.length && !data.templateId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["templateIds"],
        message: "Provide templateIds (1 to 3 templates)",
      });
    }
  });

function runTemplateIds(run: { templateIds: string[]; certificateTemplateId: string | null }): string[] {
  if (run.templateIds.length) return run.templateIds;
  return run.certificateTemplateId ? [run.certificateTemplateId] : [];
}

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
    const gate = requirePermission(session, "certificates.issue", { route: "events/[eventId]/certificates/issue:POST", eventId: eventId });
    if (!gate.ok) return gate.response;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-issue:no-org", userId: session.user.id, eventId });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const orgId = session.user.organizationId; // tenancy: session org

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
    if (parsed.data.tag !== undefined && parsed.data.tag !== null) {
      apiLogger.warn({ msg: "cert-issue:tag-refused", eventId, userId: session.user.id });
      return NextResponse.json(
        {
          error: "Tags no longer decide who receives a certificate. Reload the page and assign the certificate to people instead.",
          code: "TAGS_RETIRED",
        },
        { status: 400 },
      );
    }
    const { templateId, emailSubject, emailBody } = parsed.data;
    const requestedTemplateIds = parsed.data.templateIds?.length
      ? parsed.data.templateIds
      : [templateId!];

    // Combined lookup — every template must belong to the (org-bound) event.
    // tenancy: swept CertificateTemplate read runs inside the session org.
    const templates = await runWithTenant(orgId, () =>
      db.certificateTemplate.findMany({
        where: {
          id: { in: requestedTemplateIds },
          eventId,
          event: gate.eventWhere,
        },
        select: { id: true, category: true, name: true },
      }),
    );
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

    // Eligibility: per-template pool (the people assigned it, minus those who
    // already hold it), merged per PERSON so one run item = one email carrying
    // every cert the person earns.
    // tenancy: eligibility reads swept cert tables, run inside the session org.
    const merged = await runWithTenant(orgId, () =>
      eligibleForTemplates(
        p.eventId,
        templates.map((t) => ({ id: t.id, name: t.name, category: t.category })),
      ),
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
      const nobodyAssigned = merged.perTemplate.every((t) => t.assigned === 0);
      const hint = nobodyAssigned
        ? `Nobody is assigned ${templates.map((t) => `"${t.name}"`).join(", ")} yet. Assign the certificate to people first, under Certificates, Recipients.`
        : `Everyone assigned ${templates.map((t) => `"${t.name}"`).join(", ")} already holds it. Assign more people, or use Resend to everyone to send the current version again.`;
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
    const requestedIdSet = new Set(templates.map((t) => t.id));
    // tenancy: wrap the guard+create tx in the session org; swept
    // CertificateIssueRun + CertificateIssueRunItem writes run under SET LOCAL.
    const txResult = await runWithTenant(orgId, () =>
      tenantTransaction(async (tx) => {
      // Concurrent-run guard: block only when a non-terminal MANUAL run
      // OVERLAPS this request's template set (same-template double-issue is
      // the real hazard). Deliberately NOT one-run-per-event: manual runs
      // park indefinitely at the AWAITING_REVIEW operator gate, so an
      // event-wide guard would let one forgotten run block ALL cert
      // issuance (review finding, 2026-07-10). Disjoint template sets run
      // concurrently, matching the old per-category behavior's intent.
      const nonTerminal = await tx.certificateIssueRun.findMany({
        where: {
          eventId: eventIdLocked,
          autoIssue: false,
          reissue: false,
          status: { in: ["PENDING", "RENDERING", "AWAITING_REVIEW", "SENDING"] },
        },
        select: {
          id: true,
          status: true,
          templateIds: true,
          certificateTemplateId: true,
          certificateTemplate: { select: { name: true } },
        },
      });
      const existing = nonTerminal.find((r) => {
        const runIds = runTemplateIds(r);
        return runIds.some((id) => requestedIdSet.has(id));
      });
      if (existing) {
        return { kind: "exists" as const, existing };
      }
      const created = await tx.certificateIssueRun.create({
        data: {
          eventId: eventIdLocked,
          organizationId: orgId, // tenancy
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
          organizationId: orgId, // tenancy
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
      }),
    );

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
          error: `An issue run covering one of the selected templates ("${templateLabel}") is already in progress (status: ${txResult.existing.status}). Wait for it to complete or cancel it first.`,
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
        nextStep: "The worker picks up PENDING runs within ~90 seconds. Poll GET /runs/{runId} for status.",
      },
      { status: 201 },
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-issue:failed", eventId });
    return NextResponse.json({ error: "Failed to start certificate issue run" }, { status: 500 });
  }
}
