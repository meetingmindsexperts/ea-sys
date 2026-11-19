/**
 * POST /api/webhooks/ses (Nov 19, 2026): shut unless the topic is configured,
 * the message names that topic, and Amazon signed it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { verify, record, logger, limiter } = vi.hoisted(() => ({
  verify: vi.fn(),
  record: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  limiter: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/email-delivery", () => ({ recordDeliveryEvent: (e: unknown) => record(e) }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "203.0.113.9", checkRateLimit: (args: { key: string }) => limiter(args) }));
vi.mock("@/lib/ses-events", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ses-events")>();
  return { ...real, verifySnsMessage: (m: unknown) => verify(m) };
});

import { POST } from "@/app/api/webhooks/ses/route";

const TOPIC = "arn:aws:sns:ap-south-1:111122223333:ea-sys-ses-events";
const envelope = (over: Record<string, unknown> = {}) => ({
  Type: "Notification",
  MessageId: "m-1",
  TopicArn: TOPIC,
  Message: JSON.stringify({ eventType: "Bounce", mail: { messageId: "0109-abc" }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "doc@example.org" }] } }),
  Timestamp: "2026-11-19T09:59:30.000Z",
  SignatureVersion: "1",
  Signature: "c2ln",
  SigningCertURL: "https://sns.ap-south-1.amazonaws.com/x.pem",
  ...over,
});
const post = (body: unknown) =>
  POST(new Request("http://x/api/webhooks/ses", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })) as unknown as Promise<{
    status: number;
    json: () => Promise<Record<string, unknown>>;
  }>;

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SES_EVENTS_TOPIC_ARN", TOPIC);
  vi.stubGlobal("fetch", fetchMock);
  verify.mockResolvedValue({ ok: true });
  record.mockResolvedValue("recorded");
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  limiter.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/webhooks/ses", () => {
  it("is shut, and does nothing, until the topic is configured", async () => {
    vi.stubEnv("SES_EVENTS_TOPIC_ARN", "");

    const res = await post(envelope());

    expect(res.status).toBe(503);
    expect(verify).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses text that is not an SNS message", async () => {
    expect((await post("hello")).status).toBe(400);
    expect((await post({ Type: "Notification" })).status).toBe(400);
    expect(verify).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "ses-events:not-an-sns-message" }));
  });

  it("refuses a message from another topic before checking anything else", async () => {
    const res = await post(envelope({ TopicArn: "arn:aws:sns:ap-south-1:999999999999:someone-elses" }));

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("WRONG_TOPIC");
    expect(verify).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses a message Amazon did not sign, and records nothing", async () => {
    verify.mockResolvedValue({ ok: false, reason: "signature-mismatch" });

    const res = await post(envelope());

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("BAD_SIGNATURE");
    expect(record).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "ses-events:signature-refused", reason: "signature-mismatch" }));
  });

  it("records a genuine report and answers 200", async () => {
    const res = await post(envelope());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "recorded" });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: "BOUNCED", messageId: "0109-abc", recipients: ["doc@example.org"], bounceType: "Permanent" }));
  });

  it("answers 200 for a report about an email it has no record of, so SNS does not retry it", async () => {
    record.mockResolvedValue("unknown-message");

    expect((await post(envelope())).status).toBe(200);
  });

  it("asks for the report again (503) when the certificate could not be fetched: SNS never retries a 4xx", async () => {
    verify.mockResolvedValue({ ok: false, reason: "certificate-unavailable", retryable: true });

    const res = await post(envelope());

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("CERTIFICATE_UNAVAILABLE");
    expect(record).not.toHaveBeenCalled();
  });

  it("asks for the report again when it beat the email's own log row", async () => {
    record.mockResolvedValue("unknown-message");
    const justNow = new Date(Date.now() - 2_000).toISOString();
    const young = JSON.stringify({ eventType: "Bounce", mail: { messageId: "0109-abc", timestamp: justNow }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "doc@example.org" }] } });

    const res = await post(envelope({ Message: young }));

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("EMAIL_NOT_LOGGED_YET");
  });

  it("gives up on an unknown email once the report is older than half a minute", async () => {
    record.mockResolvedValue("unknown-message");
    const aWhileAgo = new Date(Date.now() - 45_000).toISOString();
    const old = JSON.stringify({ eventType: "Bounce", mail: { messageId: "0109-abc", timestamp: aWhileAgo }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "doc@example.org" }] } });

    expect((await post(envelope({ Message: old }))).status).toBe(200);
  });

  it("writes at most a short clip of a stranger's text to the log", async () => {
    const huge = "arn:aws:sns:ap-south-1:999999999999:" + "x".repeat(50_000);

    await post(envelope({ TopicArn: huge }));

    const line = logger.warn.mock.calls.find((c) => (c[0] as { msg?: string }).msg === "ses-events:wrong-topic")?.[0] as { topicArn: string };
    expect(line.topicArn.length).toBeLessThanOrEqual(121);
    expect(JSON.stringify(logger.warn.mock.calls).length).toBeLessThan(2_000);
  });

  it("stops logging, and answers 429, once an address has been refused too often", async () => {
    limiter.mockImplementation(({ key }: { key: string }) => ({ allowed: !key.startsWith("ses-events-refused:"), retryAfterSeconds: 30 }));

    const res = await post(envelope({ TopicArn: "arn:aws:sns:ap-south-1:999999999999:someone-elses" }));

    expect(res.status).toBe(429);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(limiter).toHaveBeenCalledWith(expect.objectContaining({ key: "ses-events-refused:203.0.113.9" }));
  });

  it("answers 429 before reading anything when an address posts far too fast", async () => {
    limiter.mockReturnValue({ allowed: false, retryAfterSeconds: 30 });

    const res = await post(envelope());

    expect(res.status).toBe(429);
    expect(verify).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses a body longer than a genuine message can be, without parsing it", async () => {
    const res = await post("x".repeat(400_001));

    expect(res.status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls).length).toBeLessThan(500);
  });

  it("does not count a genuine report as a refusal", async () => {
    await post(envelope());

    expect(limiter.mock.calls.map((c) => (c[0] as { key: string }).key)).toEqual(["ses-events:203.0.113.9"]);
  });

  it("answers 200 and keeps nothing for a kind of report it does not use", async () => {
    const res = await post(envelope({ Message: JSON.stringify({ eventType: "Send", mail: { messageId: "0109-abc" }, send: {} }) }));

    expect(res.status).toBe(200);
    expect(record).not.toHaveBeenCalled();
  });

  it("answers 503 when the write fails, so SNS tries that report again", async () => {
    record.mockRejectedValue(new Error("db down"));

    const res = await post(envelope());

    expect(res.status).toBe(503);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "ses-events:record-failed" }));
  });

  it("confirms a subscription by visiting Amazon's link, after the signature", async () => {
    const link = "https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&Token=t";

    const res = await post(envelope({ Type: "SubscriptionConfirmation", SubscribeURL: link, Token: "t" }));

    expect(res.status).toBe(200);
    expect(verify).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(link);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ msg: "ses-events:subscription-confirmed" }));
  });

  it("never visits a confirmation link that is not Amazon's", async () => {
    const res = await post(envelope({ Type: "SubscriptionConfirmation", SubscribeURL: "https://evil.example/collect", Token: "t" }));

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never visits a confirmation link in another region than the topic's", async () => {
    const res = await post(envelope({ Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.us-east-1.amazonaws.com/?x=1", Token: "t" }));

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not confirm when the signature is refused", async () => {
    verify.mockResolvedValue({ ok: false, reason: "signature-mismatch" });

    await post(envelope({ Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.ap-south-1.amazonaws.com/?x=1", Token: "t" }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a confirmation Amazon refused", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400 });

    const res = await post(envelope({ Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.ap-south-1.amazonaws.com/?x=1", Token: "t" }));

    expect(res.status).toBe(502);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "ses-events:subscription-confirm-refused" }));
  });

  it("notes when the subscription is removed", async () => {
    const res = await post(envelope({ Type: "UnsubscribeConfirmation", SubscribeURL: "https://sns.ap-south-1.amazonaws.com/?x=1", Token: "t" }));

    expect(res.status).toBe(200);
    expect(record).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "ses-events:unsubscribed" }));
  });
});
