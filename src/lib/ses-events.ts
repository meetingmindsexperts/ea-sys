/**
 * The mail service's reports on an email it accepted: delivered, bounced, or
 * marked as spam (Nov 19, 2026).
 *
 * Amazon SES publishes these as "events" to an SNS topic, and SNS posts each
 * one to `POST /api/webhooks/ses`. This module is the two pure halves of that
 * door, with no database and no Next.js in it:
 *
 *   1. `verifySnsMessage`: is this post really from Amazon? Anyone on the
 *      internet can post to a webhook, and a forged "bounced" report would put
 *      a false warning on a person's record. SNS signs every message with a
 *      certificate it publishes, so the door trusts the signature and nothing
 *      else: not the sender's IP, not a secret in the URL.
 *   2. `parseSesEvent`: turn the report into the few facts the app keeps.
 *
 * Why the certificate's ADDRESS is checked before it is fetched: the message
 * itself says where its certificate is. A forger would point that at a
 * certificate of their own and sign with it, so only Amazon's own SNS hosts are
 * accepted, over https.
 */
import { X509Certificate, createVerify, type KeyObject } from "node:crypto";

/** The envelope SNS posts. Every field is a string in SNS's JSON. */
export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
}

const REQUIRED_FIELDS = [
  "Type",
  "MessageId",
  "TopicArn",
  "Message",
  "Timestamp",
  "SignatureVersion",
  "Signature",
  "SigningCertURL",
] as const;

/** Reads the posted text as an SNS envelope, or says what is wrong with it. */
export function readSnsMessage(raw: string): { ok: true; message: SnsMessage } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "not-an-object" };
  const record = parsed as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (typeof record[field] !== "string" || record[field] === "") return { ok: false, reason: `missing-${field}` };
  }
  for (const field of ["Subject", "Token", "SubscribeURL"] as const) {
    if (record[field] !== undefined && record[field] !== null && typeof record[field] !== "string") {
      return { ok: false, reason: `bad-${field}` };
    }
  }
  return { ok: true, message: record as unknown as SnsMessage };
}

/** Amazon's own SNS hosts, in any region: `sns.ap-south-1.amazonaws.com`. */
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/** The region inside a topic's ARN (`arn:aws:sns:ap-south-1:123:name`), or null. */
export function regionOfTopicArn(topicArn: string): string | null {
  const parts = topicArn.split(":");
  return parts.length >= 6 && parts[0] === "arn" && parts[2] === "sns" && parts[3] ? parts[3] : null;
}

/**
 * SNS's signing certificates live at exactly this kind of path. The same host
 * is also the SNS API, which answers queries with text the caller chose, so a
 * certificate address is accepted only in this shape and with no query.
 */
const CERTIFICATE_PATH = /^\/SimpleNotificationService-[0-9a-f]{8,64}\.pem$/;

/**
 * True only for an https address on one of Amazon's SNS hosts. With `region`,
 * only that region's host, compared whole: a topic's messages are signed and
 * confirmed by its own region, so nothing else has a reason to be fetched.
 * `certificate` further demands the certificate path and refuses any query.
 */
export function isAmazonSnsUrl(value: string | undefined, opts?: { certificate?: boolean; region?: string | null }): boolean {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password || url.port || url.hash) return false;
  if (!SNS_HOST.test(url.hostname)) return false;
  if (opts?.region && url.hostname !== `sns.${opts.region}.amazonaws.com` && url.hostname !== `sns.${opts.region}.amazonaws.com.cn`) return false;
  if (opts?.certificate && (url.search !== "" || !CERTIFICATE_PATH.test(url.pathname))) return false;
  return true;
}

/** Which fields SNS signs for each kind of message, in SNS's order. */
function signedFieldsFor(type: string): (keyof SnsMessage)[] {
  if (type === "Notification") return ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"];
  if (type === "SubscriptionConfirmation" || type === "UnsubscribeConfirmation") {
    return ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  }
  return [];
}

/** SNS signature version "1" is SHA-1, "2" is SHA-256. */
function signatureAlgorithm(version: string): "RSA-SHA1" | "RSA-SHA256" | null {
  if (version === "1") return "RSA-SHA1";
  if (version === "2") return "RSA-SHA256";
  return null;
}

/**
 * The exact text SNS signed. The fields, their order and the trailing newline
 * after every name and every value are fixed by SNS; one difference and the
 * signature does not match.
 */
export function snsStringToSign(message: SnsMessage): string | null {
  const fields = signedFieldsFor(message.Type);
  if (fields.length === 0) return null;
  let text = "";
  for (const field of fields) {
    const value = message[field];
    // Subject is the one optional field: SNS leaves it out of the signed text when absent.
    if (value === undefined || value === null) {
      if (field === "Subject") continue;
      return null;
    }
    text += `${field}\n${value}\n`;
  }
  return text;
}

