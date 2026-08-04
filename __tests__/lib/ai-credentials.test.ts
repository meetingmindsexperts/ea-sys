/**
 * Per-org AI credential resolution (src/lib/ai/credentials.ts):
 *  - aiConfigFromSettings — the Help Chat provider/key truth table incl. the
 *    misconfigured-preference fallback (never brick help chat).
 *  - resolveAnthropicApiKey — the Event Agent's org→env chain with the
 *    IDENTICAL legacy throw message when neither key exists.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { orgFindUnique, mockApiLogger } = vi.hoisted(() => ({
  orgFindUnique: vi.fn(),
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: { organization: { findUnique: orgFindUnique } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

import { aiConfigFromSettings, resolveAnthropicApiKey } from "@/lib/ai/credentials";
import { encryptSecret } from "@/lib/eventsair-client";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "test-secret-for-crypto";
  process.env.ANTHROPIC_API_KEY = "sk-ant-env";
  process.env.OPENAI_API_KEY = "sk-oai-env";
});

describe("aiConfigFromSettings", () => {
  it("null settings (org-null asker) → anthropic + env", () => {
    expect(aiConfigFromSettings(null)).toEqual({
      provider: "anthropic",
      apiKey: undefined,
      source: "env",
    });
  });

  it("no ai prefs, org anthropic key stored → anthropic + org key", () => {
    const cfg = aiConfigFromSettings({
      anthropic: { apiKeyEncrypted: encryptSecret("sk-ant-org") },
    });
    expect(cfg).toEqual({ provider: "anthropic", apiKey: "sk-ant-org", source: "org" });
  });

  it("preference openai + org openai key → openai + org key", () => {
    const cfg = aiConfigFromSettings({
      ai: { helpChatProvider: "openai" },
      openai: { apiKeyEncrypted: encryptSecret("sk-oai-org") },
    });
    expect(cfg).toEqual({ provider: "openai", apiKey: "sk-oai-org", source: "org" });
  });

  it("preference openai, no org key, env OPENAI_API_KEY present → openai + env", () => {
    const cfg = aiConfigFromSettings({ ai: { helpChatProvider: "openai" } });
    expect(cfg).toEqual({ provider: "openai", apiKey: undefined, source: "env" });
  });

  it("preference openai with NO openai key anywhere → falls back to anthropic + warn (never bricks help chat)", () => {
    delete process.env.OPENAI_API_KEY;
    const cfg = aiConfigFromSettings(
      { ai: { helpChatProvider: "openai" } },
      { organizationId: "org1" },
    );
    expect(cfg).toEqual({ provider: "anthropic", apiKey: undefined, source: "env" });
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringContaining("preferred-provider-has-no-key"),
        preferred: "openai",
        organizationId: "org1",
      }),
    );
  });

  it("openai-preference fallback still uses the org's ANTHROPIC key when stored", () => {
    delete process.env.OPENAI_API_KEY;
    const cfg = aiConfigFromSettings({
      ai: { helpChatProvider: "openai" },
      anthropic: { apiKeyEncrypted: encryptSecret("sk-ant-org") },
    });
    expect(cfg).toEqual({ provider: "anthropic", apiKey: "sk-ant-org", source: "org" });
  });

  it("corrupt ciphertext degrades to env + error log (a bad row must not 500 every chat)", () => {
    const cfg = aiConfigFromSettings(
      { anthropic: { apiKeyEncrypted: "not:valid:ct" } },
      { organizationId: "org1" },
    );
    expect(cfg).toEqual({ provider: "anthropic", apiKey: undefined, source: "env" });
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining("decrypt-failed"), provider: "anthropic" }),
    );
  });

  it("unknown provider preference value → anthropic (settings-write path validates; this guards stale JSON)", () => {
    const cfg = aiConfigFromSettings({ ai: { helpChatProvider: "gemini" } });
    expect(cfg.provider).toBe("anthropic");
  });
});

describe("resolveAnthropicApiKey (Event Agent)", () => {
  it("org key stored → org key", async () => {
    orgFindUnique.mockResolvedValue({
      settings: { anthropic: { apiKeyEncrypted: encryptSecret("sk-ant-org") } },
    });
    expect(await resolveAnthropicApiKey("org1")).toBe("sk-ant-org");
  });

  it("org without a key → env", async () => {
    orgFindUnique.mockResolvedValue({ settings: {} });
    expect(await resolveAnthropicApiKey("org1")).toBe("sk-ant-env");
  });

  it("null org → env, no DB read", async () => {
    expect(await resolveAnthropicApiKey(null)).toBe("sk-ant-env");
    expect(orgFindUnique).not.toHaveBeenCalled();
  });

  it("DB read failure → env fallback + error log", async () => {
    orgFindUnique.mockRejectedValue(new Error("pool"));
    expect(await resolveAnthropicApiKey("org1")).toBe("sk-ant-env");
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining("org-settings-read-failed") }),
    );
  });

  it("neither org nor env key → the IDENTICAL legacy throw message", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    orgFindUnique.mockResolvedValue({ settings: {} });
    await expect(resolveAnthropicApiKey("org1")).rejects.toThrow(
      "ANTHROPIC_API_KEY is not set — cannot use the Anthropic AI provider.",
    );
  });
});
