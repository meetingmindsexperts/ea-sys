/**
 * POST /api/events/[eventId]/certificates/templates/starter
 *
 * Creates a ready-made "standard" certificate template for the given category
 * — generated background PDF plus pre-positioned, fully tokenized text boxes.
 * The organizer then edits it in the canvas editor, or hits the existing
 * Duplicate to spin role variants off it (the OSH workflow, minus the retyping
 * — see starter-template.ts for what that setup had to hardcode and why).
 *
 * WHY A DEDICATED ROUTE rather than a flag on the collection POST: the
 * collection POST is a pure metadata create over a Zod-validated body. This is
 * a GENERATIVE action — it writes a PDF into storage before it writes a row,
 * and the client has no background PDF to send. That's the same shape as the
 * sibling `/duplicate` route (generate a file, then create a row), so it lives
 * beside it rather than as a branch inside a validation-shaped handler.
 *
 * The generated boxes are re-validated through the SAME shared Zod schema the
 * REST write doors use. Belt-and-braces: the generator is ours, but a future
 * edit to the layout constants that pushed a coordinate out of range would
 * otherwise persist an unrenderable template silently.
 *
 * Auth mirrors the collection POST exactly: ADMIN / ORGANIZER (denyReviewer
 * blocks REVIEWER / SUBMITTER / REGISTRANT / MEMBER), event org-bound, 404 on
 * cross-tenant to avoid existence enumeration.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";

import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { uploadCertificatePdf } from "@/lib/storage";
import { readEventCmeSettings } from "@/lib/certificates/sample-data";
import { certificateTextBoxesSchema } from "@/lib/certificates/template-box-schema";
import {
  buildStarterBackgroundPdf,
  starterTemplateName,
  starterTemplateRole,
  starterTextBoxes,
  type StarterEventShape,
} from "@/lib/certificates/starter-template";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const bodySchema = z.object({
  category: z.enum(["ATTENDANCE", "APPRECIATION"]),
});

export async function POST(req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    eventId = p.eventId;
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;
    const denied = denyReviewer(session);
    if (denied) return denied;

    const body = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({
        msg: "cert-templates:starter-invalid-input",
        eventId,
        userId: session.user.id,
        errors: parsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { category } = parsed.data;

    // Each call renders and stores a PDF, so it is meaningfully more expensive
    // than the metadata-only create. Matches the cert template upload budget.
    const rl = checkRateLimit({
      key: `cert-starter-template:${session.user.id}`,
      limit: 20,
      windowMs: 3600_000,
    });
    if (!rl.allowed) {
      return rateLimited(rl, {
        route: "cert-templates:starter",
        eventId,
        userId: session.user.id,
      });
    }

    // The starter adapts to what the event actually has configured, so it
    // never ships a label with nothing after it (see StarterEventShape).
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: {
        id: true,
        venue: true,
        city: true,
        country: true,
        cmeHours: true,
        settings: true,
      },
    });
    if (!event) {
      apiLogger.warn({
        msg: "cert-templates:starter-event-not-found",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const cme = readEventCmeSettings(event.settings);
    const accreditations = cme.accreditations ?? [];
    const shape: StarterEventShape = {
      hasVenue: Boolean(event.venue || event.city || event.country),
      hasCme: event.cmeHours != null,
      hasAccreditation: accreditations.length > 0,
    };

    const textBoxes = starterTextBoxes(category, shape);
    // Re-validate our own generated boxes through the shared write-door schema.
    const boxCheck = certificateTextBoxesSchema.safeParse(textBoxes);
    if (!boxCheck.success) {
      apiLogger.error({
        msg: "cert-templates:starter-boxes-invalid",
        eventId,
        category,
        errors: boxCheck.error.flatten(),
        hint: "The starter layout constants produced a box outside the accepted range — fix starter-template.ts.",
      });
      return NextResponse.json(
        { error: "Failed to build the standard template", code: "STARTER_LAYOUT_INVALID" },
        { status: 500 },
      );
    }

    // Generate + store the background BEFORE the row is created, so a storage
    // failure leaves nothing behind rather than a row pointing at a PDF that
    // isn't there (the same ordering the /duplicate route uses).
    const pdfBytes = await buildStarterBackgroundPdf(category);
    const backgroundPdfUrl = await uploadCertificatePdf(
      pdfBytes,
      `${randomUUID()}.pdf`,
      event.id,
    );

    const eventIdLocked = event.id;
    const template = await db.$transaction(async (tx) => {
      const maxOrder = await tx.certificateTemplate.aggregate({
        where: { eventId: eventIdLocked, category },
        _max: { sortOrder: true },
      });
      return tx.certificateTemplate.create({
        data: {
          eventId: eventIdLocked,
          name: starterTemplateName(category),
          category,
          backgroundPdfUrl,
          textBoxes: boxCheck.data as unknown as Prisma.InputJsonValue,
          sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
          role: starterTemplateRole(category),
          // Auto-issue starts OFF. A starter that auto-issued on creation
          // would mail certificates to a tag audience the organizer hasn't
          // reviewed yet — same reasoning as the clone in /duplicate.
          autoIssueOnSurvey: false,
        },
      });
    });

    db.auditLog
      .create({
        data: {
          eventId: eventIdLocked,
          userId: session.user.id,
          action: "CREATE",
          entityType: "CertificateTemplate",
          entityId: template.id,
          changes: {
            source: "starter",
            category,
            boxCount: boxCheck.data.length,
            adaptedTo: {
              hasVenue: shape.hasVenue,
              hasCme: shape.hasCme,
              hasAccreditation: shape.hasAccreditation,
            },
          },
        },
      })
      .catch((err) =>
        apiLogger.warn({ err, msg: "cert-templates:starter-audit-failed", eventId: eventIdLocked }),
      );

    apiLogger.info({
      msg: "cert-templates:starter-created",
      eventId: eventIdLocked,
      userId: session.user.id,
      templateId: template.id,
      category,
      boxCount: boxCheck.data.length,
      hasVenue: shape.hasVenue,
      hasCme: shape.hasCme,
      hasAccreditation: shape.hasAccreditation,
    });

    return NextResponse.json(
      {
        template,
        // Surfaced so the UI can tell the organizer WHY the certificate has no
        // accreditation lines, instead of leaving them to wonder.
        omittedSections: {
          venue: !shape.hasVenue,
          accreditation: !shape.hasAccreditation,
          cmeHours: !shape.hasCme,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-templates:starter-failed", eventId });
    return NextResponse.json(
      { error: "Failed to create the standard template" },
      { status: 500 },
    );
  }
}
