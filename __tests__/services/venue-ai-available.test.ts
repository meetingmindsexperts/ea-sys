/**
 * venueAiAccess (venue tenancy review, Oct 27): on the multi-tenant platform AI attendees run only on the
 * organisation's own Anthropic key, and the reply runs on exactly the key that was checked, never the platform's
 * (review MED); on master, as before, the usual org-then-env resolution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, log, creds, provider } = vi.hoisted(() => ({
  mockDb: { organization: { findUnique: vi.fn() }, venueAiUsage: { updateMany: vi.fn() } },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  creds: { ownAnthropicKey: vi.fn(), resolveAnthropicApiKey: vi.fn() },
  provider: { streamChat: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: log }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/ai/credentials", () => creds);
vi.mock("@/lib/ai/anthropic", () => ({ anthropicProvider: provider }));
vi.mock("@/lib/ai/config", () => ({ getModelConfig: () => ({ model: "m", maxTokens: 100, temperature: 0.5 }) }));
vi.mock("@/lib/venue/ai-prompt", () => ({ buildInstructions: () => "rules" }));

import { streamVenueReply, venueAiAccess } from "@/services/venue-ai-service";
import type { Persona } from "@/lib/venue/ai-prompt";

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.organization.findUnique.mockResolvedValue({ settings: { anthropic: { apiKeyEncrypted: "x" } } });
  provider.streamChat.mockImplementation(async function* () {
    yield { type: "text", delta: "Hi." };
    yield { type: "done" };
  });
  creds.resolveAnthropicApiKey.mockResolvedValue("env-or-org-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("venueAiAccess", () => {
  it("master: allowed, without reading the organisation, on the usual key resolution", async () => {
    vi.stubEnv("TENANCY_ENFORCE_HOST", "");
    expect(await venueAiAccess("org-1")).toEqual({ ok: true });
    expect(mockDb.organization.findUnique).not.toHaveBeenCalled();
  });

  it("platform: allowed only with the organisation's own key, which it hands back", async () => {
    vi.stubEnv("TENANCY_ENFORCE_HOST", "1");
    creds.ownAnthropicKey.mockReturnValue("org-own-key");
    expect(await venueAiAccess("org-1")).toEqual({ ok: true, apiKey: "org-own-key" });
    expect(mockDb.organization.findUnique).toHaveBeenCalledWith({ where: { id: "org-1" }, select: { settings: true } });
    creds.ownAnthropicKey.mockReturnValue(null);
    expect(await venueAiAccess("org-2")).toEqual({ ok: false });
  });

  it("platform: a failed read refuses, and logs it", async () => {
    vi.stubEnv("TENANCY_ENFORCE_HOST", "1");
    mockDb.organization.findUnique.mockRejectedValue(new Error("db down"));
    expect(await venueAiAccess("org-1")).toEqual({ ok: false });
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "venue-ai:key-check-failed" }));
  });
});

describe("streamVenueReply's key", () => {
  const caller = { organizationId: "org-1", eventId: "evt-1", userId: "u-1" };
  const per = { name: "A" } as Persona;
  const run = async (access?: Parameters<typeof streamVenueReply>[5]) => {
    const res = await streamVenueReply(caller, "2027-01-01", per, { event: { name: "", date: "", venue: "" }, zone: "", pose: "", role: "", greeting: "" }, [{ role: "user", content: "hi" }], access);
    if (res.ok) await new Response(res.stream).text();
    return provider.streamChat.mock.calls[0][0].apiKey;
  };

  it("runs on exactly the key that was checked, never re-resolving to the platform's", async () => {
    expect(await run({ ok: true, apiKey: "org-own-key" })).toBe("org-own-key");
    expect(creds.resolveAnthropicApiKey).not.toHaveBeenCalled();
  });

  it("without one (master), resolves as before", async () => {
    expect(await run()).toBe("env-or-org-key");
    expect(creds.resolveAnthropicApiKey).toHaveBeenCalledWith("org-1");
  });
});
