/**
 * POST /api/events/[eventId]/certificates/bulk-reissue
 *
 * Bulk "resend the latest version to everyone" — re-render + re-send every
 * already-issued cert for a template (optionally filtered to recipients holding
 * a tag) from the CURRENT template. Creates a `reissue` CertificateIssueRun +
 * one item per existing cert; the cert-issue worker drains it (each item via
 * reRenderAndResendCert). Async so it batches + stays under the SES rate; the
 * UI polls the run for progress (same as the Issue flow).
 *
 * Body: { templateId, tag? }.
 * Auth: ADMIN / ORGANIZER (denyReviewer). Org-bound. 10/hr/user rate limit
 * (each run can fan out to hundreds of emails, so the run — not the email — is
 * the rate-limited unit).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma, CertificateType } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db, tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const bodySchema = z.object({
  templateId: z.string().min(1).max(64),
  tag: z.string().min(1).max(120).optional(),
});

/** Narrow the cohort to recipients holding `tag` — attendee tag for ATTENDANCE,
 *  speaker tag for APPRECIATION. Guard-clause style (no nested ternary). */
function cohortTagFilter(category: CertificateType, tag: string | undefined): Prisma.IssuedCertificateWhereInput {
  if (!tag) return {};
  if (category === "ATTENDANCE") return { registration: { attendee: { tags: { has: tag } } } };
  return { speaker: { tags: { has: tag } } };
}

function snapshotName(snapshot: unknown): string {
  const s = (snapshot ?? {}) as { title?: string | null; firstName?: string | null; lastName?: string | null; fullName?: string | null };
  return (
    s.fullName?.trim() ||
    [s.title, s.firstName, s.lastName].filter(Boolean).join(" ").trim() ||
    "Certificate recipient"
  );
}

export async function POST(req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    eventId = p.eventId;
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-bulk-reissue:no-org", userId: session.user.id, eventId });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const orgId = session.user.organizationId; // tenancy: session org

    const rl = checkRateLimit({ key: `cert-bulk-reissue:${session.user.id}`, limit: 10, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "cert-bulk-reissue:rate-limited", userId: session.user.id, eventId, retryAfterSeconds: rl.retryAfterSeconds });
      return NextResponse.json(
        { error: "Too many bulk resends. Try again later.", code: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      apiLogger.warn({ msg: "cert-bulk-reissue:zod-failed", eventId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const { templateId, tag } = parsed.data;

    // Org-bind the event + resolve the template's category.
    // tenancy: swept CertificateTemplate read runs inside the session org.
    const [event, template] = await runWithTenant(orgId, () =>
      Promise.all([
        db.event.findFirst({ where: { id: eventId, organizationId: orgId }, select: { id: true } }),
        db.certificateTemplate.findFirst({ where: { id: templateId, eventId }, select: { id: true, category: true } }),
      ]),
    );
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (!template) return NextResponse.json({ error: "Certificate template not found", code: "TEMPLATE_NOT_FOUND" }, { status: 404 });

    // Guard: one active reissue run per template — don't double-resend.
    // tenancy: swept CertificateIssueRun read runs inside the session org.
    const active = await runWithTenant(orgId, () =>
      db.certificateIssueRun.findFirst({
        where: {
          eventId,
          certificateTemplateId: templateId,
          reissue: true,
          status: { notIn: ["COMPLETED", "FAILED", "CANCELLED"] },
        },
        select: { id: true },
      }),
    );
    if (active) {
      return NextResponse.json(
        { error: "A resend for this template is already in progress.", code: "REISSUE_IN_PROGRESS", runId: active.id },
        { status: 409 },
      );
    }

    // Cohort: every non-revoked, rendered cert for this template — optionally
    // filtered to recipients holding `tag`.
    const tagFilter = cohortTagFilter(template.category, tag);

    // tenancy: swept IssuedCertificate read runs inside the session org.
    const certs = await runWithTenant(orgId, () =>
      db.issuedCertificate.findMany({
        where: {
          eventId,
          certificateTemplateId: templateId,
          revokedAt: null,
          pdfUrl: { not: null },
          ...tagFilter,
        },
        select: { id: true, registrationId: true, speakerId: true, recipientSnapshot: true },
      }),
    );

    if (certs.length === 0) {
      return NextResponse.json(
        {
          error: tag
            ? `No issued certificates from this template match tag “${tag}”.`
            : "No issued certificates to resend for this template yet.",
          code: "NO_CERTS",
        },
        { status: 422 },
      );
    }

    // Create the reissue run + one item per existing cert (per-template, so each
    // recipient appears once → no @@unique([runId, registrationId]) collision).
    // tenancy: wrap the run+items create tx in the session org; swept
    // CertificateIssueRun + CertificateIssueRunItem writes run under SET LOCAL.
    const run = await runWithTenant(orgId, () =>
      tenantTransaction(async (tx) => {
      const created = await tx.certificateIssueRun.create({
        data: {
          eventId: p.eventId,
          organizationId: orgId, // tenancy
          type: template.category,
          certificateTemplateId: templateId,
          reissue: true,
          status: "PENDING",
          totalCount: certs.length,
          triggeredByUserId: session.user.id,
          notes: tag ? `Bulk re-render + resend (tag: ${tag})` : "Bulk re-render + resend",
        },
        select: { id: true },
      });
      await tx.certificateIssueRunItem.createMany({
        data: certs.map((c) => ({
          runId: created.id,
          organizationId: orgId, // tenancy
          registrationId: c.registrationId,
          speakerId: c.speakerId,
          recipientName: snapshotName(c.recipientSnapshot),
          issuedCertificateId: c.id,
        })),
      });
      return created;
      }),
    );

    await db.auditLog
      .create({
        data: {
          eventId: p.eventId,
          userId: session.user.id,
          action: "CERT_BULK_REISSUE",
          entityType: "CertificateIssueRun",
          entityId: run.id,
          changes: { source: "rest", templateId, tag: tag ?? null, totalCount: certs.length } as Prisma.InputJsonValue,
        },
      })
      .catch((err) => apiLogger.warn({ err, msg: "cert-bulk-reissue:audit-failed", runId: run.id }));

    apiLogger.info({ msg: "cert-bulk-reissue:queued", eventId, runId: run.id, templateId, tag: tag ?? null, totalCount: certs.length });
    return NextResponse.json({ ok: true, runId: run.id, totalCount: certs.length });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-bulk-reissue:failed", eventId });
    return NextResponse.json({ error: "Failed to start bulk resend" }, { status: 500 });
  }
}
