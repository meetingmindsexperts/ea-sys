/**
 * Certificate bulk-send engine — the `emailType: "certificate"` branch of
 * executeBulkEmail (Communications → bulk email → select recipients →
 * select certificate template(s)).
 *
 * Per recipient (batches of 25, failure-isolated like the speaker-agreement
 * per-recipient attachments):
 *   1. Resolve the PERSON's two facets — the anchored registration/speaker
 *      plus its linked counterpart (companion pointer, else email match) —
 *      so one email can bundle an ATTENDANCE cert (registration) with an
 *      APPRECIATION cert (linked speaker).
 *   2. TAG-FILTER the selected templates: a recipient only receives the
 *      certs whose template tag they hold (the template's stored tag is the
 *      single source of truth — same rule as survey auto-issue). Zero
 *      matches → SKIPPED (counted in skippedCount, warn-logged, never a
 *      failure) — the audience may legitimately be ALL registrations with
 *      the tags deciding who receives what ("no tag, no certificate").
 *   3. findOrIssueCertificate per matching template — real IssuedCertificate
 *      records (serial, audit, resendable); an already-issued template
 *      reuses the existing cert/PDF instead of minting a duplicate.
 *   4. ONE email with every materialized PDF attached.
 *
 * Layering: called BY bulk-email.ts with pre-validated LoadedCertTemplate[]
 * (bulk-email owns the BulkEmailError-shaped hoisted guards) — this module
 * never imports bulk-email, so there is no cycle. Returns the structural
 * BulkEmailResult shape.
 */

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  findOrIssueCertificate,
  sendCertificateBundleEmail,
  loadBundleEmailEvent,
  type BundleCert,
  type LoadedCertTemplate,
} from "./bundle";
import { selectAutoIssueTargets } from "./auto-issue";
import { formatRecipientName } from "./cert-context";
import {
  SYSTEM_DEFAULT_SUBJECT,
  SYSTEM_DEFAULT_SUBJECT_MULTI,
  SYSTEM_DEFAULT_BODY_MULTI,
  defaultBodyForCategory,
} from "./email-tokens";
import { resolveLinkedRegistration, resolveLinkedSpeaker } from "@/lib/activity-feed";

const BATCH_SIZE = 25;

export interface CertificateBulkRecipient {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  title?: string | null;
}

export interface CertificateBulkSendInput {
  eventId: string;
  recipientType: "registrations" | "speakers";
  recipients: CertificateBulkRecipient[];
  /** Pre-validated by the caller: all belong to the event, all tagged. */
  templates: LoadedCertTemplate[];
  customSubject?: string;
  customMessage?: string;
  organizationId?: string | null;
  triggeredByUserId?: string | null;
}

interface PersonFacets {
  registrationId: string | null;
  speakerId: string | null;
  attendeeTags: string[];
  speakerTags: string[] | null;
}

/** Resolve both facets (+ their tags) of the person behind a recipient row. */
async function resolvePersonFacets(
  eventId: string,
  recipientType: "registrations" | "speakers",
  recipientId: string,
): Promise<PersonFacets | null> {
  if (recipientType === "registrations") {
    const reg = await db.registration.findUnique({
      where: { id: recipientId },
      select: { attendee: { select: { tags: true, email: true } } },
    });
    if (!reg) return null;
    const linked = await resolveLinkedSpeaker(eventId, {
      id: recipientId,
      attendeeEmail: reg.attendee.email,
    });
    const speaker = linked
      ? await db.speaker.findUnique({ where: { id: linked.id }, select: { tags: true } })
      : null;
    return {
      registrationId: recipientId,
      speakerId: linked?.id ?? null,
      attendeeTags: reg.attendee.tags,
      speakerTags: speaker?.tags ?? null,
    };
  }

  const spk = await db.speaker.findUnique({
    where: { id: recipientId },
    select: { tags: true, email: true, sourceRegistrationId: true },
  });
  if (!spk) return null;
  const linked = await resolveLinkedRegistration(eventId, spk);
  const reg = linked
    ? await db.registration.findUnique({
        where: { id: linked.id },
        select: { attendee: { select: { tags: true } } },
      })
    : null;
  return {
    registrationId: linked?.id ?? null,
    speakerId: recipientId,
    attendeeTags: reg?.attendee.tags ?? [],
    speakerTags: spk.tags,
  };
}

