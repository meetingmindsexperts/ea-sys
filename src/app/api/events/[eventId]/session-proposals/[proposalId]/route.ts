import { NextResponse } from "next/server";
import { z } from "zod";
import { SessionProposalStatus, SessionType } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";
import { SESSION_TYPE_KIND } from "@/lib/session-enums";
import { notifySessionProposalSubmitted } from "@/lib/session-proposal-notify";
import { missingProfileFields, profileIncompletePayload, PROFILE_COMPLETENESS_SELECT } from "@/lib/submitter-profile-completeness";
import { isDeadlinePassed, readSessionProposalDeadline } from "@/lib/submission-deadline";
import { MAX_PROPOSAL_DESCRIPTION_CHARS } from "@/lib/session-proposal-content";

/**
 * Single session proposal — GET / PUT / DELETE.
 *
 * SUBMITTER rules mirror abstracts: own rows only (404 on foreign — no
 * existence leak), edits allowed ONLY while DRAFT (SUBMITTED_LOCKED after —
 * changes go through the organizer), status writes limited to DRAFT|SUBMITTED
 * (a submit or a keep). Organizer can edit anything + set WITHDRAWN; there is
 * no review workflow in v1. See docs/SESSION_PROPOSALS_PLAN.md.
 */

const programFormatSchema = z
  .nativeEnum(SessionType)
  .refine((t) => SESSION_TYPE_KIND[t] === "program", {
    message: "Proposed format must be a program session type",
  });

const updateProposalSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z
    .string()
    .min(1)
    .max(MAX_PROPOSAL_DESCRIPTION_CHARS, {
      message: `Description must be ${MAX_PROPOSAL_DESCRIPTION_CHARS} characters or fewer`,
    })
    .optional(),
  themeId: z.string().max(100).nullable().optional(),
  proposedFormat: programFormatSchema.nullable().optional(),
  durationMinutes: z.number().int().min(5).max(600).nullable().optional(),
  status: z.nativeEnum(SessionProposalStatus).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; proposalId: string }>;
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
      additionalEmail: true,
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

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, proposalId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Event (+ resource org) first, un-wrapped; its org is the lane for the
    // SessionProposal read (whose nested `speaker` include is swept too).
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });
    const proposal = event
      ? await runWithTenant(event.organizationId, () =>
          db.sessionProposal.findFirst({
            where: { id: proposalId, eventId },
            include: PROPOSAL_INCLUDE,
          }),
        )
      : null;

    if (!event || !proposal) {
      apiLogger.warn({ msg: "session-proposals:not-found", eventId, proposalId, userId: session.user.id });
      return NextResponse.json({ error: "Session proposal not found" }, { status: 404 });
    }

    // SUBMITTER: own proposals only — 404, not 403 (no existence leak).
    if (session.user.role === "SUBMITTER" && proposal.speaker.userId !== session.user.id) {
      apiLogger.warn({ msg: "session-proposals:foreign-submitter-read", eventId, proposalId, userId: session.user.id });
      return NextResponse.json({ error: "Session proposal not found" }, { status: 404 });
    }

    return NextResponse.json(proposal);
  } catch (err) {
    apiLogger.error({ err }, "session-proposals:GET-one failed");
    return NextResponse.json({ error: "Failed to fetch session proposal" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, proposalId }, session, body] = await Promise.all([params, auth(), req.json()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session, { allow: ["SUBMITTER"], route: "events/[eventId]/session-proposals/[proposalId]:PUT" });
    if (denied) return denied;

    const validated = updateProposalSchema.safeParse(body);
    if (!validated.success) {
      const details = validated.error.flatten();
      apiLogger.warn({ msg: "session-proposals:update-validation-failed", eventId, proposalId, errors: details });
      return NextResponse.json({ error: "Invalid input", details }, { status: 400 });
    }
    const data = validated.data;

    // Event (+ resource org) first, un-wrapped; its org is the tenant lane for
    // the existing-proposal read, the theme read, and the update (all swept).
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true, settings: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "session-proposals:not-found", eventId, proposalId, userId: session.user.id });
      return NextResponse.json({ error: "Session proposal not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
      const existing = await db.sessionProposal.findFirst({
        where: { id: proposalId, eventId },
        select: {
          id: true,
          status: true,
          // Full pre-edit values so the audit row records WHAT changed
          // (before→after per field), not just which field names were sent.
          title: true,
          description: true,
          themeId: true,
          proposedFormat: true,
          durationMinutes: true,
          speaker: { select: { userId: true, ...PROFILE_COMPLETENESS_SELECT } },
        },
      });

      if (!existing) {
        apiLogger.warn({ msg: "session-proposals:not-found", eventId, proposalId, userId: session.user.id });
        return NextResponse.json({ error: "Session proposal not found" }, { status: 404 });
      }

      if (session.user.role === "SUBMITTER") {
        if (existing.speaker.userId !== session.user.id) {
          apiLogger.warn({ msg: "session-proposals:foreign-submitter-write", eventId, proposalId, userId: session.user.id });
          return NextResponse.json({ error: "Session proposal not found" }, { status: 404 });
        }
        // Submitters act only while DRAFT (the abstracts SUBMITTED_LOCKED rule).
        if (existing.status !== "DRAFT") {
          apiLogger.warn({ msg: "session-proposals:submitted-locked", eventId, proposalId, userId: session.user.id });
          return NextResponse.json(
            {
              error: "This proposal has been submitted and can no longer be edited. Contact the organizers for changes.",
              code: "SUBMITTED_LOCKED",
            },
            { status: 403 },
          );
        }
        // A submitter may keep DRAFT or submit — never any other status.
        if (data.status && data.status !== "DRAFT" && data.status !== "SUBMITTED") {
          apiLogger.warn({ msg: "session-proposals:submitter-status-refused", eventId, proposalId, status: data.status });
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        // Deadline auto-end (Aug 6, 2026): after settings.sessionProposalDeadline
        // a SUBMITTER can no longer SUBMIT (draft edits stay allowed; staff
        // act normally — organizer decisions are exempt).
        if (data.status === "SUBMITTED" && isDeadlinePassed(readSessionProposalDeadline(event.settings))) {
          apiLogger.warn({ msg: "session-proposals:deadline-passed", eventId, proposalId, userId: session.user.id });
          return NextResponse.json(
            { error: "The session proposal deadline has passed.", code: "DEADLINE_PASSED" },
            { status: 403 },
          );
        }
        // Hard gate (Aug 5, 2026): submitting (DRAFT → SUBMITTED) requires a
        // complete profile. Draft edits stay allowed — only the submission is
        // blocked. The form redirects to My Details first; this covers a
        // direct API call.
        if (data.status === "SUBMITTED") {
          const missing = missingProfileFields(existing.speaker);
          if (missing.length > 0) {
            apiLogger.warn({ msg: "session-proposals:profile-incomplete-block", eventId, proposalId, userId: session.user.id, missing });
            return NextResponse.json(profileIncompletePayload(missing), { status: 403 });
          }
        }
      }

      if (data.themeId) {
        const theme = await db.sessionProposalTheme.findFirst({
          where: { id: data.themeId, eventId },
          select: { id: true },
        });
        if (!theme) {
          apiLogger.warn({ msg: "session-proposals:theme-not-found", eventId, themeId: data.themeId });
          return NextResponse.json({ error: "Theme not found" }, { status: 404 });
        }
      }

      const isSubmission = data.status === "SUBMITTED" && existing.status !== "SUBMITTED";

      const proposal = await db.sessionProposal.update({
        where: { id: proposalId },
        data: {
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.themeId !== undefined ? { themeId: data.themeId } : {}),
          ...(data.proposedFormat !== undefined ? { proposedFormat: data.proposedFormat } : {}),
          ...(data.durationMinutes !== undefined ? { durationMinutes: data.durationMinutes } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(isSubmission ? { submittedAt: new Date() } : {}),
        },
        include: PROPOSAL_INCLUDE,
      });

      if (isSubmission) {
        notifySessionProposalSubmitted({
          eventId,
          organizationId: event.organizationId,
          triggeredByUserId: session.user.id,
          isResubmission: existing.status === "WITHDRAWN",
          proposal,
        });
      }

      // Audit with per-field before→after snapshots (only the fields this
      // request touched), so "who edited what, when" is answerable from the
      // Activity feed — createdAt stamps the when, userId the who. The long
      // description is truncated to keep the JSON row bounded.
      const clip = (s: string | null | undefined) =>
        s != null && s.length > 500 ? `${s.slice(0, 500)}…` : s ?? null;
      const snapshot = (row: { status: string; title: string; description: string | null; themeId: string | null; proposedFormat: string | null; durationMinutes: number | null }) => ({
        status: row.status,
        ...(data.title !== undefined ? { title: row.title } : {}),
        ...(data.description !== undefined ? { description: clip(row.description) } : {}),
        ...(data.themeId !== undefined ? { themeId: row.themeId } : {}),
        ...(data.proposedFormat !== undefined ? { proposedFormat: row.proposedFormat } : {}),
        ...(data.durationMinutes !== undefined ? { durationMinutes: row.durationMinutes } : {}),
      });
      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "UPDATE",
            entityType: "SessionProposal",
            entityId: proposalId,
            changes: { before: snapshot(existing), after: snapshot(proposal), fields: Object.keys(data) },
            ipAddress: getClientIp(req),
          },
        })
        .catch((err) => apiLogger.error({ err, msg: "session-proposals:audit-failed", proposalId }));

      return NextResponse.json(proposal);
    });
  } catch (err) {
    apiLogger.error({ err }, "session-proposals:PUT failed");
    return NextResponse.json({ error: "Failed to update session proposal" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, proposalId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Delete is organizer-only — a submitter withdraws by asking the
    // organizer (their edit lock already applies after submit).
    const denied = denyReviewer(session, { route: "events/[eventId]/session-proposals/[proposalId]:DELETE" });
    if (denied) return denied;

    // Event (+ resource org) first, un-wrapped; its org is the lane for the
    // existing-proposal read + delete (swept).
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "session-proposals:not-found", eventId, proposalId, userId: session.user.id });
      return NextResponse.json({ error: "Session proposal not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
      const existing = await db.sessionProposal.findFirst({
        where: { id: proposalId, eventId },
        select: { id: true, title: true, status: true },
      });

      if (!existing) {
        apiLogger.warn({ msg: "session-proposals:not-found", eventId, proposalId, userId: session.user.id });
        return NextResponse.json({ error: "Session proposal not found" }, { status: 404 });
      }

      await db.sessionProposal.delete({ where: { id: proposalId } });

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "DELETE",
            entityType: "SessionProposal",
            entityId: proposalId,
            changes: { title: existing.title, status: existing.status },
            ipAddress: getClientIp(req),
          },
        })
        .catch((err) => apiLogger.error({ err, msg: "session-proposals:audit-failed", proposalId }));

      return NextResponse.json({ success: true });
    });
  } catch (err) {
    apiLogger.error({ err }, "session-proposals:DELETE failed");
    return NextResponse.json({ error: "Failed to delete session proposal" }, { status: 500 });
  }
}
