import { NextResponse } from "next/server";
import { z } from "zod";
import { SessionProposalStatus, SessionType } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db, tenantTransaction } from "@/lib/db";
import { getNextSessionProposalSerialId, formatSessionProposalSerial } from "@/lib/session-proposal-serial";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";
import { SESSION_TYPE_KIND, SESSION_TYPE_LABELS } from "@/lib/session-enums";
import { formatPersonName } from "@/lib/utils";
import { toCsvRow } from "@/lib/csv-escape";
import { recordExport } from "@/lib/audit-data-transfer";
import { notifySessionProposalSubmitted } from "@/lib/session-proposal-notify";

/**
 * Session proposals — abstracts-shaped submissions for proposing SESSIONS.
 * v1 is an organizer INBOX (list / view / export) with NO review workflow.
 * SUBMITTER accounts propose + edit their own (DRAFT-only, like abstracts).
 * See docs/SESSION_PROPOSALS_PLAN.md.
 */

const proposalStatusSchema = z.nativeEnum(SessionProposalStatus);

// Only PROGRAM session kinds are proposable (a coffee break isn't a proposal).
const programFormatSchema = z
  .nativeEnum(SessionType)
  .refine((t) => SESSION_TYPE_KIND[t] === "program", {
    message: "Proposed format must be a program session type",
  });

