/**
 * What happened to an email, in the words staff see (Nov 19, 2026).
 *
 * `status` is what the app knew when it sent: SENT ("handed to the mail
 * service") or FAILED ("the service refused it"). `deliveryStatus` is what the
 * service reported afterwards (src/lib/email-delivery.ts). This turns the two
 * into ONE label, so no screen invents its own reading of them: the person's
 * Email History, the event's Email Activity and anything that comes later.
 *
 * No server imports: client components use it.
 */

export type EmailDeliveryStatus = "DELIVERED" | "BOUNCED" | "COMPLAINED";

export interface EmailOutcomeInput {
  status: "SENT" | "FAILED";
  deliveryStatus?: EmailDeliveryStatus | null;
  bounceType?: string | null;
  bounceSubType?: string | null;
  deliveryDetail?: string | null;
  errorMessage?: string | null;
}

export type EmailOutcomeTone = "neutral" | "good" | "warn" | "bad";

export interface EmailOutcome {
  label: "Sent" | "Failed" | "Delivered" | "Bounced" | "Bounced (temporary)" | "Marked as spam";
  tone: EmailOutcomeTone;
  /** One plain sentence on what it means, or null when the label says it all. */
  explanation: string | null;
}

/** The mail service's sub-types that deserve their own sentence. */
const TEMPORARY_REASONS: Record<string, string> = {
  MailboxFull: "The mailbox is full.",
  MessageTooLarge: "The email was too large for this mailbox.",
  ContentRejected: "The other mail server refused the content of the email.",
  AttachmentRejected: "The other mail server refused an attachment.",
};

function bounceExplanation(row: EmailOutcomeInput): string {
  if (row.bounceType === "Permanent") {
    if (row.bounceSubType === "OnAccountSuppressionList" || row.bounceSubType === "Suppressed") {
      return "This address bounced before, so the mail service did not send this email. Correct the address and send again.";
    }
    return "The address was rejected. Emails to it are not delivered until the address is corrected.";
  }
  const known = row.bounceSubType ? TEMPORARY_REASONS[row.bounceSubType] : undefined;
  return known ?? "A temporary failure at the other mail server. The address may work again later.";
}

export function emailOutcome(row: EmailOutcomeInput): EmailOutcome {
  if (row.status === "FAILED") return { label: "Failed", tone: "bad", explanation: row.errorMessage ?? null };
  if (row.deliveryStatus === "COMPLAINED") {
    return { label: "Marked as spam", tone: "bad", explanation: "The recipient marked this email as spam." };
  }
  if (row.deliveryStatus === "BOUNCED") {
    const permanent = row.bounceType === "Permanent";
    return { label: permanent ? "Bounced" : "Bounced (temporary)", tone: permanent ? "bad" : "warn", explanation: bounceExplanation(row) };
  }
  if (row.deliveryStatus === "DELIVERED") return { label: "Delivered", tone: "good", explanation: null };
  // SENT with no report: either the recorder was not on yet, or nothing has come back.
  return { label: "Sent", tone: "neutral", explanation: null };
}

export interface BouncedAddress {
  address: string;
  /** When the address STARTED bouncing: the first permanent bounce since it last worked. */
  since: string;
}

type HistoryRow = EmailOutcomeInput & { to: string; createdAt: string | Date; deliveryAt?: string | Date | null };

/**
 * Which addresses in this history are bouncing NOW: the newest email to the
 * address that the mail service reported on was a permanent bounce. A later
 * "delivered" clears it, so a corrected mailbox stops being flagged by itself.
 *
 * `since` is the start of the current run of bounces, not the latest one: an
 * address that bounced in October and was emailed three more times has been
 * unreachable since October, and that is the date staff need.
 *
 * `rows` may be in any order.
 */
export function bouncingAddresses(rows: HistoryRow[]): BouncedAddress[] {
  const byAddress = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    // Only emails the mail service reported on say anything about the address.
    if (row.status !== "SENT" || !row.deliveryStatus) continue;
    const address = row.to.trim().toLowerCase();
    const list = byAddress.get(address);
    if (list) list.push(row);
    else byAddress.set(address, [row]);
  }

  const isPermanent = (row: HistoryRow) => row.deliveryStatus === "BOUNCED" && row.bounceType === "Permanent";
  const bouncing: BouncedAddress[] = [];
  for (const [address, list] of byAddress) {
    const newestFirst = [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (!isPermanent(newestFirst[0])) continue;
    let first = newestFirst[0];
    for (const row of newestFirst) {
      if (!isPermanent(row)) break;
      first = row;
    }
    bouncing.push({ address, since: new Date(first.deliveryAt ?? first.createdAt).toISOString() });
  }
  return bouncing.sort((a, b) => a.address.localeCompare(b.address));
}
