/**
 * venue-ai-service (phase 5B): the daily limit is claimed in the database
 * before Anthropic is called and given back when it never answers; tokens are
 * recorded for the bill; the day is the event's own; AI is on by default.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { mockDb, streamChat, log } = vi.hoisted(() => ({
  mockDb: { venueAiUsage: { upsert: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() } },
  streamChat: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: log }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: vi.fn() }));
vi.mock("@/lib/ai/anthropic", () => ({ anthropicProvider: { streamChat: (...a: unknown[]) => streamChat(...a) } }));
vi.mock("@/lib/ai/credentials", () => ({ resolveAnthropicApiKey: async () => "sk-test" }));

import { claimReply, readVenueAi, streamVenueReply, venueDay, VENUE_AI_PER_EVENT_DAY } from "@/services/venue-ai-service";
import { checkPersona } from "@/lib/venue/ai-prompt";

const caller = { organizationId: "org-1", eventId: "evt-1", userId: "u-1" };
const per = checkPersona({ first: "Layla", last: "Haddad", kind: "delegate", title: "Consultant haematologist", org: "a teaching hospital in Dubai", trait: "warm and talkative", interest: "sickle cell disease" })!;
const scene = { event: { name: "EHC", date: "10 to 12 April 2026", venue: "Conrad Dubai" }, zone: "plenary", pose: "sit", role: "guest", greeting: "Hi" };
const turns = [{ role: "user" as const, content: "Hello" }];

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.venueAiUsage.upsert.mockResolvedValue({});
  mockDb.venueAiUsage.updateMany.mockResolvedValue({ count: 1 });
});

describe("claimReply", () => {
  it("claims with a guarded increment below the daily limit", async () => {
    expect(await claimReply(caller, "2026-10-08")).toBe(true);
    expect(mockDb.venueAiUsage.updateMany).toHaveBeenCalledWith({
      where: { eventId: "evt-1", organizationId: "org-1", day: "2026-10-08", replies: { lt: VENUE_AI_PER_EVENT_DAY } },
      data: { replies: { increment: 1 } },
    });
  });

  it("refuses once the limit is reached", async () => {
    mockDb.venueAiUsage.updateMany.mockResolvedValue({ count: 0 });
    expect(await claimReply(caller, "2026-10-08")).toBe(false);
  });

  it("survives two first replies of the day creating the row at once", async () => {
    mockDb.venueAiUsage.upsert.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    expect(await claimReply(caller, "2026-10-08")).toBe(true);
  });
});

describe("streamVenueReply", () => {
  it("streams the text, sends the server's instructions as the system prompt, and records the tokens", async () => {
    streamChat.mockImplementation(async function* () {
      yield { type: "text", delta: "Hello " };
      yield { type: "text", delta: "there." };
      yield { type: "done", usage: { inputTokens: 900, outputTokens: 20 } };
    });
    const res = await streamVenueReply(caller, "2026-10-08", per, scene, turns);
    expect(res.ok).toBe(true);
    expect(await new Response((res as { stream: ReadableStream }).stream).text()).toBe("Hello there.");
    const opts = streamChat.mock.calls[0][0];
    expect(opts.system[0].text).toContain("You are Dr Layla Haddad, Consultant haematologist");
    expect(opts.messages).toEqual(turns);
    expect(opts.maxTokens).toBe(300);
    expect(mockDb.venueAiUsage.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { inputTokens: { increment: 900 }, outputTokens: { increment: 20 } } }));
  });

  it("gives the claim back and reports AI_UNAVAILABLE when Anthropic fails at once", async () => {
    streamChat.mockImplementation(async function* () {
      throw new Error("401 invalid x-api-key");
    });
    const res = await streamVenueReply(caller, "2026-10-08", per, scene, turns);
    expect(res).toMatchObject({ ok: false, code: "AI_UNAVAILABLE" });
    expect(mockDb.venueAiUsage.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { replies: { decrement: 1 } } }));
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "venue-ai:provider-failed" }));
  });
});

describe("venueDay and readVenueAi", () => {
  it("counts the day in the event's own timezone", () => {
    const lateUtc = new Date("2026-10-08T21:30:00Z"); // 01:30 on the 9th in Dubai
    expect(venueDay("Asia/Dubai", lateUtc)).toBe("2026-10-09");
    expect(venueDay("UTC", lateUtc)).toBe("2026-10-08");
  });

  it("AI attendees are on unless the team switched them off", () => {
    expect(readVenueAi({})).toEqual({ on: true });
    expect(readVenueAi({ venue: { ai: { on: false } } })).toEqual({ on: false });
    expect(readVenueAi(null)).toEqual({ on: true });
  });
});