/** Cover email for one recipient's bundle: custom override → single
 *  template's saved cover email → category/multi system default. */
function coverEmailFor(
  bundled: Array<{ template: LoadedCertTemplate }>,
  customSubject?: string,
  customMessage?: string,
): { subject: string; body: string } {
  let subject: string;
  let body: string;
  if (bundled.length === 1) {
    const t = bundled[0].template;
    subject = t.emailSubject?.trim().length ? t.emailSubject : SYSTEM_DEFAULT_SUBJECT;
    body = t.emailBody?.trim().length ? t.emailBody : defaultBodyForCategory(t.category);
  } else {
    subject = SYSTEM_DEFAULT_SUBJECT_MULTI;
    body = SYSTEM_DEFAULT_BODY_MULTI;
  }
  if (customSubject?.trim().length) subject = customSubject;
  if (customMessage?.trim().length) body = customMessage;
  return { subject, body };
}

export async function executeCertificateBulkSend(input: CertificateBulkSendInput): Promise<{
  total: number;
  successCount: number;
  failureCount: number;
  /** Recipients holding NONE of the selected templates' tags — not emailed
   *  by design ("no tag, no certificate"), so neither success nor failure. */
  skippedCount: number;
  errors: Array<{ email: string; error: string }>;
}> {
  const {
    eventId,
    recipientType,
    recipients,
    templates,
    customSubject,
    customMessage,
    organizationId,
    triggeredByUserId,
  } = input;

  const event = await loadBundleEmailEvent(eventId);
  if (!event) {
    // The caller already verified the event exists — this is a mid-send
    // deletion race. Fail the whole batch rather than emailing per-recipient.
    apiLogger.error({ msg: "cert-bulk:event-vanished", eventId });
    return {
      total: recipients.length,
      successCount: 0,
      failureCount: recipients.length,
      skippedCount: 0,
      errors: recipients.map((r) => ({ email: r.email, error: "Event not found" })),
    };
  }

  const templatesById = new Map(templates.map((t) => [t.id, t]));
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;
  const errors: Array<{ email: string; error: string }> = [];

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (recipient) => {
        try {
          return await processRecipient(recipient);
        } catch (error) {
          apiLogger.error({
            err: error,
            msg: "cert-bulk:recipient-failed",
            eventId,
            recipientId: recipient.id,
            email: recipient.email,
          });
          return {
            ok: false as const,
            error: error instanceof Error ? error.message : "Failed to issue certificates",
          };
        }
      }),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      // The inner try/catch means allSettled entries are always fulfilled;
      // the rejected branch is a belt-and-braces guard.
      const outcome = r.status === "fulfilled" ? r.value : { ok: false as const, error: "Unexpected failure" };
      if (outcome.ok) {
        successCount++;
      } else if (outcome.skipped) {
        skippedCount++;
      } else {
        failureCount++;
        errors.push({ email: batch[j].email, error: outcome.error ?? "Unexpected failure" });
      }
    }
  }

  apiLogger.info({
    msg: "cert-bulk:completed",
    eventId,
    recipientType,
    templateIds: templates.map((t) => t.id),
    total: recipients.length,
    successCount,
    failureCount,
    skippedCount,
  });
  return { total: recipients.length, successCount, failureCount, skippedCount, errors };

  async function processRecipient(
    recipient: CertificateBulkRecipient,
  ): Promise<{ ok: true } | { ok: false; skipped?: boolean; error?: string }> {
    if (!recipient.email) {
      return { ok: false, error: "Recipient has no email address" };
    }
    const facets = await resolvePersonFacets(eventId, recipientType, recipient.id);
    if (!facets) {
      return { ok: false, error: "Recipient no longer exists" };
    }

    // The template's stored tag decides who gets which cert — same routing
    // predicate as survey auto-issue (ATTENDANCE ↔ attendee tags,
    // APPRECIATION ↔ linked speaker tags).
    const targets = selectAutoIssueTargets(templates, facets.attendeeTags, facets.speakerTags);
    if (targets.length === 0) {
      // "No tag, no certificate" is the routing rule, not a delivery
      // failure — the audience may legitimately be ALL registrations with
      // the tags deciding who receives what. Count as skipped (still
      // warn-logged per recipient so the routing is auditable in /logs).
      apiLogger.warn({
        msg: "cert-bulk:no-applicable-certs",
        eventId,
        recipientId: recipient.id,
        attendeeTags: facets.attendeeTags,
        speakerTags: facets.speakerTags,
        templateIds: templates.map((t) => t.id),
      });
      return { ok: false, skipped: true };
    }

    const bundled: Array<{ template: LoadedCertTemplate; cert: BundleCert }> = [];
    const templateFailures: string[] = [];
    for (const target of targets) {
      const template = templatesById.get(target.templateId);
      if (!template) continue;
      const res = await findOrIssueCertificate({
        eventId,
        templateId: target.templateId,
        registrationId: facets.registrationId,
        speakerId: facets.speakerId,
        issuedByUserId: triggeredByUserId ?? null,
        template,
      });
      if (!res.ok) {
        templateFailures.push(`${template.name}: ${res.error}`);
        continue;
      }
      bundled.push({ template, cert: res.cert });
      if (!res.cert.reused) {
        db.auditLog
          .create({
            data: {
              eventId,
              userId: triggeredByUserId ?? null,
              action: "CERT_ISSUED",
              entityType: "IssuedCertificate",
              entityId: res.cert.certificateId,
              changes: {
                source: "bulk-email",
                serial: res.cert.serial,
                templateId: template.id,
              } as Prisma.InputJsonValue,
            },
          })
          .catch((err) =>
            apiLogger.warn({ err, msg: "cert-bulk:audit-failed", certificateId: res.cert.certificateId }),
          );
      }
    }

    if (bundled.length === 0) {
      return { ok: false, error: `Certificates could not be issued — ${templateFailures.join("; ")}` };
    }

    const cover = coverEmailFor(bundled, customSubject, customMessage);
    const send = await sendCertificateBundleEmail({
      eventId,
      organizationId: organizationId ?? null,
      recipientEmail: recipient.email,
      recipientName: formatRecipientName(recipient.title ?? null, recipient.firstName, recipient.lastName),
      registrationId: facets.registrationId,
      speakerId: facets.speakerId,
      certs: bundled.map((b) => ({
        serial: b.cert.serial,
        type: b.cert.type,
        templateName: b.cert.templateName,
        pdfBuffer: b.cert.pdfBuffer,
      })),
      emailSubjectTemplate: cover.subject,
      emailBodyTemplate: cover.body,
      triggeredByUserId: triggeredByUserId ?? null,
      event,
    });
    if (!send.success) {
      return { ok: false, error: send.error ?? "Email send failed" };
    }

    // Partial template failure with a successful send: the recipient DID get
    // an email (with the certs that applied), so they count as a success —
    // but the miss is operationally important, so it lands in /logs at warn.
    if (templateFailures.length > 0) {
      apiLogger.warn({
        msg: "cert-bulk:partial-templates-failed",
        eventId,
        recipientId: recipient.id,
        email: recipient.email,
        sentCount: bundled.length,
        failures: templateFailures,
      });
    }
    return { ok: true };
  }
}
