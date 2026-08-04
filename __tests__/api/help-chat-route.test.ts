/**
 * POST /api/help-chat — the empty-history-message bug fix (Aug 4, 2026).
 *
 * The client persists its streaming placeholder (an assistant turn with
 * content "") whenever a stream dies before the first delta, and re-sends
 * the FULL history on every question — so one stored empty message used to
 * fail min(1) validation and brick every later question with "Invalid
 * input". The route now FILTERS empty messages before validation so
 * poisoned client histories self-heal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockStreamChat, mockCheckRateLimit, mockApiLogger, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockStreamChat: vi.fn(),
  mockCheckRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockDb: {
    organization: { findUnique: vi.fn().mockResolvedValue(null) },
    helpChatQuery: { create: vi.fn().mockResolvedValue({}), createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/security", () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock("@/lib/help-chat/system-prompt", () => ({ buildSystemPrompt: () => [{ text: "sys" }] }));
vi.mock("@/lib/ai", () => ({
  getAiProvider: () => ({ streamChat: mockStreamChat }),
}));
vi.mock("@/lib/ai/credentials", () => ({
  aiConfigFromSettings: () => ({ provider: "anthropic", apiKey: undefined, source: "env" }),
}));
vi.mock("@/lib/ai/config", () => ({
  getModelConfig: () => ({ model: "m", maxTokens: 100, temperature: 0.3 }),
}));

import { POST } from "@/app/api/help-chat/route";

function makeReq(messages: unknown) {
  return new Request("http://localhost/api/help-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  }) as never;
}

async function drain(res: Response) {
  await res.body?.getReader().read();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockAuth.mockResolvedValue({
    user: { id: "u1", role: "REGISTRANT", organizationId: null, email: "u@t.co", firstName: "U", lastName: "One" },
  });
  mockStreamChat.mockImplementation(async function* () {
    yield { type: "text", delta: "hi" };
    yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
  });
});

describe("POST /api/help-chat — empty-message filtering", () => {
  it("a history poisoned with an empty assistant placeholder is FILTERED and the request succeeds", async () => {
    const res = await POST(
      makeReq([
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "" }, // the poison
        { role: "user", content: "how to configure presentation type" },
      ]),
    );
    expect(res.status).toBe(200);
    await drain(res as unknown as Response);
    expect(mockStreamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "user", content: "earlier question" },
          { role: "user", content: "how to configure presentation type" },
        ],
      }),
    );
  });

  it("whitespace-only messages are filtered too", async () => {
    const res = await POST(
      makeReq([
        { role: "assistant", content: "   " },
        { role: "user", content: "hello" },
      ]),
    );
    expect(res.status).toBe(200);
    await drain(res as unknown as Response);
    expect(mockStreamChat).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ role: "user", content: "hello" }] }),
    );
  });

  it("a history that is ONLY empty messages still 400s honestly", async () => {
    const res = await POST(makeReq([{ role: "assistant", content: "" }]));
    expect(res.status).toBe(400);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "help-chat:zod-validation-failed" }),
    );
  });

  it("filtering can expose a trailing assistant turn → the last-message-must-be-user 400 still fires", async () => {
    const res = await POST(
      makeReq([
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        { role: "user", content: "" }, // empty USER turn filtered → last is assistant
      ]),
    );
    expect(res.status).toBe(400);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "help-chat:last-message-not-user" }),
    );
  });

  it("a normal valid request streams (regression guard)", async () => {
    const res = await POST(makeReq([{ role: "user", content: "hello" }]));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });
});
