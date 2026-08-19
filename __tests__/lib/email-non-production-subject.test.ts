/**
 * Non-production subject marker (Aug 19, 2026).
 *
 * A test invoice is byte-identical to a real one in an inbox: same branding,
 * same sender, same attached PDF carrying a real-looking number. The recipient
 * cannot tell which machine produced it, which is how a local run gets chased
 * as a real payment.
 *
 * The load-bearing property is the DEFAULT: anything that is not explicitly
 * production gets marked. A marker on a real invoice is embarrassing and
 * instantly visible; a missing marker on a test invoice is silent, and silent
 * is the failure mode being fixed. The environment truth table below is the
 * whole point of this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { logEmailSpy, sesSendMock } = vi.hoisted(() => ({
  logEmailSpy: vi.fn(async () => undefined),
  sesSendMock: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email-log", () => ({ logEmail: logEmailSpy }));
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    send = sesSendMock;
    get config() {
      return { credentials: async () => ({ accessKeyId: "AKIATEST" }) };
    }
  },
  SendEmailCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { markNonProductionSubject, sendEmail } from "@/lib/email";

const SUBJECT = "Invoice BIGSKY2027-INV-001 for 10th Big Sky Cardiology Update";
const MARKER = "[LOCAL TEST - IGNORE]";

describe("markNonProductionSubject", () => {
  it("leaves production subjects untouched", () => {
    expect(markNonProductionSubject(SUBJECT, { NODE_ENV: "production" })).toBe(SUBJECT);
  });

  it("leaves test-run subjects untouched", () => {
    // Nobody reads an inbox during vitest, and marking here would break every
    // existing assertion on an exact subject for an unrelated reason.
    expect(markNonProductionSubject(SUBJECT, { NODE_ENV: "test" })).toBe(SUBJECT);
  });

  it("marks development", () => {
    expect(markNonProductionSubject(SUBJECT, { NODE_ENV: "development" })).toBe(
      `${MARKER} ${SUBJECT}`,
    );
  });

  it("marks an environment it does not recognise", () => {
    // The default must be LOUD. A new environment that nobody thought about
    // sends marked mail rather than mail indistinguishable from production.
    expect(markNonProductionSubject(SUBJECT, { NODE_ENV: "staging" })).toBe(
      `${MARKER} ${SUBJECT}`,
    );
    expect(markNonProductionSubject(SUBJECT, {})).toBe(`${MARKER} ${SUBJECT}`);
  });

  it("does not stack on an already-marked subject", () => {
    // A bulk retry re-sends the same subject; two prefixes would be noise.
    const once = markNonProductionSubject(SUBJECT, { NODE_ENV: "development" });
    expect(markNonProductionSubject(once, { NODE_ENV: "development" })).toBe(once);
  });

  it("honours a custom prefix", () => {
    expect(
      markNonProductionSubject(SUBJECT, {
        NODE_ENV: "development",
        EMAIL_TEST_SUBJECT_PREFIX: "[KRISHNA LAPTOP]",
      }),
    ).toBe(`[KRISHNA LAPTOP] ${SUBJECT}`);
  });

  it("treats an empty custom prefix as off, without leaving a stray space", () => {
    expect(
      markNonProductionSubject(SUBJECT, {
        NODE_ENV: "development",
        EMAIL_TEST_SUBJECT_PREFIX: "   ",
      }),
    ).toBe(SUBJECT);
  });

  it("can be forced on a box that runs NODE_ENV=production but is not prod", () => {
    // Staging and DR rehearsal boxes are where this mistake is easiest to make,
    // because they look like production to every other check.
    expect(
      markNonProductionSubject(SUBJECT, {
        NODE_ENV: "production",
        EMAIL_FORCE_TEST_SUBJECT_PREFIX: "1",
      }),
    ).toBe(`${MARKER} ${SUBJECT}`);
  });
});

describe("sendEmail applies the marker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sesSendMock.mockResolvedValue({ MessageId: "msg-1" });
    process.env.EMAIL_FORCE_TEST_SUBJECT_PREFIX = "1";
  });

  afterEach(() => {
    delete process.env.EMAIL_FORCE_TEST_SUBJECT_PREFIX;
  });

  it("marks the subject that reaches the provider AND the audit row", async () => {
    // Asserting the helper alone would pass even if sendEmail never called it
    // (the "assert the effect, not the unit" lesson). This pins the wiring.
    await sendEmail({
      to: [{ email: "payer@example.com" }],
      subject: SUBJECT,
      htmlContent: "<p>hi</p>",
      noEntityContext: true,
    });

    const sent = sesSendMock.mock.calls[0][0] as { input: { Content: { Simple: { Subject: { Data: string } } } } };
    expect(sent.input.Content.Simple.Subject.Data).toBe(`${MARKER} ${SUBJECT}`);

    // The history must agree with what actually went out, otherwise the audit
    // trail disagrees with the recipient's inbox.
    expect(logEmailSpy).toHaveBeenCalledWith(
      expect.objectContaining({ subject: `${MARKER} ${SUBJECT}` }),
    );
  });
});
