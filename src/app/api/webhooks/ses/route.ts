import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
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
 * Answers: 200 for anything genuine, including a report about an email we
 * have no record of (SNS would otherwise retry it for an hour); 4xx for a
 * message that is not genuine; 500 only when the database write failed, so
 * SNS tries that one again.
 */
export async function POST(req: Request) {
  const topicArn = process.env.SES_EVENTS_TOPIC_ARN;
  if (!topicArn) {
    warnNotConfiguredOnce();
    return NextResponse.json({ error: "Not configured", code: "NOT_CONFIGURED" }, { status: 503 });
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch (err) {
    apiLogger.warn({ err, msg: "ses-events:unreadable-body" });
    return NextResponse.json({ error: "Unreadable body" }, { status: 400 });
  }

  const read = readSnsMessage(raw);
  if (!read.ok) {
    apiLogger.warn({ msg: "ses-events:not-an-sns-message", reason: read.reason });
    return NextResponse.json({ error: "Not an SNS message", code: "BAD_MESSAGE" }, { status: 400 });
  }
  const message = read.message;

  if (message.TopicArn !== topicArn) {
    apiLogger.warn({ msg: "ses-events:wrong-topic", topicArn: message.TopicArn });
    return NextResponse.json({ error: "Forbidden", code: "WRONG_TOPIC" }, { status: 403 });
  }

  const verified = await verifySnsMessage(message);
  if (!verified.ok) {
    apiLogger.warn({ msg: "ses-events:signature-refused", reason: verified.reason, type: message.Type });
    return NextResponse.json({ error: "Forbidden", code: "BAD_SIGNATURE" }, { status: 403 });
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
    return NextResponse.json({ received: true, outcome });
  } catch (err) {
    apiLogger.error({ err, msg: "ses-events:record-failed", kind: parsed.event.kind, messageId: parsed.event.messageId });
    return NextResponse.json({ error: "Failed to record the report" }, { status: 500 });
  }
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
 * link must be Amazon's own, or a forged confirmation could make the server
 * fetch any address it likes.
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
