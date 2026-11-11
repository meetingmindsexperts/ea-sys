/**
 * /api/events/[eventId]/certificates/assignments
 *
 * Who receives which certificate (CertificateAssignment; the rule is
 * src/lib/certificates/assignments.ts, the writes
 * src/services/certificate-assignment-service.ts).
 *
 *   GET    ?registrationId=  or  ?speakerId=
 *          The template ids assigned to that one person: what their own card
 *          needs to offer the certificates it may issue.
 *
 *   POST   { templateId, registrationIds? | speakerIds? | emails?,
 *            confirmSendNow?, dryRun? }
 *          Assign people. `emails` is a pasted list (an attendance export
 *          from the webinar platform), matched to this event's registrations,
 *          or to its speakers for an appreciation template; the addresses
 *          nobody has come back in `unmatched`.
 *          409 CONFIRM_SEND_NOW when some of them have already answered the
 *          survey and the template sends automatically: the body carries
 *          `sendNow` (every certificate re-opening them sends, other templates
 *          they were owed included) and the same request with
 *          `confirmSendNow: <that number>` goes through; a number that has
 *          grown since is asked again. 403 SEND_NOW_NOT_PERMITTED when the
 *          caller lacks certificates.issue, which sending needs.
 *          `dryRun: true` works everything out and writes nothing.
 *
 *   DELETE { templateId, registrationIds? | speakerIds? }
 *          Take people off the list. Someone who holds the certificate stays
 *          (`keptIssued`): revoke the certificate instead.
 *
 * Reading needs certificates.read. Assigning and removing need
 * certificates.templates.manage: who receives a template is part of the
 * template's setup, the same key that set the tag this replaced and that
 * turns its auto-issue switch on (the agent's tools ask the same key).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { requirePermission } from "@/lib/permissions/require-permission";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { loadAssignedTemplateIds } from "@/lib/certificates/assignments";
import { mayReleaseCertificates } from "@/lib/certificates/release-permission";
import {
  assignCertificate,
  unassignCertificate,
  resolveAssignmentEmails,
  MAX_ASSIGNMENT_BATCH,
} from "@/services/certificate-assignment-service";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const idList = z.array(z.string().min(1).max(100)).max(MAX_ASSIGNMENT_BATCH);

const assignSchema = z
  .object({
    templateId: z.string().min(1).max(100),
    registrationIds: idList.optional(),
    speakerIds: idList.optional(),
    emails: z.array(z.string().max(320)).max(MAX_ASSIGNMENT_BATCH).optional(),
    // The number of certificates the person was shown would go out now, and agreed to.
    confirmSendNow: z.number().int().min(0).max(1_000_000).optional(),
    dryRun: z.boolean().optional(),
  })
  .refine((d) => [d.registrationIds, d.speakerIds, d.emails].filter((l) => l && l.length > 0).length === 1, {
    message: "Provide exactly one of registrationIds, speakerIds or emails",
    path: ["registrationIds"],
  });

const unassignSchema = z
  .object({
    templateId: z.string().min(1).max(100),
    registrationIds: idList.optional(),
    speakerIds: idList.optional(),
  })
  .refine((d) => [d.registrationIds, d.speakerIds].filter((l) => l && l.length > 0).length === 1, {
    message: "Provide exactly one of registrationIds or speakerIds",
    path: ["registrationIds"],
  });

const ASSIGN_STATUS: Record<string, number> = {
  TEMPLATE_NOT_FOUND: 404,
  WRONG_RECIPIENT_TYPE: 400,
  NO_RECIPIENTS: 400,
  TOO_MANY: 400,
  CONFIRM_SEND_NOW: 409,
  SEND_NOW_NOT_PERMITTED: 403,
};

function rateLimited(userId: string, eventId: string) {
  const rl = checkRateLimit({ key: `cert-assign:${userId}`, limit: 300, windowMs: 60 * 60 * 1000 });
  if (rl.allowed) return null;
  apiLogger.warn({ msg: "cert-assignments:rate-limited", userId, eventId, retryAfterSeconds: rl.retryAfterSeconds });
  return NextResponse.json(
    {
      error: "Too many certificate assignment changes. Try again later.",
      code: "RATE_LIMITED",
      retryAfterSeconds: rl.retryAfterSeconds,
      limit: 300,
      windowSeconds: 3600,
    },
    { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
  );
}

export async function GET(req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    eventId = p.eventId;
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/certificates/assignments:GET" });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "certificates.read", { route: "events/[eventId]/certificates/assignments:GET", eventId });
    if (!gate.ok) return gate.response;

    const url = new URL(req.url);
    const registrationId = url.searchParams.get("registrationId");
    const speakerId = url.searchParams.get("speakerId");
    if ((registrationId && speakerId) || (!registrationId && !speakerId)) {
      apiLogger.warn({ msg: "cert-assignments:get-bad-recipient", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Provide registrationId OR speakerId" }, { status: 400 });
    }

    const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true } });
    if (!event) {
      apiLogger.warn({ msg: "cert-assignments:get-event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const lockedEventId = event.id;
    // tenancy: swept reads run inside the session org.
    const assigned = await runWithTenant(orgGuard.orgId, async () => {
      // The person must be this event's: an id from another event reads as "nothing assigned".
      const person = registrationId
        ? await db.registration.findFirst({ where: { id: registrationId, eventId: lockedEventId }, select: { id: true } })
        : await db.speaker.findFirst({ where: { id: speakerId!, eventId: lockedEventId }, select: { id: true } });
      if (!person) return null;
      const templates = await db.certificateTemplate.findMany({ where: { eventId: lockedEventId }, select: { id: true } });
      return loadAssignedTemplateIds(db, {
        templateIds: templates.map((t) => t.id),
        registrationId: registrationId ? person.id : null,
        speakerId: speakerId ? person.id : null,
      });
    });
    if (!assigned) {
      apiLogger.warn({ msg: "cert-assignments:get-person-not-found", eventId, userId: session.user.id, registrationId, speakerId });
      return NextResponse.json({ error: "Person not found" }, { status: 404 });
    }
    return NextResponse.json({
      templateIds: [...(registrationId ? assigned.registration : (assigned.speaker ?? []))],
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-assignments:get-failed", eventId });
    return NextResponse.json({ error: "Failed to load certificate assignments" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  try {
    const [session, p, rawBody] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    eventId = p.eventId;
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/certificates/assignments:POST" });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "certificates.templates.manage", { route: "events/[eventId]/certificates/assignments:POST", eventId });
    if (!gate.ok) return gate.response;
    const limited = rateLimited(session.user.id, eventId);
    if (limited) return limited;

    const parsed = assignSchema.safeParse(rawBody);
    if (!parsed.success) {
      apiLogger.warn({ msg: "cert-assignments:assign-invalid-input", eventId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const body = parsed.data;

    const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true, organizationId: true } });
    if (!event) {
      apiLogger.warn({ msg: "cert-assignments:assign-event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const userId = session.user.id;
    const mayReleaseNow = await mayReleaseCertificates(gate.principal, event.id, orgGuard.orgId);
    // tenancy: the swept reads and the service's transaction run inside the session org.
    const outcome = await runWithTenant(orgGuard.orgId, async () => {
      let registrationIds = body.registrationIds;
      let speakerIds = body.speakerIds;
      let unmatched: string[] = [];
      let cancelled: string[] = [];
      if (body.emails?.length) {
        const template = await db.certificateTemplate.findFirst({
          where: { id: body.templateId, eventId: event.id },
          select: { category: true },
        });
        if (!template) {
          return {
            result: { ok: false as const, code: "TEMPLATE_NOT_FOUND" as const, message: "Certificate template not found." },
            unmatched,
            cancelled,
          };
        }
        const resolved = await resolveAssignmentEmails({ eventId: event.id, category: template.category, emails: body.emails });
        ({ unmatched, cancelled } = resolved);
        registrationIds = resolved.registrationIds;
        speakerIds = resolved.speakerIds;
        if (registrationIds.length + speakerIds.length === 0) {
          // Nobody matched: an answer, not an error, so the page can show the list.
          return {
            result: {
              ok: true as const,
              templateName: "",
              assigned: 0,
              alreadyAssigned: 0,
              skipped: 0,
              sendNow: 0,
              sendNowPeople: 0,
              sendNowByTemplate: [],
              sendNowAllowed: mayReleaseNow,
              dryRun: body.dryRun === true,
            },
            unmatched,
            cancelled,
          };
        }
      }
      const result = await assignCertificate({
        eventId: event.id,
        organizationId: event.organizationId,
        templateId: body.templateId,
        registrationIds: registrationIds?.length ? registrationIds : undefined,
        speakerIds: speakerIds?.length ? speakerIds : undefined,
        userId,
        source: "rest",
        assignmentSource: body.emails?.length ? "EMAIL_LIST" : "MANUAL",
        confirmedSendNow: body.confirmSendNow,
        mayReleaseNow,
        dryRun: body.dryRun === true,
      });
      return { result, unmatched, cancelled };
    });

    const { result, unmatched, cancelled } = outcome;
    if (!result.ok) {
      if (result.code === "TEMPLATE_NOT_FOUND" && body.emails?.length) {
        apiLogger.warn({ msg: "cert-assignments:assign-template-not-found", eventId, userId, templateId: body.templateId });
      }
      // Every other rejection is logged with its code by the service.
      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.meta ?? {}), unmatched, cancelled },
        { status: ASSIGN_STATUS[result.code] ?? 400 },
      );
    }
    return NextResponse.json({ ...result, unmatched, cancelled });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-assignments:assign-failed", eventId });
    return NextResponse.json({ error: "Failed to assign the certificate" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  try {
    const [session, p, rawBody] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    eventId = p.eventId;
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/certificates/assignments:DELETE" });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "certificates.templates.manage", { route: "events/[eventId]/certificates/assignments:DELETE", eventId });
    if (!gate.ok) return gate.response;
    const limited = rateLimited(session.user.id, eventId);
    if (limited) return limited;

    const parsed = unassignSchema.safeParse(rawBody);
    if (!parsed.success) {
      apiLogger.warn({ msg: "cert-assignments:unassign-invalid-input", eventId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const body = parsed.data;

    const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true } });
    if (!event) {
      apiLogger.warn({ msg: "cert-assignments:unassign-event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const userId = session.user.id;
    // tenancy: the service's transaction runs inside the session org.
    const result = await runWithTenant(orgGuard.orgId, () =>
      unassignCertificate({
        eventId: event.id,
        templateId: body.templateId,
        registrationIds: body.registrationIds,
        speakerIds: body.speakerIds,
        userId,
        source: "rest",
      }),
    );
    if (!result.ok) {
      // Logged with its code by the service.
      return NextResponse.json(
        { error: result.message, code: result.code },
        { status: result.code === "TEMPLATE_NOT_FOUND" ? 404 : 400 },
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-assignments:unassign-failed", eventId });
    return NextResponse.json({ error: "Failed to remove the certificate assignment" }, { status: 500 });
  }
}
