/**
 * The send-boundary invariant (Sep 11, 2026, AGENTS.md rule 12): sendEmail
 * refuses any email whose rendered subject or body still carries a {{token}},
 * names the tokens, logs at error, writes a FAILED row, and returns
 * code UNRESOLVED_TOKENS. Operator mail (noEntityContext) is exempt. Also pins
 * that the renderers normalise editor-mangled tokens before substituting.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { logEmailSpy, sesSendMock, logger } = vi.hoisted(() => ({
  logEmailSpy: vi.fn(async () => undefined),
  sesSendMock: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
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

import { renderTemplate, renderTemplatePlain, sendEmail } from "@/lib/email";

const to = [{ email: "jane@x.com", name: "Jane" }];
const ctx = { eventId: "ev1", entityType: "REGISTRATION" as const, entityId: "reg1", templateSlug: "joining", organizationId: "org1" };

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  sesSendMock.mockResolvedValue({ MessageId: "m1" });
});

describe("sendEmail refuses unresolved tokens", () => {
  it("refuses with UNRESOLVED_TOKENS naming every leftover, never reaches the provider, writes a FAILED row and an error log", async () => {
    const res = await sendEmail({ to, subject: "Hi {{firstName}}", htmlContent: "<p>Room: {{<span>rsvpButton</span>}}</p>", logContext: ctx });
    expect(res).toMatchObject({ success: false, code: "UNRESOLVED_TOKENS" });
    expect(res.error).toContain("{{firstName}}");
    expect(res.error).toContain("{{rsvpButton}}");
    expect(sesSendMock).not.toHaveBeenCalled();
    await flush();
    const lastCall = logEmailSpy.mock.calls.at(-1) as unknown as unknown[];
    const row = lastCall[0] as { status: string; errorMessage?: string; context?: unknown };
    expect(row.status).toBe("FAILED");
    expect(row.errorMessage).toContain("unresolved_tokens: {{firstName}}, {{rsvpButton}}");
    expect(row.context).toEqual(ctx);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "email:unresolved-tokens", tokens: ["firstName", "rsvpButton"], templateSlug: "joining", eventId: "ev1" }),
    );
  });

  it("sends a clean email exactly as before", async () => {
    const res = await sendEmail({ to, subject: "Hi Jane", htmlContent: "<p>Dear Jane</p>", logContext: ctx });
    expect(res.success).toBe(true);
    expect(sesSendMock).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("a leftover only in the text part is logged at warn but does not block the send", async () => {
    const res = await sendEmail({ to, subject: "Hi", htmlContent: "<p>ok</p>", textContent: "ok {{presenterFeeBlockText}}", logContext: ctx });
    expect(res.success).toBe(true);
    expect(sesSendMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "email:unresolved-tokens-in-text-part", tokens: ["presenterFeeBlockText"] }));
  });

  it("operator mail (noEntityContext) is exempt, because it quotes log lines that mention tokens", async () => {
    const res = await sendEmail({ to, subject: "Alert", htmlContent: "<pre>email:unresolved-tokens {{rsvpButton}}</pre>", noEntityContext: true });
    expect(res.success).toBe(true);
    expect(sesSendMock).toHaveBeenCalledTimes(1);
  });
});

describe("the renderers normalise editor-mangled tokens before substituting", () => {
  it("renderTemplate resolves {{<span>x</span>}} and renderTemplatePlain resolves a spaced token", () => {
    expect(renderTemplate("<p>{{<span>rsvpButton</span>}}</p>", { rsvpButton: "<a>B</a>" }, new Set(["rsvpButton"]))).toBe("<p><a>B</a></p>");
    expect(renderTemplatePlain("Hi {{ firstName }}", { firstName: "Jane" })).toBe("Hi Jane");
  });
});
