/**
 * Certificate templates collection — GET (list) + POST (create).
 *
 * v3 multi-template model (2026-06-02). Replaces the previous 2-slot JSON
 * at Event.settings.certificateTemplates. An event can have any number of
 * templates per category (ATTENDANCE | APPRECIATION) — organizer picks
 * which fires at Issue time.
 *
 * Auth: ADMIN / ORGANIZER (denyReviewer blocks REVIEWER / SUBMITTER /
 * REGISTRANT / MEMBER). Event is org-bound; cross-tenant access returns
 * 404 to avoid existence enumeration.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { validateBackgroundPdfUrl } from "@/lib/certificates/pdf-loader";
import { Prisma } from "@prisma/client";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const FONT_NAMES = [
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
  "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
  "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
] as const;

const textBoxSchema = z.object({
  id: z.string().min(1).max(64),
  content: z.string().max(500),
  x: z.number().min(0).max(20000),
  y: z.number().min(0).max(20000),
  width: z.number().min(1).max(20000),
  height: z.number().min(1).max(20000),
  font: z.enum(FONT_NAMES),
  size: z.number().min(4).max(120),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a 6-digit hex color"),
  align: z.enum(["left", "center", "right"]),
});

const createSchema = z.object({
  name: z.string().min(1).max(120).trim(),
  category: z.enum(["ATTENDANCE", "APPRECIATION"]),
  // Guard against a path-traversal / SSRF value being persisted (B1). Every
  // URL the system itself generates satisfies this; only attacker input fails.
  backgroundPdfUrl: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .refine((v) => v == null || validateBackgroundPdfUrl(v).ok, {
      message: "backgroundPdfUrl must be a /uploads/certificates/ path or an https Supabase URL",
    }),
  textBoxes: z.array(textBoxSchema).max(40).optional(),
  // Per-template default cover email. Both nullable — when null the
  // Issue dialog pre-fills with the system default. min(1) when set
  // so a template doesn't carry an empty string that would render
  // an empty email on the wire.
  emailSubject: z.string().min(1).max(200).nullable().optional(),
  emailBody: z.string().min(1).max(10000).nullable().optional(),
  // Role/designation this template certifies ({{role}} token) + static
  // per-template CME hours ({{cmeHours}}, overrides event-level when set).
  role: z.string().max(120).trim().nullable().optional(),
  cmeHours: z.number().min(0).max(999).nullable().optional(),
  // Phase 2 survey-gated auto-issue: when on, this template is issued
  // automatically to survey-completers who hold autoIssueTag (attendee
  // tag for ATTENDANCE, speaker tag for APPRECIATION).
  autoIssueOnSurvey: z.boolean().optional(),
  autoIssueTag: z.string().max(120).trim().nullable().optional(),
});

export async function GET(req: Request, { params }: RouteParams) {
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

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({
        msg: "cert-templates:list-event-not-found",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const templates = await db.certificateTemplate.findMany({
      where: { eventId },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
      include: {
        _count: { select: { issuedCertificates: true, issueRuns: true } },
      },
    });

    return NextResponse.json({ templates });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-templates:list-failed", eventId });
    return NextResponse.json({ error: "Failed to load templates" }, { status: 500 });
  }
}

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

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({
        msg: "cert-templates:create-event-not-found",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({
        msg: "cert-templates:create-invalid-input",
        eventId,
        errors: parsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    // sortOrder defaults to the max+1 within the same category so new
    // templates land at the bottom of their group. Wrap aggregate+create
    // in a transaction so two concurrent POSTs (dashboard click + MCP
    // call racing on the same category) can't both compute the same
    // nextOrder. Not catastrophic (sortOrder isn't unique-constrained)
    // but it'd produce visually identical ordering positions and the
    // canonical-position semantic relies on per-category uniqueness.
    const eventIdLocked = eventId;
    const data = parsed.data;
    const template = await db.$transaction(async (tx) => {
      const maxOrder = await tx.certificateTemplate.aggregate({
        where: { eventId: eventIdLocked, category: data.category },
        _max: { sortOrder: true },
      });
      const nextOrder = (maxOrder._max.sortOrder ?? -1) + 1;
      return tx.certificateTemplate.create({
        data: {
          eventId: eventIdLocked,
          name: data.name,
          category: data.category,
          backgroundPdfUrl: data.backgroundPdfUrl ?? null,
          textBoxes: (data.textBoxes ?? []) as unknown as Prisma.InputJsonValue,
          sortOrder: nextOrder,
          emailSubject: data.emailSubject ?? null,
          emailBody: data.emailBody ?? null,
          role: data.role ?? null,
          cmeHours: data.cmeHours ?? null,
          autoIssueOnSurvey: data.autoIssueOnSurvey ?? false,
          autoIssueTag: data.autoIssueTag ?? null,
        },
      });
    });

    apiLogger.info({
      msg: "cert-templates:created",
      eventId,
      userId: session.user.id,
      templateId: template.id,
      category: template.category,
      name: template.name,
    });

    return NextResponse.json({ template }, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-templates:create-failed", eventId });
    return NextResponse.json({ error: "Failed to create template" }, { status: 500 });
  }
}