export type FetchCertificate = (url: string) => Promise<string>;

/** Certificates by address. SNS rotates them rarely; a process restart clears this. */
const certificateCache = new Map<string, { pem: string; at: number }>();
const CERTIFICATE_TTL_MS = 6 * 60 * 60 * 1000;
const CERTIFICATE_CACHE_MAX = 8;
/**
 * Certificate fetches are rationed, per caller and in all. A genuine topic
 * needs one every six hours. A stranger posting made-up certificate addresses
 * must not be able to turn this server into a flood of requests to Amazon, and
 * must not be able to spend the allowance a genuine report needs: each caller
 * (the route passes the sender's address) has its own small share, so one
 * address cannot starve SNS's.
 */
const CERTIFICATE_FETCHES_PER_CALLER_PER_MINUTE = 3;
const CERTIFICATE_FETCHES_PER_MINUTE = 30;
let fetchWindow: { startedAt: number; total: number; byCaller: Map<string, number> } = { startedAt: 0, total: 0, byCaller: new Map() };

/** Takes one fetch from the caller's share, or says there is none left this minute. */
function takeFetchAllowance(caller: string, now: number): boolean {
  if (now - fetchWindow.startedAt >= 60_000) fetchWindow = { startedAt: now, total: 0, byCaller: new Map() };
  const used = fetchWindow.byCaller.get(caller) ?? 0;
  if (fetchWindow.total >= CERTIFICATE_FETCHES_PER_MINUTE || used >= CERTIFICATE_FETCHES_PER_CALLER_PER_MINUTE) return false;
  fetchWindow.total += 1;
  fetchWindow.byCaller.set(caller, used + 1);
  return true;
}

async function defaultFetchCertificate(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error(`certificate fetch answered ${response.status}`);
  const pem = await response.text();
  if (pem.length > 20_000) throw new Error("not a certificate");
  return pem;
}

/**
 * The public key of an X.509 certificate that is in date. A bare public key,
 * or a key buried in some other text, is refused: `createVerify` alone would
 * accept either, which is how a reflected page could have passed for one.
 */
function publicKeyOfCertificate(pem: string, now: number): KeyObject | null {
  try {
    const certificate = new X509Certificate(pem.trim());
    const from = Date.parse(certificate.validFrom);
    const to = Date.parse(certificate.validTo);
    // An unreadable date refuses: a NaN would make both comparisons false and pass.
    if (Number.isNaN(from) || Number.isNaN(to) || from > now || to < now) return null;
    return certificate.publicKey;
  } catch {
    return null;
  }
}

async function certificateFor(url: string, fetchCertificate: FetchCertificate, now: number, caller: string): Promise<string | null> {
  const cached = certificateCache.get(url);
  if (cached && now - cached.at < CERTIFICATE_TTL_MS) return cached.pem;

  // Over the allowance, or the fetch fails: a certificate we already hold is
  // better than refusing a genuine report, even past its six hours.
  if (!takeFetchAllowance(caller, now)) return cached?.pem ?? null;

  let pem: string;
  try {
    pem = await fetchCertificate(url);
  } catch {
    return cached?.pem ?? null;
  }
  if (!publicKeyOfCertificate(pem, now)) return cached?.pem ?? null;
  if (certificateCache.size >= CERTIFICATE_CACHE_MAX && !certificateCache.has(url)) certificateCache.clear();
  certificateCache.set(url, { pem, at: now });
  return pem;
}

/** Test seam: forget every cached certificate and the fetch budget. */
export function clearSnsCertificateCache(): void {
  certificateCache.clear();
  fetchWindow = { startedAt: 0, total: 0, byCaller: new Map() };
}

/**
 * `retryable` marks the one refusal that is OUR trouble, not the message's:
 * the certificate could not be had just now. The route answers that with a
 * 5xx so SNS sends the report again; every other refusal is final.
 */
export type SnsVerification = { ok: true } | { ok: false; reason: string; retryable?: true };

/**
 * Is this message signed by Amazon SNS?
 *
 * Refuses, in this order: a certificate address that is not Amazon's, a
 * message type we do not know how to check, an unknown signature version, a
 * certificate we cannot fetch, and a signature that does not match. A message
 * older than an hour is refused too, so a captured report cannot be replayed
 * months later (an hour is the longest SNS can be set to keep retrying; its
 * default is three retries twenty seconds apart).
 */
