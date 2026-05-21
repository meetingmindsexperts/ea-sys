/**
 * Tests for the central AI model + sampling registry.
 *
 * These pin: the per-feature defaults, the env-override semantics
 * (model only — tokens/temperature stay code constants by design),
 * and the documentation-of-future-state behavior of the `agent` slot.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AGENT_MODEL_DEFAULT,
  HELP_CHAT_MODEL_DEFAULT,
  getModelConfig,
} from "@/lib/ai/config";

const ORIGINAL_HELP_CHAT_MODEL = process.env.HELP_CHAT_MODEL;
const ORIGINAL_AGENT_MODEL = process.env.AGENT_MODEL;

beforeEach(() => {
  delete process.env.HELP_CHAT_MODEL;
  delete process.env.AGENT_MODEL;
});

afterEach(() => {
  if (ORIGINAL_HELP_CHAT_MODEL !== undefined) {
    process.env.HELP_CHAT_MODEL = ORIGINAL_HELP_CHAT_MODEL;
  }
  if (ORIGINAL_AGENT_MODEL !== undefined) {
    process.env.AGENT_MODEL = ORIGINAL_AGENT_MODEL;
  }
});

describe("getModelConfig — defaults", () => {
  it("helpChat: returns Sonnet 4.6 by default with the cost/quality-tuned values", () => {
    const c = getModelConfig("helpChat");
    expect(c.model).toBe(HELP_CHAT_MODEL_DEFAULT);
    expect(c.model).toBe("claude-sonnet-4-6");
    // ~800-word ceiling — primary cost lever. Pinned so a casual
    // change to "make answers longer" gets caught in review.
    expect(c.maxTokens).toBe(1500);
    // Q&A grounded in a KB: keep deterministic, low hallucination.
    expect(c.temperature).toBe(0.3);
  });

  it("agent: documents the v1.1 retrofit target with current agent settings", () => {
    const c = getModelConfig("agent");
    expect(c.model).toBe(AGENT_MODEL_DEFAULT);
    // The agent currently inlines max_tokens: 4096 in its route.
    // If that value diverges, the retrofit will be misleading.
    expect(c.maxTokens).toBe(4096);
    // SDK default — the agent doesn't override today.
    expect(c.temperature).toBe(1.0);
  });
});

describe("getModelConfig — env override semantics", () => {
  it("helpChat: HELP_CHAT_MODEL env var overrides the model id", () => {
    process.env.HELP_CHAT_MODEL = "claude-sonnet-4-7";
    const c = getModelConfig("helpChat");
    expect(c.model).toBe("claude-sonnet-4-7");
    // Tokens + temperature still come from code constants —
    // deliberately NOT env-tunable.
    expect(c.maxTokens).toBe(1500);
    expect(c.temperature).toBe(0.3);
  });

  it("helpChat: empty-string env var falls back to default (truthy check)", () => {
    process.env.HELP_CHAT_MODEL = "";
    expect(getModelConfig("helpChat").model).toBe(HELP_CHAT_MODEL_DEFAULT);
  });

  it("agent: AGENT_MODEL env var overrides the model id", () => {
    process.env.AGENT_MODEL = "claude-opus-4-7";
    const c = getModelConfig("agent");
    expect(c.model).toBe("claude-opus-4-7");
    expect(c.maxTokens).toBe(4096);
  });

  it("env vars are isolated per feature (helpChat override doesn't bleed into agent)", () => {
    process.env.HELP_CHAT_MODEL = "X";
    expect(getModelConfig("agent").model).toBe(AGENT_MODEL_DEFAULT);
  });
});

describe("getModelConfig — exhaustiveness", () => {
  it("returns a config for every declared AiFeature (compile-time exhaustiveness)", () => {
    // If a new AiFeature is added without a switch arm, TS will fail
    // the build. This test mirrors that at runtime so a `switch (x as
    // any)` slip would still surface.
    const features = ["helpChat", "agent"] as const;
    for (const f of features) {
      const c = getModelConfig(f);
      expect(c.model).toBeTruthy();
      expect(c.maxTokens).toBeGreaterThan(0);
      expect(c.temperature).toBeGreaterThanOrEqual(0);
    }
  });
});
