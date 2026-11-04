/**
 * The ID and document request (Nov 4, 2026; src/lib/evidence-request.ts):
 * email each chosen person their own link to add what their registration type
 * requires and their registration does not hold yet.
 *
 * Same shape as registration-form-service's send: the route does auth, the
 * limit and HTTP; this checks each person, mints the link and sends, and says
 * why anyone was skipped. A link whose email failed is revoked, so no live
 * link exists that nobody received.
 */
import crypto from "crypto";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { hashVerificationToken } from "@/lib/security";
import { DAY_MS } from "@/lib/link-expiry";
import { formatDateInTz, resolveTimezone } from "@/lib/event-time";
import { IDENTITY_EVIDENCE_SELECT } from "@/lib/identity-evidence";
import { SUPPORTING_DOCUMENT_POLICY_SELECT } from "@/lib/supporting-document";
import { asksForEvidence, evidenceFieldLabel, missingEvidenceFields } from "@/lib/type-evidence";
import {
  evidenceRequestIdentifier,
  evidenceRequestPath,
  type EvidenceRequestSkipReason,
} from "@/lib/evidence-request";
import { brandingFrom, getEventTemplate, renderAndWrap, sendEmail } from "@/lib/email";

export interface EvidenceRequestSkip {
  registrationId: string;
  reason: EvidenceRequestSkipReason;
}

export interface SendEvidenceRequestsInput {
  eventId: string;
  organizationId: string;
  registrationIds: string[];
  expiryDays: number;
  appUrl: string;
  actorUserId: string;
  organizerName?: string;
  organizerSignature?: string;
}

export type SendEvidenceRequestsResult =
  | { ok: true; sent: number; skipped: EvidenceRequestSkip[]; errors: string[] }
  | { ok: false; code: "EVENT_NOT_FOUND" | "TEMPLATE_MISSING"; message: string };

/** One person's link. Replaces their earlier request link, so only the newest works. */
export async function mintEvidenceRequestLink(input: {
  registrationId: string;
  eventSlug: string;
  expiryDays: number;
  appUrl: string;
}): Promise<{ url: string; expires: Date }> {
  const identifier = evidenceRequestIdentifier(input.registrationId);
  await db.verificationToken.deleteMany({ where: { identifier } });
  const rawToken = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + input.expiryDays * DAY_MS);
  await db.verificationToken.create({
    data: { identifier, token: hashVerificationToken(rawToken), expires },
  });
  return { url: `${input.appUrl}${evidenceRequestPath(input.eventSlug, rawToken)}`, expires };
}

/** Removes a person's request link, e.g. after their email failed to send. */
export async function revokeEvidenceRequestLink(registrationId: string): Promise<void> {
  await db.verificationToken.deleteMany({ where: { identifier: evidenceRequestIdentifier(registrationId) } });
}

