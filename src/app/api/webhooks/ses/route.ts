import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { recordDeliveryEvent } from "@/lib/email-delivery";
import { isAmazonSnsUrl, parseSesEvent, readSnsMessage, regionOfTopicArn, verifySnsMessage } from "@/lib/ses-events";

/**
 * The mail service reports here on every email it accepted: delivered,
 * bounced, or marked as spam (Nov 19, 2026).
 *
 * Amazon SES publishes the reports to one SNS topic; SNS posts each to this
 * route. Three checks, in this order, and the door stays shut unless all pass:
 *
 *   1. The feature is switched on: `SES_EVENTS_TOPIC_ARN` names the topic.
 *      Unset (every machine but production), the route answers 503 and does
 *      nothing, so it is inert until the owner sets it.
 *   2. The message says it comes from THAT topic.
 *   3. The message is signed by Amazon (src/lib/ses-events.ts). A forged
 *      "bounced" report would put a false warning on a person's record, so
 *      nothing is believed without the signature.
 *
 * Lives under /api/webhooks/ because SNS calls it server to server with no
 * Origin header, which the middleware's same-site check refuses elsewhere.
 *
 * ANYONE CAN POST HERE, so until the signature has passed:
 *   - the body is read up to a fixed size and no further;
 *   - nothing the caller sent is written to the log beyond a short clip (the
 *     log table keeps whole lines and is never emptied);
 *   - an address that keeps being refused is answered 429 and no longer
 *     logged.
 *
 * WHAT SNS DOES WITH THE ANSWER (AWS, "Amazon SNS message delivery retries"):
 * it sends again only after a 5xx or a 429, by default three more times,
 * twenty seconds apart, and never after any other 4xx. So:
 *   - 200 for anything genuine that is dealt with, including a report about an
 *     email we have no record of;
 *   - 4xx for a message that is not genuine: final, and meant to be;
 *   - 503 for trouble that is OURS and may pass: the certificate could not be
 *     fetched, the write failed, or the report beat the email's own log row
 *     (the row is written just after the send, without waiting).
 */

/** SNS messages are at most 256 KB; the envelope adds a little. */
const MAX_BODY_BYTES = 400_000;
/** Refusals an address may collect in a minute before it is answered 429 unlogged. */
const REFUSALS_PER_MINUTE = 20;
/** Every post, genuine ones included. Far above what SNS sends from one address. */
const POSTS_PER_MINUTE = 3000;
/** A report this young for an email with no row yet is asked for again. */
const ROW_NOT_YET_WRITTEN_MS = 30_000;

