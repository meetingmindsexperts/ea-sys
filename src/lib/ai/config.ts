/**
 * Central registry of model + sampling configuration per AI feature.
 *
 * Why central:
 *   - One place to see what's running where. No greps for
 *     "claude-sonnet-4-6" hardcoded across routes.
 *   - Cost / behavior tuning is a single-file change.
 *   - Future model / provider swaps stay config flips, not rewrites.
 *
 * Env-overridable: model ids only (so prod can pin a successor model
 * without a code change + redeploy when Anthropic ships a new tier).
 * `maxTokens` and `temperature` stay code constants — they're the
 * primary cost / quality levers, and env overrides there are too easy
 * to set wrong without anyone noticing the bill.
 *
 * Slots are reserved for features that aren't on the `AiProvider`
 * abstraction yet — the existing AI Agent imports `@anthropic-ai/sdk`
 * directly today; the v1.1 retrofit will route it through here. Until
 * that retrofit lands, the SOURCE OF TRUTH for the agent's model is
 * its route handler, not this file — the `agent` slot below documents
 * what we'll move TO, not what's running RIGHT NOW.
 */

export type AiFeature = "helpChat" | "agent";

export interface ModelConfig {
  /** Provider-specific model id (e.g. `"claude-sonnet-4-6"`). */
  model: string;
  /** Hard cap on output tokens per response. */
  maxTokens: number;
  /** Sampling temperature; lower = more deterministic. */
  temperature: number;
}

/** Code defaults. Surfaced as named constants so test assertions stay
 *  stable across env changes. */
export const HELP_CHAT_MODEL_DEFAULT = "claude-sonnet-4-6";
export const AGENT_MODEL_DEFAULT = "claude-sonnet-4-6";

export function getModelConfig(feature: AiFeature): ModelConfig {
  switch (feature) {
    case "helpChat":
      return {
        // Sonnet 4.6 — best refusal + role-aware reasoning at the right
        // cost tier for KB Q&A (Opus overkill, Haiku misses RBAC /
        // finance nuance). Env override lets prod pin a successor
        // model without a deploy.
        model: process.env.HELP_CHAT_MODEL || HELP_CHAT_MODEL_DEFAULT,
        // ~800 words; enough for thorough answers without runaway
        // responses. Code-only because it's the primary cost lever.
        maxTokens: 1500,
        // 0.3 — mostly deterministic with slight variety. For a
        // KB-grounded Q&A bot we want consistency + low hallucination
        // probability; higher temperatures invite invention (which is
        // exactly what we DON'T want a help bot doing).
        temperature: 0.3,
      };
    case "agent":
      // RESERVED for the v1.1 retrofit. Today's AI Agent inlines these
      // in its route handler — do not consume `getModelConfig("agent")`
      // from anywhere else until the retrofit lands and the route
      // migrates onto this registry.
      return {
        model: process.env.AGENT_MODEL || AGENT_MODEL_DEFAULT,
        // Matches the agent's current hardcoded value at
        // src/app/api/events/[eventId]/agent/execute/route.ts.
        maxTokens: 4096,
        // The agent doesn't currently override temperature; this is
        // the SDK default. When the retrofit lands and we want to
        // tighten the agent's behavior, this is the lever.
        temperature: 1.0,
      };
  }
}
