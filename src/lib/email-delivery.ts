/**
 * Writes the mail service's report onto the email it is about (Nov 19, 2026).
 *
 * THE ONE WRITER of `EmailLog.deliveryStatus` and the four columns beside it.
 * Called only by `POST /api/webhooks/ses`, after the message was proven to be
 * Amazon's (src/lib/ses-events.ts).
 *
 * WHY THE PRIVILEGED CLIENT. A report names an email by the mail service's
 * message id and nothing else: no organisation, no event. The lookup is
 * therefore across every organisation by construction, the same shape as the
 * CRM's reply-token lookup ("the tenant is the ANSWER"). Only that one read is
 * privileged; the write runs in the lane of the organisation the row turned
 * out to belong to. A row with no organisation (an email to an account that
 * has none) is invisible to every lane, so its write stays privileged too.
 *
 * A report about a COPIED address (cc / bcc) changes nothing on the row: the
 * columns describe the person the email was for. It is logged, because a
 * colleague's dead mailbox is still worth knowing about.
 */
import { db, dbOperator } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { bareAddress, shouldReplaceDelivery, type DeliveryKind, type SesDeliveryEvent } from "@/lib/ses-events";

export type DeliveryRecordOutcome =
  /** The row now carries this report. */
  | "recorded"
  /** The row already said this, or something a later report must not undo. */
  | "unchanged"
  /** The report is about a copied address only. */
  | "copy-only"
  /** No email on record has this message id (an alert email, or one sent by another system). */
  | "unknown-message";

/** The addresses an email log row's `to` holds, lower-cased. */
function primaryAddresses(to: string): string[] {
  return to
    .split(/[,;]/)
    .map((part) => bareAddress(part))
    .filter((part) => part !== "");
}

export async function recordDeliveryEvent(event: SesDeliveryEvent): Promise<DeliveryRecordOutcome> {
  const row = await dbOperator.emailLog.findFirst({
    where: { providerMessageId: event.messageId },
    select: {
      id: true,
      organizationId: true,
      eventId: true,
      to: true,
      templateSlug: true,
      deliveryStatus: true,
      bounceType: true,
    },
  });

  if (!row) {
    // Expected for the app's own alert emails, which are sent without a log
    // row, so this is not a warning.
    apiLogger.info({ msg: "email-delivery:unknown-message", kind: event.kind, messageId: event.messageId });
    return "unknown-message";
  }

  const primary = primaryAddresses(row.to);
  const aboutPrimary = event.recipients.length === 0 || event.recipients.some((address) => primary.includes(address));
  if (!aboutPrimary) {
    const log = event.kind === "DELIVERED" ? apiLogger.debug.bind(apiLogger) : apiLogger.warn.bind(apiLogger);
    log({
      msg: "email-delivery:copy-recipient",
      kind: event.kind,
      emailLogId: row.id,
      eventId: row.eventId,
      recipients: event.recipients,
      bounceType: event.bounceType,
      bounceSubType: event.bounceSubType,
    });
    return "copy-only";
  }

  const current = { deliveryStatus: row.deliveryStatus as DeliveryKind | null, bounceType: row.bounceType };
  if (!shouldReplaceDelivery(current, event)) return "unchanged";

  const data = {
    deliveryStatus: event.kind,
    deliveryAt: event.at,
    bounceType: event.bounceType,
    bounceSubType: event.bounceSubType,
    deliveryDetail: event.detail,
  };
  if (row.organizationId) {
    const organizationId = row.organizationId;
    await runWithTenant(organizationId, async () => await db.emailLog.update({ where: { id: row.id, organizationId }, data }));
  } else {
    // `updateMany`, as the writer of these rows uses `createMany`: under row
    // security an org-less row cannot be read back by the statement that
    // wrote it, and nothing here needs it back.
    await dbOperator.emailLog.updateMany({ where: { id: row.id, organizationId: null }, data });
  }

  const facts = {
    emailLogId: row.id,
    eventId: row.eventId,
    organizationId: row.organizationId,
    templateSlug: row.templateSlug,
    to: row.to,
    bounceType: event.bounceType,
    bounceSubType: event.bounceSubType,
  };
  if (event.kind === "COMPLAINED") {
    // Error level on purpose: a spam complaint is rare and counts against the
    // whole account's sending, so the owner hears about each one.
    apiLogger.error({ msg: "email-delivery:complaint", ...facts, detail: event.detail });
  } else if (event.kind === "BOUNCED") {
    apiLogger.warn({ msg: "email-delivery:bounced", ...facts, detail: event.detail });
  }
  return "recorded";
}