export async function POST(req: Request) {
  const topicArn = process.env.SES_EVENTS_TOPIC_ARN;
  if (!topicArn) {
    warnNotConfiguredOnce();
    return NextResponse.json({ error: "Not configured", code: "NOT_CONFIGURED" }, { status: 503 });
  }

  const ip = getClientIp(req);
  if (!checkRateLimit({ key: `ses-events:${ip}`, limit: POSTS_PER_MINUTE, windowMs: 60_000 }).allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const raw = await readBody(req);
  if (raw === null) return refuse(ip, 413, "TOO_LARGE", { msg: "ses-events:body-too-large-or-unreadable" });

  const read = readSnsMessage(raw);
  if (!read.ok) return refuse(ip, 400, "BAD_MESSAGE", { msg: "ses-events:not-an-sns-message", reason: read.reason });
  const message = read.message;

  if (message.TopicArn !== topicArn) {
    return refuse(ip, 403, "WRONG_TOPIC", { msg: "ses-events:wrong-topic", topicArn: clip(message.TopicArn) });
  }

  const verified = await verifySnsMessage(message);
  if (!verified.ok && verified.retryable) {
    // Our trouble, not the message's: ask SNS to send it again.
    apiLogger.warn({ msg: "ses-events:certificate-unavailable", ip });
    return NextResponse.json({ error: "Try again", code: "CERTIFICATE_UNAVAILABLE" }, { status: 503 });
  }
  if (!verified.ok) {
    return refuse(ip, 403, "BAD_SIGNATURE", { msg: "ses-events:signature-refused", reason: verified.reason, type: clip(message.Type) });
  }

  if (message.Type === "SubscriptionConfirmation") return await confirmSubscription(message.SubscribeURL, message.TopicArn);

  if (message.Type !== "Notification") {
    // An UnsubscribeConfirmation: someone removed the subscription in AWS.
    // Reports stop arriving from here on, so it is worth a line.
    apiLogger.warn({ msg: "ses-events:unsubscribed", type: message.Type, topicArn: message.TopicArn });
    return NextResponse.json({ received: true });
  }

  const parsed = parseSesEvent(message.Message);
  if (!parsed.ok) {
    // Sends, delays and anything else the topic carries: seen, not kept.
    apiLogger.debug({ msg: "ses-events:ignored", reason: parsed.ignored });
    return NextResponse.json({ received: true, ignored: parsed.ignored });
  }

  try {
    const outcome = await recordDeliveryEvent(parsed.event);
    if (outcome === "unknown-message" && isTooYoungToGiveUpOn(parsed.event.mailAt)) {
      return NextResponse.json({ error: "Try again", code: "EMAIL_NOT_LOGGED_YET" }, { status: 503 });
    }
    return NextResponse.json({ received: true, outcome });
  } catch (err) {
    apiLogger.error({ err, msg: "ses-events:record-failed", kind: parsed.event.kind, messageId: parsed.event.messageId });
    return NextResponse.json({ error: "Failed to record the report" }, { status: 503 });
  }
}

/**
 * An email's log row is written just after the send, without waiting for it
 * (the send must never wait on the log). The mail service can report a bounce
 * of an address it already blocks almost at once, so the report can arrive
 * first. For the first half minute of an email's life an unknown message is
 * therefore "not yet", and SNS is asked to bring the report back.
 */
function isTooYoungToGiveUpOn(mailAt: Date | null): boolean {
  if (!mailAt) return false;
  const age = Date.now() - mailAt.getTime();
  return age >= 0 && age < ROW_NOT_YET_WRITTEN_MS;
}

/** At most this much of anything a caller sent goes into a log line. */
function clip(value: string): string {
  return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}

/**
 * One refusal of something that was not proven to be Amazon's. Logged while
 * the address is within its allowance; after that answered 429 and not logged,
 * so a stranger cannot fill the log by being refused.
 */
function refuse(ip: string, status: number, code: string, log: Record<string, unknown>) {
  const withinAllowance = checkRateLimit({ key: `ses-events-refused:${ip}`, limit: REFUSALS_PER_MINUTE, windowMs: 60_000 }).allowed;
  if (!withinAllowance) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  apiLogger.warn({ ...log, ip });
  return NextResponse.json({ error: status === 403 ? "Forbidden" : "Refused", code }, { status });
}

/** The body as text, or null when it is unreadable or longer than a genuine message can be. */
async function readBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      // A body with no declared length is stopped here, not read to the end.
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Said once per process, not once per post: while the feature is off anyone
 * can post here, and a line per post would let a stranger fill the log.
 */
const notConfigured = globalThis as unknown as { __eaSysSesEventsNotConfiguredWarned?: boolean };
function warnNotConfiguredOnce(): void {
  if (notConfigured.__eaSysSesEventsNotConfiguredWarned) return;
  notConfigured.__eaSysSesEventsNotConfiguredWarned = true;
  apiLogger.warn({ msg: "ses-events:not-configured" });
}

/**
 * SNS asks once, when the subscription is created, whether this address
 * agreed to receive the topic. Visiting the link it sends is the "yes". The
 * link must be Amazon's own, in the topic's region, or a forged confirmation
 * could make the server fetch any address it likes.
 */
async function confirmSubscription(subscribeUrl: string | undefined, topicArn: string) {
  if (!isAmazonSnsUrl(subscribeUrl, { region: regionOfTopicArn(topicArn) })) {
    apiLogger.warn({ msg: "ses-events:subscribe-link-not-amazon", topicArn });
    return NextResponse.json({ error: "Forbidden", code: "BAD_SUBSCRIBE_URL" }, { status: 403 });
  }
  try {
    const response = await fetch(subscribeUrl as string, { signal: AbortSignal.timeout(8000), redirect: "error" });
    if (!response.ok) {
      apiLogger.error({ msg: "ses-events:subscription-confirm-refused", status: response.status, topicArn });
      return NextResponse.json({ error: "Confirmation refused" }, { status: 502 });
    }
  } catch (err) {
    apiLogger.error({ err, msg: "ses-events:subscription-confirm-failed", topicArn });
    return NextResponse.json({ error: "Confirmation failed" }, { status: 502 });
  }
  apiLogger.info({ msg: "ses-events:subscription-confirmed", topicArn });
  return NextResponse.json({ received: true, subscribed: true });
}