const createProposalSchema = z.object({
  speakerId: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  description: z.string().min(1).max(50000),
  themeId: z.string().max(100).optional(),
  proposedFormat: programFormatSchema.optional(),
  durationMinutes: z.number().int().min(5).max(600).optional(),
  // A proposal may only be BORN as DRAFT or SUBMITTED (the abstracts H2
  // lesson — never let a self-service role mint a terminal status).
  status: z.enum(["DRAFT", "SUBMITTED"]).default("SUBMITTED"),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const PROPOSAL_INCLUDE = {
  speaker: {
    select: {
      id: true,
      userId: true,
      title: true,
      firstName: true,
      lastName: true,
      email: true,
      organization: true,
      country: true,
      // The proposer's attendee facet — lets the organizer sheet show whether
      // this person already holds a registration or still needs the grant.
      sourceRegistrationId: true,
      sourceRegistration: {
        select: { id: true, serialId: true, status: true, paymentStatus: true },
      },
    },
  },
  theme: { select: { id: true, name: true } },
} as const;

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get("status");
    const parsedStatus = statusParam ? proposalStatusSchema.safeParse(statusParam) : null;
    if (statusParam && !parsedStatus?.success) {
      // A bad filter must never silently widen the result set.
      apiLogger.warn({ msg: "session-proposals:invalid-status-filter", eventId, statusParam });
      return NextResponse.json({ error: "Invalid status filter", code: "INVALID_FILTER" }, { status: 400 });
    }
    const status = parsedStatus?.success ? parsedStatus.data : undefined;
    const themeId = searchParams.get("themeId") || undefined;
    const wantsCsv = searchParams.get("export") === "csv";

    const isSubmitter = session.user.role === "SUBMITTER";

    // A DRAFT is the submitter's private work-in-progress — only the owning
    // SUBMITTER sees their drafts (the abstracts draft-visibility rule).
    const statusWhere = isSubmitter
      ? status
        ? { status }
        : {}
      : status && status !== "DRAFT"
        ? { status }
        : { status: { not: SessionProposalStatus.DRAFT } };

    const where = {
      eventId,
      ...statusWhere,
      ...(themeId ? { themeId } : {}),
      ...(isSubmitter ? { speaker: { userId: session.user.id } } : {}),
    };

    if (wantsCsv) {
      // Export is a NARROWER boundary than read (house rule): org staff only.
      const denied = denyReviewer(session);
      if (denied) return denied;
    }

    // Resolve the event (+ resource org) FIRST, un-wrapped — Event is not yet a
    // swept table, and its org is the tenant lane for the SessionProposal read.
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });

    if (!event) {
      apiLogger.warn({ msg: "session-proposals:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Resource org: correct for org-null SUBMITTERs too (the Abstract dual-route
    // pattern). The SessionProposal read (swept) rides the tenant lane.
    const proposals = await runWithTenant(event.organizationId, () =>
      db.sessionProposal.findMany({
        where,
        include: PROPOSAL_INCLUDE,
        orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
        take: 500,
      }),
    );

    if (wantsCsv) {
      const header = toCsvRow([
        "Proposal #", "Title", "Proposer", "Email", "Organization", "Country",
        "Theme", "Format", "Duration (min)", "Status", "Submitted At",
      ]);
      const rows = proposals.map((p) =>
        toCsvRow([
          formatSessionProposalSerial(p.serialId),
          p.title,
          formatPersonName(p.speaker.title, p.speaker.firstName, p.speaker.lastName),
          p.speaker.email,
          p.speaker.organization ?? "",
          p.speaker.country ?? "",
          p.theme?.name ?? "",
          p.proposedFormat ? SESSION_TYPE_LABELS[p.proposedFormat] : "",
          p.durationMinutes ?? "",
          p.status,
          p.submittedAt ? p.submittedAt.toISOString() : "",
        ]),
      );
      recordExport(req, {
        entityType: "SessionProposal",
        eventId,
        organizationId: event.organizationId,
        userId: session.user.id,
        role: session.user.role,
        source: "rest",
        rowCount: proposals.length,
        format: "csv",
        filters: { ...(status ? { status } : {}), ...(themeId ? { themeId } : {}) },
      });
      return new NextResponse([header, ...rows].join("\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="session-proposals-${eventId}.csv"`,
        },
      });
    }

    return NextResponse.json(proposals);
  } catch (err) {
    apiLogger.error({ err }, "session-proposals:GET failed");
    return NextResponse.json({ error: "Failed to fetch session proposals" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([params, auth(), req.json()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Org staff + SUBMITTER may propose; every other restricted role
    // (REVIEWER / REGISTRANT / MEMBER / ONSITE / CRM_USER) is refused.
    const denied = denyReviewer(session, { allow: ["SUBMITTER"] });
    if (denied) return denied;

    const validated = createProposalSchema.safeParse(body);
    if (!validated.success) {
      const details = validated.error.flatten();
      apiLogger.warn({ msg: "session-proposals:create-validation-failed", eventId, userId: session.user.id, errors: details });
      return NextResponse.json({ error: "Invalid input", details }, { status: 400 });
    }

    const { speakerId, title, description, themeId, proposedFormat, durationMinutes, status } = validated.data;

    // SUBMITTER can only propose for their own speaker record.
    const speakerWhere =
      session.user.role === "SUBMITTER"
        ? { id: speakerId, eventId, userId: session.user.id }
        : { id: speakerId, eventId };

    // Event (+ resource org) FIRST, un-wrapped (Event is not swept); its org is
    // the tenant lane for the Speaker (swept #9), theme, and proposal writes.
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });

    if (!event) {
      apiLogger.warn({ msg: "session-proposals:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Everything that reads/writes a swept table rides the resource-org lane.
    return await runWithTenant(event.organizationId, async () => {
      const [speaker, theme] = await Promise.all([
        db.speaker.findFirst({ where: speakerWhere, select: { id: true } }),
        themeId
          ? db.sessionProposalTheme.findFirst({ where: { id: themeId, eventId }, select: { id: true } })
          : Promise.resolve(null),
      ]);

      if (!speaker) {
        apiLogger.warn({ msg: "session-proposals:speaker-not-found", eventId, speakerId, userId: session.user.id });
        return NextResponse.json(
          { error: session.user.role === "SUBMITTER" ? "Forbidden" : "Speaker not found" },
          { status: session.user.role === "SUBMITTER" ? 403 : 404 },
        );
      }
      if (themeId && !theme) {
        apiLogger.warn({ msg: "session-proposals:theme-not-found", eventId, themeId });
        return NextResponse.json({ error: "Theme not found" }, { status: 404 });
      }

      // Serial + create share one transaction so a failed insert rolls the
      // counter back (registration/abstract-serial pattern).
      const proposal = await tenantTransaction(async (tx) => {
        const serialId = await getNextSessionProposalSerialId(tx, eventId, event.organizationId);
        return tx.sessionProposal.create({
          data: {
            eventId,
            organizationId: event.organizationId,
            speakerId,
            title,
            description,
            themeId: themeId || null,
            proposedFormat: proposedFormat || null,
            durationMinutes: durationMinutes ?? null,
            status,
            serialId,
            submittedAt: status === "SUBMITTED" ? new Date() : undefined,
          },
          include: {
            ...PROPOSAL_INCLUDE,
            speaker: { select: { ...PROPOSAL_INCLUDE.speaker.select, additionalEmail: true } },
          },
        });
      });

      // Confirmation email + admin notify — only on a real submission, never a
      // DRAFT save. Failure-isolated in the helper (touches no swept table).
      if (status === "SUBMITTED") {
        notifySessionProposalSubmitted({
          eventId,
          organizationId: event.organizationId,
          triggeredByUserId: session.user.id,
          isResubmission: false,
          proposal,
        });
      }

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "CREATE",
            entityType: "SessionProposal",
            entityId: proposal.id,
            changes: { title, status, themeId: themeId ?? null, proposedFormat: proposedFormat ?? null },
            ipAddress: getClientIp(req),
          },
        })
        .catch((err) => apiLogger.error({ err, msg: "session-proposals:audit-failed", proposalId: proposal.id }));

      return NextResponse.json(proposal, { status: 201 });
    });
  } catch (err) {
    apiLogger.error({ err }, "session-proposals:POST failed");
    return NextResponse.json({ error: "Failed to create session proposal" }, { status: 500 });
  }
}
