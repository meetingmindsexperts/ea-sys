/**
 * A threaded reply goes out as RAW MIME (Oct 27, 2026 review): its
 * In-Reply-To / References are written by our own builder rather than relying
 * on which headers SES's Simple path accepts. An ordinary email without
 * attachments still uses the Simple path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sesSendMock } = vi.hoisted(() => ({ sesSendMock: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email-log", () => ({ logEmail: vi.fn(async () => undefined) }));
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

import { sendEmail } from "@/lib/email";

type SesInput = { input: { Content: { Raw?: { Data: Uint8Array }; Simple?: unknown } } };

const MAIL = {
  to: [{ email: "sponsor@example.com" }],
  subject: "Re: Sponsorship",
  htmlContent: "<p>Thanks</p>",
  noEntityContext: true,
};

describe("sendEmail with threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sesSendMock.mockResolvedValue({ MessageId: "ses-9" });
  });

  it("sends a threaded reply raw, with both headers", async () => {
    const res = await sendEmail({
      ...MAIL,
      threading: { inReplyTo: "<b@outlook.com>", references: ["<a@amazonses.com>", "<b@outlook.com>"] },
    });
    expect(res.success).toBe(true);
    const sent = sesSendMock.mock.calls[0]![0] as SesInput;
    expect(sent.input.Content.Simple).toBeUndefined();
    const mime = new TextDecoder().decode(sent.input.Content.Raw!.Data);
    expect(mime).toContain("In-Reply-To: <b@outlook.com>");
    expect(mime).toContain("References: <a@amazonses.com> <b@outlook.com>");
  });

  it("keeps the Simple path for an ordinary email", async () => {
    await sendEmail(MAIL);
    const sent = sesSendMock.mock.calls[0]![0] as SesInput;
    expect(sent.input.Content.Simple).toBeDefined();
    expect(sent.input.Content.Raw).toBeUndefined();
  });

  it("an invalid parent id leaves an ordinary email on the Simple path", async () => {
    await sendEmail({ ...MAIL, threading: { inReplyTo: "bad", references: [] } });
    expect((sesSendMock.mock.calls[0]![0] as SesInput).input.Content.Simple).toBeDefined();
  });
});