/** The Request ID and document button: check, link and email each person. */
export async function sendEvidenceRequests(input: SendEvidenceRequestsInput): Promise<SendEvidenceRequestsResult> {
  const event = await db.event.findFirst({
    where: { id: input.eventId, organizationId: input.organizationId },
    select: { id: true, slug: true, timezone: true },
  });
  if (!event) return { ok: false, code: "EVENT_NOT_FOUND", message: "Event not found" };

  const template = await getEventTemplate(input.eventId, "evidence-request");
  if (!template) {
    apiLogger.error({ msg: "evidence-request:template-missing", eventId: input.eventId });
    return { ok: false, code: "TEMPLATE_MISSING", message: "The ID and document request email template is missing." };
  }

  const rows = await db.registration.findMany({
    where: { id: { in: input.registrationIds }, eventId: input.eventId },
    select: {
      id: true,
      status: true,
      supportingDocumentUrl: true,
      ticketType: { select: { name: true, ...IDENTITY_EVIDENCE_SELECT, ...SUPPORTING_DOCUMENT_POLICY_SELECT } },
      attendee: {
        select: { title: true, firstName: true, lastName: true, email: true, memberId: true, studentId: true, studentIdExpiry: true },
      },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const timezone = resolveTimezone(event.timezone);

  const skipped: EvidenceRequestSkip[] = [];
  const errors: string[] = [];
  let sent = 0;
  for (const registrationId of input.registrationIds) {
    const reg = byId.get(registrationId);
    const reason = skipReason(reg);
    if (reason || !reg) {
      skipped.push({ registrationId, reason: reason ?? "NOT_FOUND" });
      continue;
    }
    const missing = missingEvidenceFields(reg.ticketType, {
      memberId: reg.attendee.memberId,
      studentId: reg.attendee.studentId,
      studentIdExpiry: reg.attendee.studentIdExpiry,
      supportingDocumentUrl: reg.supportingDocumentUrl,
    });
    try {
      const { url, expires } = await mintEvidenceRequestLink({
        registrationId,
        eventSlug: event.slug,
        expiryDays: input.expiryDays,
        appUrl: input.appUrl,
      });
      const vars = {
        title: reg.attendee.title ? `${reg.attendee.title}.` : "",
        firstName: reg.attendee.firstName,
        lastName: reg.attendee.lastName,
        ticketType: reg.ticketType?.name ?? "",
        evidenceLink: url,
        evidenceItems: missing.map((f) => evidenceFieldLabel(f, reg.ticketType)).join(", "),
        linkExpiresIn: input.expiryDays === 1 ? "1 day" : `${input.expiryDays} days`,
        linkExpiresOn: formatDateInTz(expires, timezone),
        organizerName: input.organizerName ?? "",
        organizerSignature: input.organizerSignature ?? "",
      };
      const rendered = renderAndWrap(template, vars, template.branding);
      const result = await sendEmail({
        to: [{ email: reg.attendee.email, name: `${reg.attendee.firstName} ${reg.attendee.lastName}` }],
        subject: rendered.subject,
        htmlContent: rendered.htmlContent,
        textContent: rendered.textContent,
        from: brandingFrom(template.branding),
        emailType: "evidence_request",
        stream: "bulk",
        logContext: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          entityType: "REGISTRATION",
          entityId: registrationId,
          templateSlug: "evidence-request",
          triggeredByUserId: input.actorUserId,
        },
      });
      if (result.success) {
        sent++;
        continue;
      }
      await revokeEvidenceRequestLink(registrationId);
      apiLogger.warn({ msg: "evidence-request:send-failed", registrationId, error: result.error });
      errors.push(`${reg.attendee.email}: failed to deliver email (${result.error || "provider rejected"})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      apiLogger.error({ msg: "evidence-request:send-error", registrationId, err: message });
      await revokeEvidenceRequestLink(registrationId).catch((revokeErr) =>
        apiLogger.error({ msg: "evidence-request:revoke-failed", registrationId, err: revokeErr }),
      );
      errors.push(`${reg.attendee.email}: ${message}`);
    }
  }

  apiLogger.info({
    msg: "evidence-request:sent",
    eventId: input.eventId,
    expiryDays: input.expiryDays,
    sent,
    skipped: skipped.length,
    skippedReasons: skipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] ?? 0) + 1 }), {}),
    errors: errors.length,
  });
  return { ok: true, sent, skipped, errors };
}

type RequestRow = {
  status: string;
  supportingDocumentUrl: string | null;
  ticketType: Parameters<typeof missingEvidenceFields>[0];
  attendee: { memberId: string | null; studentId: string | null; studentIdExpiry: Date | null };
};

function skipReason(reg: RequestRow | undefined): EvidenceRequestSkipReason | null {
  if (!reg) return "NOT_FOUND";
  if (reg.status === "CANCELLED") return "CANCELLED";
  if (!asksForEvidence(reg.ticketType)) return "NOTHING_ASKED";
  const missing = missingEvidenceFields(reg.ticketType, {
    memberId: reg.attendee.memberId,
    studentId: reg.attendee.studentId,
    studentIdExpiry: reg.attendee.studentIdExpiry,
    supportingDocumentUrl: reg.supportingDocumentUrl,
  });
  return missing.length === 0 ? "NOTHING_MISSING" : null;
}