export async function verifySnsMessage(
  message: SnsMessage,
  opts?: { fetchCertificate?: FetchCertificate; now?: Date; /** Whose share of the certificate fetches this spends: the sender's address. */ caller?: string },
): Promise<SnsVerification> {
  // The certificate must come from the region of the topic the message names.
  const region = regionOfTopicArn(message.TopicArn);
  if (!region) return { ok: false, reason: "bad-topic" };
  if (!isAmazonSnsUrl(message.SigningCertURL, { certificate: true, region })) return { ok: false, reason: "certificate-address-not-amazon" };

  const text = snsStringToSign(message);
  if (text === null) return { ok: false, reason: "unknown-message-type" };

  const algorithm = signatureAlgorithm(message.SignatureVersion);
  if (!algorithm) return { ok: false, reason: "unknown-signature-version" };

  const now = opts?.now ?? new Date();
  const sentAt = Date.parse(message.Timestamp);
  if (Number.isNaN(sentAt)) return { ok: false, reason: "bad-timestamp" };
  if (Math.abs(now.getTime() - sentAt) > 60 * 60 * 1000) return { ok: false, reason: "too-old" };

  const pem = await certificateFor(message.SigningCertURL, opts?.fetchCertificate ?? defaultFetchCertificate, now.getTime(), opts?.caller ?? "unknown");
  if (!pem) return { ok: false, reason: "certificate-unavailable", retryable: true };
  const publicKey = publicKeyOfCertificate(pem, now.getTime());
  if (!publicKey) return { ok: false, reason: "certificate-unavailable", retryable: true };

  try {
    const verifier = createVerify(algorithm);
    verifier.update(text, "utf8");
    if (!verifier.verify(publicKey, message.Signature, "base64")) return { ok: false, reason: "signature-mismatch" };
  } catch {
    return { ok: false, reason: "signature-unreadable" };
  }
  return { ok: true };
}

// ── The report itself ───────────────────────────────────────────────────────

export type DeliveryKind = "DELIVERED" | "BOUNCED" | "COMPLAINED";

/** What the app keeps from one report. */
export interface SesDeliveryEvent {
  kind: DeliveryKind;
  /** The mail service's id for the email; `EmailLog.providerMessageId`. */
  messageId: string;
  at: Date;
  /** The addresses this report is about, lower-cased. */
  recipients: string[];
  /** "Permanent" | "Transient" | "Undetermined" for a bounce, else null. */
  bounceType: string | null;
  bounceSubType: string | null;
  /** The delivery's answer or the kind of complaint. For a bounce see `recipientDetails`. Capped. */
  detail: string | null;
  /**
   * A bounce's words from the other mail server, per address. Kept apart
   * because that text usually names the address: the row is given only the
   * words about the person the email was FOR, never a copied address's.
   */
  recipientDetails: { address: string; detail: string }[];
  /** When the mail service took the email, when the report says. */
  mailAt: Date | null;
}

export type ParsedSesEvent =
  | { ok: true; event: SesDeliveryEvent }
  /** A report we deliberately do not keep (a send, a delay, an open), or one we cannot read. */
  | { ok: false; ignored: string };

const DETAIL_MAX = 500;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function addressesOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const found: string[] = [];
  for (const item of list) {
    const address = typeof item === "string" ? item : asText(asRecord(item)?.emailAddress);
    if (address) found.push(bareAddress(address));
  }
  return [...new Set(found)];
}

/** `Name <a@b.c>` and `A@B.C` both become `a@b.c`. */
export function bareAddress(value: string): string {
  const angled = /<([^<>]+)>\s*$/.exec(value);
  return (angled ? angled[1] : value).trim().toLowerCase();
}

function cap(value: string | null): string | null {
  if (!value) return null;
  return value.length > DETAIL_MAX ? `${value.slice(0, DETAIL_MAX)}…` : value;
}

function dateOr(value: unknown, fallback: Date): Date {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? fallback : new Date(parsed);
}

/**
 * Reads the `Message` of an SNS notification as an SES report.
 *
 * SES has two shapes for the same facts: event publishing names the kind in
 * `eventType`, the older feedback notifications in `notificationType`. Both are
 * read, so the door works whichever way the topic is fed.
 */
