/**
 * The mail service's reports (Nov 19, 2026): is a posted message really
 * Amazon's, and what does it say. Signed here with a key made for the test, so
 * a real signature is checked, not a mocked "true".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import {
  bareAddress,
  clearSnsCertificateCache,
  isAmazonSnsUrl,
  isPermanentBounce,
  parseSesEvent,
  readSnsMessage,
  regionOfTopicArn,
  shouldReplaceDelivery,
  snsStringToSign,
  verifySnsMessage,
  type SnsMessage,
} from "@/lib/ses-events";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const OTHER_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();

const CERT_URL = "https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-abc123.pem";
const TOPIC = "arn:aws:sns:ap-south-1:111122223333:ea-sys-ses-events";
const NOW = new Date("2026-11-19T10:00:00.000Z");

function signed(fields: Partial<SnsMessage>, version: "1" | "2" = "1"): SnsMessage {
  const message = {
    Type: "Notification",
    MessageId: "m-1",
    TopicArn: TOPIC,
    Message: '{"eventType":"Delivery"}',
    Timestamp: "2026-11-19T09:59:30.000Z",
    SignatureVersion: version,
    Signature: "",
    SigningCertURL: CERT_URL,
    ...fields,
  } as SnsMessage;
  const signer = createSign(version === "1" ? "RSA-SHA1" : "RSA-SHA256");
  signer.update(snsStringToSign(message) ?? "", "utf8");
  return { ...message, Signature: signer.sign(privateKey, "base64") };
}

const fetchOk = vi.fn(async () => PUBLIC_PEM);

beforeEach(() => {
  clearSnsCertificateCache();
  fetchOk.mockClear();
});

describe("readSnsMessage", () => {
  it("accepts a complete envelope", () => {
    const read = readSnsMessage(JSON.stringify(signed({})));
    expect(read.ok).toBe(true);
  });

  it.each([
    ["not json", "{", "not-json"],
    ["an array", "[]", "not-an-object"],
    ["no signature", JSON.stringify({ ...signed({}), Signature: "" }), "missing-Signature"],
    ["a numeric topic", JSON.stringify({ ...signed({}), TopicArn: 5 }), "missing-TopicArn"],
    ["an object where the link should be", JSON.stringify({ ...signed({}), SubscribeURL: { a: 1 } }), "bad-SubscribeURL"],
  ])("refuses %s", (_name, raw, reason) => {
    expect(readSnsMessage(raw)).toEqual({ ok: false, reason });
  });
});

describe("isAmazonSnsUrl", () => {
  it.each([
    "https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-x.pem",
    "https://sns.us-east-1.amazonaws.com/x.pem",
    "https://sns.cn-north-1.amazonaws.com.cn/x.pem",
  ])("accepts %s", (url) => {
    expect(isAmazonSnsUrl(url, { pemOnly: true })).toBe(true);
  });

  it.each([
    ["plain http", "http://sns.ap-south-1.amazonaws.com/x.pem"],
    ["a look-alike host", "https://sns.ap-south-1.amazonaws.com.evil.example/x.pem"],
    ["Amazon's name as a folder", "https://evil.example/sns.ap-south-1.amazonaws.com/x.pem"],
    ["another Amazon service", "https://s3.ap-south-1.amazonaws.com/bucket/x.pem"],
    ["a name before the host", "https://sns.ap-south-1.amazonaws.com@evil.example/x.pem"],
    ["a port", "https://sns.ap-south-1.amazonaws.com:8443/x.pem"],
    ["not a certificate file", "https://sns.ap-south-1.amazonaws.com/x.txt"],
    ["nothing", undefined],
    ["not an address", "sns.ap-south-1.amazonaws.com"],
  ])("refuses %s", (_name, url) => {
    expect(isAmazonSnsUrl(url, { pemOnly: true })).toBe(false);
  });

  it("with a region, accepts that region's host only", () => {
    expect(isAmazonSnsUrl("https://sns.ap-south-1.amazonaws.com/x.pem", { pemOnly: true, region: "ap-south-1" })).toBe(true);
    expect(isAmazonSnsUrl("https://sns.us-east-1.amazonaws.com/x.pem", { pemOnly: true, region: "ap-south-1" })).toBe(false);
    expect(isAmazonSnsUrl("https://sns.ap-south-10.amazonaws.com/x.pem", { pemOnly: true, region: "ap-south-1" })).toBe(false);
  });

  it("reads the region out of a topic's ARN", () => {
    expect(regionOfTopicArn("arn:aws:sns:ap-south-1:111122223333:ea-sys-ses-events")).toBe("ap-south-1");
    expect(regionOfTopicArn("arn:aws:sqs:ap-south-1:111122223333:q")).toBeNull();
    expect(regionOfTopicArn("not-an-arn")).toBeNull();
  });

  it("does not ask for a certificate file when told not to (the confirmation link)", () => {
    expect(isAmazonSnsUrl("https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&Token=t")).toBe(true);
  });
});

describe("snsStringToSign", () => {
  it("is SNS's exact text for a notification, Subject included only when present", () => {
    const base = signed({});
    expect(snsStringToSign(base)).toBe(
      `Message\n${base.Message}\nMessageId\nm-1\nTimestamp\n2026-11-19T09:59:30.000Z\nTopicArn\n${TOPIC}\nType\nNotification\n`,
    );
    expect(snsStringToSign({ ...base, Subject: "Hello" })).toContain("MessageId\nm-1\nSubject\nHello\nTimestamp\n");
  });

  it("is SNS's exact text for a subscription confirmation", () => {
    const m = signed({ Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.ap-south-1.amazonaws.com/?x=1", Token: "tok" });
    expect(snsStringToSign(m)).toBe(
      `Message\n${m.Message}\nMessageId\nm-1\nSubscribeURL\nhttps://sns.ap-south-1.amazonaws.com/?x=1\nTimestamp\n2026-11-19T09:59:30.000Z\nToken\ntok\nTopicArn\n${TOPIC}\nType\nSubscriptionConfirmation\n`,
    );
  });

  it("has no text for a kind it does not know, or a confirmation with no link", () => {
    expect(snsStringToSign(signed({ Type: "Something" }))).toBeNull();
    expect(snsStringToSign({ ...signed({}), Type: "SubscriptionConfirmation" })).toBeNull();
  });
});

describe("verifySnsMessage", () => {
  it.each(["1", "2"] as const)("accepts a genuine signature, version %s", async (version) => {
    expect(await verifySnsMessage(signed({}, version), { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: true });
  });

  it("refuses a message changed after it was signed", async () => {
    const m = { ...signed({}), Message: '{"eventType":"Bounce"}' };
    expect(await verifySnsMessage(m, { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses a message signed with somebody else's key", async () => {
    const other = vi.fn(async () => OTHER_PEM);
    expect(await verifySnsMessage(signed({}), { fetchCertificate: other, now: NOW })).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("never fetches a certificate from an address that is not Amazon's", async () => {
    const m = signed({ SigningCertURL: "https://evil.example/cert.pem" });
    expect(await verifySnsMessage(m, { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "certificate-address-not-amazon" });
    expect(fetchOk).not.toHaveBeenCalled();
  });

  it("never fetches a certificate from another region than the topic's", async () => {
    const m = signed({ SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem" });
    expect(await verifySnsMessage(m, { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "certificate-address-not-amazon" });
    expect(await verifySnsMessage(signed({ TopicArn: "nonsense" }), { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "bad-topic" });
    expect(fetchOk).not.toHaveBeenCalled();
  });

  it("refuses a report older than an hour, so a captured one cannot be replayed", async () => {
    const m = signed({ Timestamp: "2026-11-19T08:30:00.000Z" });
    expect(await verifySnsMessage(m, { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "too-old" });
  });

  it("refuses an unknown signature version, an unknown kind and an unreadable date", async () => {
    expect(await verifySnsMessage({ ...signed({}), SignatureVersion: "3" }, { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "unknown-signature-version" });
    expect(await verifySnsMessage(signed({ Type: "Something" }), { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "unknown-message-type" });
    expect(await verifySnsMessage({ ...signed({}), Timestamp: "soon" }, { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "bad-timestamp" });
  });

  it("fails closed when the certificate cannot be fetched, or is not one", async () => {
    const down = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await verifySnsMessage(signed({}), { fetchCertificate: down, now: NOW })).toEqual({ ok: false, reason: "certificate-unavailable" });
    const junk = vi.fn(async () => "not a key");
    clearSnsCertificateCache();
    expect((await verifySnsMessage(signed({}), { fetchCertificate: junk, now: NOW })).ok).toBe(false);
  });

  it("fetches a certificate once and reuses it", async () => {
    await verifySnsMessage(signed({}), { fetchCertificate: fetchOk, now: NOW });
    await verifySnsMessage(signed({ MessageId: "m-2" }), { fetchCertificate: fetchOk, now: NOW });
    expect(fetchOk).toHaveBeenCalledTimes(1);
  });
});

describe("parseSesEvent", () => {
  const mail = { messageId: "0109-abc", destination: ["Doc@Example.org"] };

  it("reads a delivery", () => {
    const parsed = parseSesEvent(JSON.stringify({ eventType: "Delivery", mail, delivery: { timestamp: "2026-11-19T09:00:00.000Z", recipients: ["Doc@Example.org"], smtpResponse: "250 2.0.0 OK" } }));
    expect(parsed).toEqual({
      ok: true,
      event: { kind: "DELIVERED", messageId: "0109-abc", at: new Date("2026-11-19T09:00:00.000Z"), recipients: ["doc@example.org"], bounceType: null, bounceSubType: null, detail: "250 2.0.0 OK" },
    });
  });

  it("reads a bounce, with the other server's words", () => {
    const parsed = parseSesEvent(
      JSON.stringify({
        eventType: "Bounce",
        mail,
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          timestamp: "2026-11-19T09:00:01.000Z",
          bouncedRecipients: [{ emailAddress: "Doc <Doc@Example.org>", diagnosticCode: "smtp; 550 5.1.1 user unknown" }],
        },
      }),
    );
    expect(parsed.ok && parsed.event).toMatchObject({ kind: "BOUNCED", recipients: ["doc@example.org"], bounceType: "Permanent", bounceSubType: "General", detail: "smtp; 550 5.1.1 user unknown" });
  });

  it("reads a spam complaint", () => {
    const parsed = parseSesEvent(JSON.stringify({ eventType: "Complaint", mail, complaint: { complainedRecipients: [{ emailAddress: "doc@example.org" }], complaintFeedbackType: "abuse" } }), NOW);
    expect(parsed.ok && parsed.event).toMatchObject({ kind: "COMPLAINED", recipients: ["doc@example.org"], detail: "abuse", at: NOW });
  });

  it("reads the older notification shape as well", () => {
    const parsed = parseSesEvent(JSON.stringify({ notificationType: "Bounce", mail, bounce: { bounceType: "Transient", bounceSubType: "MailboxFull", bouncedRecipients: [{ emailAddress: "doc@example.org" }] } }));
    expect(parsed.ok && parsed.event).toMatchObject({ kind: "BOUNCED", bounceType: "Transient", bounceSubType: "MailboxFull", detail: null });
  });

  it("caps a long diagnostic", () => {
    const parsed = parseSesEvent(JSON.stringify({ eventType: "Bounce", mail, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "doc@example.org", diagnosticCode: "x".repeat(900) }] } }));
    expect(parsed.ok && parsed.event.detail?.length).toBe(501);
  });

  it.each([
    ["a send", JSON.stringify({ eventType: "Send", mail, send: {} }), "kind-Send"],
    ["a delay", JSON.stringify({ eventType: "DeliveryDelay", mail, deliveryDelay: {} }), "kind-DeliveryDelay"],
    ["a report with no message id", JSON.stringify({ eventType: "Bounce", mail: {}, bounce: {} }), "no-message-id"],
    ["a report with no kind", JSON.stringify({ mail }), "no-kind"],
    ["a bounce with no body", JSON.stringify({ eventType: "Bounce", mail }), "bounce-without-body"],
    ["text that is not json", "Successfully validated SNS topic", "not-json"],
  ])("does not keep %s", (_name, raw, ignored) => {
    expect(parseSesEvent(raw)).toEqual({ ok: false, ignored });
  });
});

describe("shouldReplaceDelivery", () => {
  const row = (deliveryStatus: "DELIVERED" | "BOUNCED" | "COMPLAINED" | null, bounceType: string | null = null) => ({ deliveryStatus, bounceType });

  it.each([
    ["first delivery", row(null), { kind: "DELIVERED", bounceType: null }, true],
    ["a repeated delivery", row("DELIVERED"), { kind: "DELIVERED", bounceType: null }, false],
    ["delivered after a bounce", row("BOUNCED", "Permanent"), { kind: "DELIVERED", bounceType: null }, false],
    ["first bounce", row(null), { kind: "BOUNCED", bounceType: "Transient" }, true],
    ["a permanent bounce after delivered", row("DELIVERED"), { kind: "BOUNCED", bounceType: "Permanent" }, true],
    ["an automatic reply filed as a transient bounce, after delivered", row("DELIVERED"), { kind: "BOUNCED", bounceType: "Transient" }, false],
    ["permanent over transient", row("BOUNCED", "Transient"), { kind: "BOUNCED", bounceType: "Permanent" }, true],
    ["transient over permanent", row("BOUNCED", "Permanent"), { kind: "BOUNCED", bounceType: "Transient" }, false],
    ["a repeated permanent bounce", row("BOUNCED", "Permanent"), { kind: "BOUNCED", bounceType: "Permanent" }, false],
    ["a complaint after delivered", row("DELIVERED"), { kind: "COMPLAINED", bounceType: null }, true],
    ["anything after a complaint", row("COMPLAINED"), { kind: "BOUNCED", bounceType: "Permanent" }, false],
    ["a repeated complaint", row("COMPLAINED"), { kind: "COMPLAINED", bounceType: null }, false],
  ] as const)("%s", (_name, current, incoming, expected) => {
    expect(shouldReplaceDelivery(current, incoming)).toBe(expected);
  });
});

describe("small helpers", () => {
  it("bareAddress lower-cases and unwraps a display name", () => {
    expect(bareAddress("Dr A <A.B@Example.ORG>")).toBe("a.b@example.org");
    expect(bareAddress("  A@B.c ")).toBe("a@b.c");
  });

  it("isPermanentBounce is true for a permanent bounce only", () => {
    expect(isPermanentBounce({ deliveryStatus: "BOUNCED", bounceType: "Permanent" })).toBe(true);
    expect(isPermanentBounce({ deliveryStatus: "BOUNCED", bounceType: "Transient" })).toBe(false);
    expect(isPermanentBounce({ deliveryStatus: "DELIVERED", bounceType: null })).toBe(false);
    expect(isPermanentBounce({})).toBe(false);
  });
});
