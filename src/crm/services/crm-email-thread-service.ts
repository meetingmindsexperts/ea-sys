/**
 * CRM email threads — the data layer behind the CRM inbox. SERVER ONLY.
 *
 * A thread = one conversation with one external person. Minted on every CRM
 * outbound send; the thread's unique `replyToken` becomes the tokenized
 * Reply-To local part (`<token>@$CRM_REPLY_DOMAIN`), so an inbound reply
 * resolves to its thread exactly — no fuzzy address matching.
 *
 * DORMANT WITHOUT ENV: when `CRM_REPLY_DOMAIN` is unset, outbound sends carry
 * no tokenized Reply-To (current behavior unchanged) but thread + message rows
 * are STILL recorded — the inbox is useful as sent-history from day one, and
 * replies start threading the moment the env + SES receiving land.
 *
 * `recordOutboundEmail` NEVER throws: the email already left when it runs, so
 * a bookkeeping failure must not turn a delivered send into a reported error.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/** Rolling token window (review M1) — kept in sync with the inbound worker. A
 *  thread's token expires this long after its last message; every send/reply
 *  rolls it forward, so an active conversation never lapses. */
const TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** The subdomain inbound replies route to (e.g. "reply.meetingmindsdubai.com"). */
export function crmReplyDomain(): string | null {
  const d = process.env.CRM_REPLY_DOMAIN?.trim();
  return d || null;
}

/**
 * 20 hex chars (~80 bits) — unguessable, safe as an email local part.
 * globalThis.crypto (not node:crypto) per the no-Node-imports-near-client rule.
 */
export function mintReplyToken(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

/** Tokenized Reply-To address, or null while the feature is dormant. */
export function crmReplyAddress(token: string): string | null {
  const domain = crmReplyDomain();
  return domain ? `${token}@${domain}` : null;
}

/** Lowercase + trim + dedupe an address list, dropping empties. */
function dedupeLower(list: string[] | undefined): string[] {
  if (!list?.length) return [];
  const seen = new Set<string>();
  for (const raw of list) {
    const e = raw.trim().toLowerCase();
    if (e) seen.add(e);
  }
  return [...seen];
}

export interface RecordOutboundEmailInput {
  organizationId: string;
  /** Null for event-wide blasts where the recipient spans deals. */
  dealId: string | null;
  crmContactId: string | null;
  counterpartyEmail: string;
  counterpartyName: string | null;
  subject: string;
  htmlBody: string;
  textBody: string | null;
  replyToken: string;
  /** SES/provider message id, when the send returned one. */
  providerMessageId: string | null;
  sentByUserId: string | null;
  /** The org sender address the email went out under. */
  fromEmail: string;
  fromName: string | null;
  /**
   * Internal addresses (this send's CC + BCC, incl. the sender's own copy) to
   * forward-copy inbound replies to. Stored on a NEW thread only; the reply
   * partnerships address + deal owner are added by the worker at forward time.
   */
  notifyEmails?: string[];
  /** Append to an existing thread (the inbox reply composer) instead of minting. */
  threadId?: string;
}

/**
 * Record an outbound send as thread + message. New send → new thread carrying
 * the minted token; reply-from-inbox → append to the (org-bound) thread.
 */
export async function recordOutboundEmail(input: RecordOutboundEmailInput): Promise<void> {
  try {
    const messageData = {
      organizationId: input.organizationId,
      direction: "OUTBOUND" as const,
      fromEmail: input.fromEmail,
      fromName: input.fromName,
      subject: input.subject,
      htmlBody: input.htmlBody,
      textBody: input.textBody,
      providerMessageId: input.providerMessageId,
      sentByUserId: input.sentByUserId,
    };

    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

    if (input.threadId) {
      // Org-bound append — a foreign threadId records nothing. Sending also
      // rolls the token window forward (review M1) and un-nothing else.
      const updated = await db.crmEmailThread.updateMany({
        where: { id: input.threadId, organizationId: input.organizationId },
        data: { lastMessageAt: now, expiresAt },
      });
      if (updated.count === 0) {
        apiLogger.warn({
          msg: "crm-email-thread:append-thread-not-found",
          threadId: input.threadId,
          organizationId: input.organizationId,
        });
        return;
      }
      await db.crmEmailMessage.create({
        data: { ...messageData, threadId: input.threadId },
      });
      return;
    }

    await db.crmEmailThread.create({
      data: {
        organizationId: input.organizationId,
        dealId: input.dealId,
        crmContactId: input.crmContactId,
        subject: input.subject,
        replyToken: input.replyToken,
        counterpartyEmail: input.counterpartyEmail.toLowerCase(),
        counterpartyName: input.counterpartyName,
        notifyEmails: dedupeLower(input.notifyEmails),
        expiresAt,
        messages: { create: messageData },
      },
    });
  } catch (err) {
    // The email is already delivered — bookkeeping failure logs, never surfaces.
    apiLogger.error({
      msg: "crm-email-thread:record-outbound-failed",
      organizationId: input.organizationId,
      dealId: input.dealId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
