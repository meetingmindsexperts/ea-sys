/**
 * The mail service's reports (Nov 19, 2026): is a posted message really
 * Amazon's, and what does it say. Signed here with a key made for the test, so
 * a real signature is checked, not a mocked "true".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { X509Certificate, createSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * A real X.509 certificate and its key, made by openssl for this run. The code
 * under test accepts a certificate only, so a bare public key will not do.
 */
function makeCertificate(days: string): { pem: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "sns-cert-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", days, "-subj", "/CN=sns.amazonaws.com"], { stdio: "ignore" });
    return { pem: readFileSync(join(dir, "c.pem"), "utf8"), key: readFileSync(join(dir, "k.pem"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const CERT = makeCertificate("2");
const OTHER_CERT = makeCertificate("2");
const privateKey = CERT.key;
const CERT_PEM = CERT.pem;
/** The same key with no certificate around it: what the first version wrongly accepted. */
const BARE_PUBLIC_KEY = new X509Certificate(CERT.pem).publicKey.export({ type: "spki", format: "pem" }).toString();

const CERT_URL = "https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem";
const TOPIC = "arn:aws:sns:ap-south-1:111122223333:ea-sys-ses-events";
/**
 * The real clock, NOT a fixed date. The certificate above is made when the
 * tests run and is checked for being in date, so a pinned "now" passes only
 * while the calendar happens to agree with it (the first version of this file
 * would have started failing a day after it was written).
 */
const NOW = new Date();
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
const SENT_AT = minutesAgo(0.5);

function signed(fields: Partial<SnsMessage>, version: "1" | "2" = "1"): SnsMessage {
  const message = {
    Type: "Notification",
    MessageId: "m-1",
    TopicArn: TOPIC,
    Message: '{"eventType":"Delivery"}',
    Timestamp: SENT_AT,
    SignatureVersion: version,
    Signature: "",
    SigningCertURL: CERT_URL,
    ...fields,
  } as SnsMessage;
  const signer = createSign(version === "1" ? "RSA-SHA1" : "RSA-SHA256");
  signer.update(snsStringToSign(message) ?? "", "utf8");
  return { ...message, Signature: signer.sign(privateKey, "base64") };
}

const fetchOk = vi.fn(async () => CERT_PEM);

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
  const OK = "/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem";

  it.each([`https://sns.ap-south-1.amazonaws.com${OK}`, `https://sns.us-east-1.amazonaws.com${OK}`, `https://sns.cn-north-1.amazonaws.com.cn${OK}`])(
    "accepts the certificate address %s",
    (url) => {
      expect(isAmazonSnsUrl(url, { certificate: true })).toBe(true);
    },
  );

  it.each([
    ["plain http", `http://sns.ap-south-1.amazonaws.com${OK}`],
    ["a look-alike host", `https://sns.ap-south-1.amazonaws.com.evil.example${OK}`],
    ["Amazon's name as a folder", `https://evil.example/sns.ap-south-1.amazonaws.com${OK}`],
    ["another Amazon service", `https://s3.ap-south-1.amazonaws.com/bucket${OK}`],
    ["a name before the host", `https://sns.ap-south-1.amazonaws.com@evil.example${OK}`],
    ["a port", `https://sns.ap-south-1.amazonaws.com:8443${OK}`],
    ["not a certificate file", "https://sns.ap-south-1.amazonaws.com/x.txt"],
    ["any other .pem path (the host is also an API that answers with the caller's text)", "https://sns.ap-south-1.amazonaws.com/x.pem"],
    ["a certificate path in a folder", `https://sns.ap-south-1.amazonaws.com/a${OK}`],
    ["a query string", `https://sns.ap-south-1.amazonaws.com${OK}?Action=GetEndpointAttributes`],
    ["a fragment", `https://sns.ap-south-1.amazonaws.com${OK}#x`],
    ["nothing", undefined],
    ["not an address", "sns.ap-south-1.amazonaws.com"],
  ])("refuses %s", (_name, url) => {
    expect(isAmazonSnsUrl(url, { certificate: true })).toBe(false);
  });

  it("with a region, accepts that region's host only, compared whole", () => {
    expect(isAmazonSnsUrl(`https://sns.ap-south-1.amazonaws.com${OK}`, { certificate: true, region: "ap-south-1" })).toBe(true);
    expect(isAmazonSnsUrl(`https://sns.us-east-1.amazonaws.com${OK}`, { certificate: true, region: "ap-south-1" })).toBe(false);
    expect(isAmazonSnsUrl(`https://sns.ap-south-10.amazonaws.com${OK}`, { certificate: true, region: "ap-south-1" })).toBe(false);
  });

  it("reads the region out of a topic's ARN", () => {
    expect(regionOfTopicArn("arn:aws:sns:ap-south-1:111122223333:ea-sys-ses-events")).toBe("ap-south-1");
    expect(regionOfTopicArn("arn:aws:sqs:ap-south-1:111122223333:q")).toBeNull();
    expect(regionOfTopicArn("not-an-arn")).toBeNull();
  });

  it("the confirmation link may carry a query, and needs no certificate path", () => {
    expect(isAmazonSnsUrl("https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&Token=t")).toBe(true);
  });
});

describe("snsStringToSign", () => {
  it("is SNS's exact text for a notification, Subject included only when present", () => {
    const base = signed({});
    expect(snsStringToSign(base)).toBe(
      `Message\n${base.Message}\nMessageId\nm-1\nTimestamp\n${SENT_AT}\nTopicArn\n${TOPIC}\nType\nNotification\n`,
    );
    expect(snsStringToSign({ ...base, Subject: "Hello" })).toContain("MessageId\nm-1\nSubject\nHello\nTimestamp\n");
  });

  it("is SNS's exact text for a subscription confirmation", () => {
    const m = signed({ Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.ap-south-1.amazonaws.com/?x=1", Token: "tok" });
    expect(snsStringToSign(m)).toBe(
      `Message\n${m.Message}\nMessageId\nm-1\nSubscribeURL\nhttps://sns.ap-south-1.amazonaws.com/?x=1\nTimestamp\n${SENT_AT}\nToken\ntok\nTopicArn\n${TOPIC}\nType\nSubscriptionConfirmation\n`,
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

  it("checks SNS's own signed text, written out here and not taken from the code", async () => {
    // Signed over a literal, so a wrong field order in snsStringToSign fails this.
    const message = signed({});
    const literal = `Message\n${message.Message}\nMessageId\nm-1\nTimestamp\n${SENT_AT}\nTopicArn\n${TOPIC}\nType\nNotification\n`;
    const signer = createSign("RSA-SHA1");
    signer.update(literal, "utf8");
    const byHand = { ...message, Signature: signer.sign(privateKey, "base64") };
    expect(await verifySnsMessage(byHand, { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: true });
  });

  it("refuses a message changed after it was signed", async () => {
    const m = { ...signed({}), Message: '{"eventType":"Bounce"}' };
    expect(await verifySnsMessage(m, { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses a message signed with somebody else's key", async () => {
    const other = vi.fn(async () => OTHER_CERT.pem);
    expect(await verifySnsMessage(signed({}), { fetchCertificate: other, now: NOW })).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses the right key when it is not inside a certificate", async () => {
    const bare = vi.fn(async () => BARE_PUBLIC_KEY);
    expect(await verifySnsMessage(signed({}), { fetchCertificate: bare, now: NOW })).toMatchObject({ ok: false, reason: "certificate-unavailable" });
    // ...and when it is buried in other text that mentions a certificate.
    clearSnsCertificateCache();
    const buried = vi.fn(async () => `<Response>BEGIN CERTIFICATE\n${BARE_PUBLIC_KEY}</Response>`);
    expect((await verifySnsMessage(signed({}), { fetchCertificate: buried, now: NOW })).ok).toBe(false);
  });

  it("refuses a certificate that is not valid yet", async () => {
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const m = signed({ Timestamp: yesterday.toISOString() });
    expect(await verifySnsMessage(m, { fetchCertificate: fetchOk, now: yesterday })).toMatchObject({ ok: false, reason: "certificate-unavailable" });
  });

  it("refuses a certificate that is out of date", async () => {
    const later = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000);
    const m = signed({ Timestamp: later.toISOString() });
    expect(await verifySnsMessage(m, { fetchCertificate: fetchOk, now: later })).toMatchObject({ ok: false, reason: "certificate-unavailable" });
  });

  it("never fetches a certificate from an address that is not Amazon's", async () => {
    const m = signed({ SigningCertURL: "https://evil.example/SimpleNotificationService-0123456789abcdef.pem" });
    expect(await verifySnsMessage(m, { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "certificate-address-not-amazon" });
    expect(fetchOk).not.toHaveBeenCalled();
  });

  it("never fetches a certificate from another region than the topic's", async () => {
    const m = signed({ SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123456789abcdef.pem" });
    expect(await verifySnsMessage(m, { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "certificate-address-not-amazon" });
    expect(await verifySnsMessage(signed({ TopicArn: "nonsense" }), { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "bad-topic" });
    expect(fetchOk).not.toHaveBeenCalled();
  });

  it("refuses a report older than an hour, so a captured one cannot be replayed", async () => {
    const m = signed({ Timestamp: minutesAgo(90) });
    expect(await verifySnsMessage(m, { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "too-old" });
  });

  it("refuses an unknown signature version, an unknown kind and an unreadable date", async () => {
    expect(await verifySnsMessage({ ...signed({}), SignatureVersion: "3" }, { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "unknown-signature-version" });
    expect(await verifySnsMessage(signed({ Type: "Something" }), { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "unknown-message-type" });
    expect(await verifySnsMessage({ ...signed({}), Timestamp: "soon" }, { fetchCertificate: fetchOk, now: NOW })).toEqual({ ok: false, reason: "bad-timestamp" });
  });

  it("when the certificate cannot be fetched, says so as OUR trouble, to be tried again", async () => {
    const down = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await verifySnsMessage(signed({}), { fetchCertificate: down, now: NOW })).toEqual({ ok: false, reason: "certificate-unavailable", retryable: true });
  });

  it("fetches a certificate once and reuses it", async () => {
    await verifySnsMessage(signed({}), { fetchCertificate: fetchOk, now: NOW });
    await verifySnsMessage(signed({ MessageId: "m-2" }), { fetchCertificate: fetchOk, now: NOW });
    expect(fetchOk).toHaveBeenCalledTimes(1);
  });

  it("keeps using the certificate it holds when a refetch fails after six hours", async () => {
    await verifySnsMessage(signed({}), { fetchCertificate: fetchOk, now: NOW });
    const sevenHoursOn = new Date(NOW.getTime() + 7 * 60 * 60 * 1000);
    const down = vi.fn(async () => {
      throw new Error("network");
    });
    const m = signed({ Timestamp: sevenHoursOn.toISOString() });
    expect(await verifySnsMessage(m, { fetchCertificate: down, now: sevenHoursOn })).toEqual({ ok: true });
    expect(down).toHaveBeenCalledTimes(1);
  });

  it("gives each sender a small share of the certificate fetches, so a stranger cannot spend SNS's", async () => {
    const down = vi.fn(async () => {
      throw new Error("no such certificate");
    });
    const madeUp = (i: number) => `https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-${String(i).padStart(16, "0")}.pem`;
    for (let i = 0; i < 12; i++) {
      expect((await verifySnsMessage(signed({ SigningCertURL: madeUp(i) }), { fetchCertificate: down, now: NOW, caller: "198.51.100.7" })).ok).toBe(false);
    }
    expect(down).toHaveBeenCalledTimes(3);

    // A genuine report from another address still gets its certificate.
    expect(await verifySnsMessage(signed({}), { fetchCertificate: fetchOk, now: NOW, caller: "203.0.113.20" })).toEqual({ ok: true });
    expect(fetchOk).toHaveBeenCalledTimes(1);
  });

  it("caps the fetches of all senders together in a minute", async () => {
    const down = vi.fn(async () => {
      throw new Error("no such certificate");
    });
    for (let i = 0; i < 40; i++) {
      const url = `https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-${String(i).padStart(16, "0")}.pem`;
      await verifySnsMessage(signed({ SigningCertURL: url }), { fetchCertificate: down, now: NOW, caller: `198.51.100.${i}` });
    }
    expect(down).toHaveBeenCalledTimes(30);
  });
});

describe("parseSesEvent", () => {
  const mail = { messageId: "0109-abc", destination: ["Doc@Example.org"], timestamp: "2026-11-19T08:59:58.000Z" };

  it("reads a delivery", () => {
    const parsed = parseSesEvent(JSON.stringify({ eventType: "Delivery", mail, delivery: { timestamp: "2026-11-19T09:00:00.000Z", recipients: ["Doc@Example.org"], smtpResponse: "250 2.0.0 OK" } }));
    expect(parsed).toEqual({
      ok: true,
      event: { kind: "DELIVERED", messageId: "0109-abc", at: new Date("2026-11-19T09:00:00.000Z"), recipients: ["doc@example.org"], bounceType: null, bounceSubType: null, detail: "250 2.0.0 OK", recipientDetails: [], mailAt: new Date("2026-11-19T08:59:58.000Z") },
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
    expect(parsed.ok && parsed.event).toMatchObject({
      kind: "BOUNCED",
      recipients: ["doc@example.org"],
      bounceType: "Permanent",
      bounceSubType: "General",
      detail: null,
      recipientDetails: [{ address: "doc@example.org", detail: "smtp; 550 5.1.1 user unknown" }],
    });
  });

  it("keeps each bounced address's words apart, so a copied address's are never put on the row", () => {
    const parsed = parseSesEvent(
      JSON.stringify({
        eventType: "Bounce",
        mail,
        bounce: {
          bounceType: "Permanent",
          bouncedRecipients: [
            { emailAddress: "doc@example.org", diagnosticCode: "550 doc@example.org unknown" },
            { emailAddress: "hidden-bcc@example.org", diagnosticCode: "550 hidden-bcc@example.org unknown" },
          ],
        },
      }),
    );
    expect(parsed.ok && parsed.event.recipientDetails).toEqual([
      { address: "doc@example.org", detail: "550 doc@example.org unknown" },
      { address: "hidden-bcc@example.org", detail: "550 hidden-bcc@example.org unknown" },
    ]);
  });

  it("reads a spam complaint", () => {
    const parsed = parseSesEvent(JSON.stringify({ eventType: "Complaint", mail, complaint: { complainedRecipients: [{ emailAddress: "doc@example.org" }], complaintFeedbackType: "abuse" } }), NOW);
    expect(parsed.ok && parsed.event).toMatchObject({ kind: "COMPLAINED", recipients: ["doc@example.org"], detail: "abuse", at: NOW });
  });

  it("reads the older notification shape as well", () => {
    const parsed = parseSesEvent(JSON.stringify({ notificationType: "Bounce", mail, bounce: { bounceType: "Transient", bounceSubType: "MailboxFull", bouncedRecipients: [{ emailAddress: "doc@example.org" }] } }));
    expect(parsed.ok && parsed.event).toMatchObject({ kind: "BOUNCED", bounceType: "Transient", bounceSubType: "MailboxFull", detail: null, recipientDetails: [] });
  });

  it("caps a long diagnostic", () => {
    const parsed = parseSesEvent(JSON.stringify({ eventType: "Bounce", mail, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "doc@example.org", diagnosticCode: "x".repeat(900) }] } }));
    expect(parsed.ok && parsed.event.recipientDetails[0].detail.length).toBe(501);
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
  type Status = "DELIVERED" | "BOUNCED" | "COMPLAINED" | null;
  const row = (deliveryStatus: Status, bounceType: string | null = null, bounceSubType: string | null = null) => ({ deliveryStatus, bounceType, bounceSubType });
  const delivered = { kind: "DELIVERED", bounceType: null, bounceSubType: null } as const;
  const complained = { kind: "COMPLAINED", bounceType: null, bounceSubType: null } as const;
  const bounced = (bounceType: string, bounceSubType: string | null = "General") => ({ kind: "BOUNCED", bounceType, bounceSubType }) as const;

  it.each([
    ["first delivery", row(null), delivered, true],
    ["a repeated delivery", row("DELIVERED"), delivered, false],
    ["delivered after a permanent bounce", row("BOUNCED", "Permanent", "General"), delivered, false],
    ["delivered arriving after an automatic reply (Transient, General)", row("BOUNCED", "Transient", "General"), delivered, true],
    ["delivered arriving after a full mailbox: the email did not arrive", row("BOUNCED", "Transient", "MailboxFull"), delivered, false],
    ["delivered after an undetermined bounce", row("BOUNCED", "Undetermined", null), delivered, false],
    ["first bounce", row(null), bounced("Transient", "MailboxFull"), true],
    ["a permanent bounce after delivered", row("DELIVERED"), bounced("Permanent"), true],
    ["an automatic reply after delivered", row("DELIVERED"), bounced("Transient", "General"), false],
    ["a full mailbox reported after delivered (accepted, then sent back)", row("DELIVERED"), bounced("Transient", "MailboxFull"), true],
    ["a refused attachment reported after delivered", row("DELIVERED"), bounced("Transient", "AttachmentRejected"), true],
    ["permanent over transient", row("BOUNCED", "Transient", "MailboxFull"), bounced("Permanent"), true],
    ["transient over permanent", row("BOUNCED", "Permanent", "General"), bounced("Transient", "MailboxFull"), false],
    ["a repeated permanent bounce", row("BOUNCED", "Permanent", "General"), bounced("Permanent"), false],
    ["a complaint after delivered", row("DELIVERED"), complained, true],
    ["anything after a complaint", row("COMPLAINED"), bounced("Permanent"), false],
    ["a repeated complaint", row("COMPLAINED"), complained, false],
  ] as const)("%s", (_name, current, incoming, expected) => {
    expect(shouldReplaceDelivery(current, incoming)).toBe(expected);
  });

  it("ends the same whichever order a delivery and its later report arrive in", () => {
    const settle = (events: readonly { kind: "DELIVERED" | "BOUNCED" | "COMPLAINED"; bounceType: string | null; bounceSubType: string | null }[]) => {
      let state = row(null);
      for (const e of events) {
        if (shouldReplaceDelivery(state, e)) state = { deliveryStatus: e.kind, bounceType: e.bounceType, bounceSubType: e.bounceSubType };
      }
      return state.deliveryStatus;
    };
    for (const later of [bounced("Transient", "General"), bounced("Transient", "MailboxFull"), bounced("Permanent"), complained]) {
      expect(settle([delivered, later])).toBe(settle([later, delivered]));
    }
    expect(settle([delivered, bounced("Transient", "General")])).toBe("DELIVERED");
    expect(settle([delivered, bounced("Transient", "MailboxFull")])).toBe("BOUNCED");
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
