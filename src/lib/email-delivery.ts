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

export async function recordDeliveryEvent(event: SesDeliveryEvent, attempt = 1): Promise<DeliveryRecordOutcome> {
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
      bounceSubType: true,
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
    logCopyRecipient(event, row);
    return "copy-only";
  }

  const current = { deliveryStatus: row.deliveryStatus as DeliveryKind | null, bounceType: row.bounceType, bounceSubType: row.bounceSubType };
  if (!shouldReplaceDelivery(current, event)) return "unchanged";

  const data = {
    deliveryStatus: event.kind,
    deliveryAt: event.at,
    bounceType: event.bounceType,
    bounceSubType: event.bounceSubType,
    deliveryDetail: detailForPrimary(event, primary),
  };
  // The write names what was READ, so two reports for one email landing
  // together cannot both win: the slower one matches nothing and is judged
  // again against what the faster one wrote.
  const unchangedSinceRead = { deliveryStatus: row.deliveryStatus, bounceType: row.bounceType, bounceSubType: row.bounceSubType };
  let written: { count: number };
  if (row.organizationId) {
    const organizationId = row.organizationId;
    written = await runWithTenant(
      organizationId,
      async () => await db.emailLog.updateMany({ where: { id: row.id, organizationId, ...unchangedSinceRead }, data }),
    );
  } else {
    // Under row security an org-less row is invisible to every lane, so its
    // write stays on the privileged client.
    written = await dbOperator.emailLog.updateMany({ where: { id: row.id, organizationId: null, ...unchangedSinceRead }, data });
  }
  if (written.count === 0) {
    if (attempt >= 3) {
      apiLogger.warn({ msg: "email-delivery:lost-race", emailLogId: row.id, kind: event.kind });
      return "unchanged";
    }
    return await recordDeliveryEvent(event, attempt + 1);
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
    apiLogger.error({ msg: "email-delivery:complaint", ...facts, detail: data.deliveryDetail });
  } else if (event.kind === "BOUNCED") {
    apiLogger.warn({ msg: "email-delivery:bounced", ...facts, detail: data.deliveryDetail });
  }
  return "recorded";
}

/**
 * The words kept on the row. For a bounce, only what the other server said
 * about the person the email was for: that text usually names the address, and
 * a copied address (a Bcc above all) is hidden from viewers who may not see
 * copies.
 */
function detailForPrimary(event: SesDeliveryEvent, primary: string[]): string | null {
  if (event.kind !== "BOUNCED") return event.detail;
  const words = event.recipientDetails.filter((r) => primary.includes(r.address)).map((r) => r.detail);
  return [...new Set(words)].join(" | ") || null;
}

/** A report about a copied address only: the row is left alone, the log is not. */
function logCopyRecipient(event: SesDeliveryEvent, row: { id: string; eventId: string | null }): void {
  const facts = {
    kind: event.kind,
    emailLogId: row.id,
    eventId: row.eventId,
    recipients: event.recipients,
    bounceType: event.bounceType,
    bounceSubType: event.bounceSubType,
  };
  if (event.kind === "DELIVERED") {
    apiLogger.debug({ msg: "email-delivery:copy-recipient", ...facts });
  } else if (event.kind === "COMPLAINED") {
    // A complaint counts against the account whoever made it.
    apiLogger.error({ msg: "email-delivery:complaint", ...facts, copyRecipient: true, detail: event.detail });
  } else {
    apiLogger.warn({ msg: "email-delivery:copy-recipient", ...facts });
  }
}