export function parseSesEvent(rawMessage: string, receivedAt: Date = new Date()): ParsedSesEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return { ok: false, ignored: "not-json" };
  }
  const body = asRecord(parsed);
  if (!body) return { ok: false, ignored: "not-an-object" };

  const kindName = asText(body.eventType) ?? asText(body.notificationType);
  if (!kindName) return { ok: false, ignored: "no-kind" };

  const messageId = asText(asRecord(body.mail)?.messageId);
  if (!messageId) return { ok: false, ignored: "no-message-id" };
  const mailTimestamp = Date.parse(asText(asRecord(body.mail)?.timestamp) ?? "");
  const mailAt = Number.isNaN(mailTimestamp) ? null : new Date(mailTimestamp);

  if (kindName === "Delivery") {
    const delivery = asRecord(body.delivery);
    if (!delivery) return { ok: false, ignored: "delivery-without-body" };
    return {
      ok: true,
      event: {
        kind: "DELIVERED",
        messageId,
        at: dateOr(delivery.timestamp, receivedAt),
        recipients: addressesOf(delivery.recipients),
        bounceType: null,
        bounceSubType: null,
        detail: cap(asText(delivery.smtpResponse)),
        recipientDetails: [],
        mailAt,
      },
    };
  }

  if (kindName === "Bounce") {
    const bounce = asRecord(body.bounce);
    if (!bounce) return { ok: false, ignored: "bounce-without-body" };
    const recipientDetails: { address: string; detail: string }[] = [];
    for (const item of Array.isArray(bounce.bouncedRecipients) ? bounce.bouncedRecipients : []) {
      const address = asText(asRecord(item)?.emailAddress);
      const words = cap(asText(asRecord(item)?.diagnosticCode));
      if (address && words) recipientDetails.push({ address: bareAddress(address), detail: words });
    }
    return {
      ok: true,
      event: {
        kind: "BOUNCED",
        messageId,
        at: dateOr(bounce.timestamp, receivedAt),
        recipients: addressesOf(bounce.bouncedRecipients),
        bounceType: asText(bounce.bounceType) ?? "Undetermined",
        bounceSubType: asText(bounce.bounceSubType),
        detail: null,
        recipientDetails,
        mailAt,
      },
    };
  }

  if (kindName === "Complaint") {
    const complaint = asRecord(body.complaint);
    if (!complaint) return { ok: false, ignored: "complaint-without-body" };
    return {
      ok: true,
      event: {
        kind: "COMPLAINED",
        messageId,
        at: dateOr(complaint.timestamp, receivedAt),
        recipients: addressesOf(complaint.complainedRecipients),
        bounceType: null,
        bounceSubType: null,
        detail: cap(asText(complaint.complaintFeedbackType)),
        recipientDetails: [],
        mailAt,
      },
    };
  }

  return { ok: false, ignored: `kind-${kindName}` };
}

/** A bounce that will not fix itself: the mail service drops later emails to this address. */
export function isPermanentBounce(row: { deliveryStatus?: string | null; bounceType?: string | null }): boolean {
  return row.deliveryStatus === "BOUNCED" && row.bounceType === "Permanent";
}

/**
 * The mail service files some automatic replies ("out of office") as a bounce
 * of type Transient, sub-type General, of an email that WAS delivered. Every
 * other Transient bounce (mailbox full, message too large, content refused)
 * is a real failure, and commonly arrives AFTER a delivery report: the other
 * server accepts the email, then sends it back.
 */
function isAutomaticReply(report: { bounceType: string | null; bounceSubType: string | null }): boolean {
  return report.bounceType === "Transient" && (report.bounceSubType === null || report.bounceSubType === "General");
}

/**
 * Should this report replace what the row already says?
 *
 *   - A spam complaint always stands: it arrives after delivery and is the
 *     most serious thing a row can say.
 *   - "Delivered" and an automatic reply (see above): Delivered wins,
 *     whichever arrives first, because SNS does not promise order.
 *   - Any other bounce replaces "Delivered": the email was accepted and then
 *     came back, so it did not arrive.
 *   - "Delivered" never replaces a real bounce or a complaint, and a repeat of
 *     the same report changes nothing (SNS delivers at least once).
 */
export function shouldReplaceDelivery(
  current: { deliveryStatus: DeliveryKind | null; bounceType: string | null; bounceSubType: string | null },
  incoming: Pick<SesDeliveryEvent, "kind" | "bounceType" | "bounceSubType">,
): boolean {
  if (current.deliveryStatus === "COMPLAINED") return false;
  if (incoming.kind === "COMPLAINED") return true;
  if (incoming.kind === "DELIVERED") {
    return current.deliveryStatus === null || (current.deliveryStatus === "BOUNCED" && isAutomaticReply(current));
  }
  // incoming BOUNCED
  if (current.deliveryStatus === null) return true;
  if (current.deliveryStatus === "DELIVERED") return !isAutomaticReply(incoming);
  // BOUNCED over BOUNCED: only a Permanent report may replace a lesser one.
  return current.bounceType !== "Permanent" && incoming.bounceType === "Permanent";
}
