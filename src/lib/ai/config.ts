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

export type AiFeature = "helpChat" | "agent" | "blueprintQuick" | "blueprintDefault" | "venueAttendee";

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
export const HELP_CHAT_MODEL_OPENAI_DEFAULT = "gpt-4o";
export const AGENT_MODEL_DEFAULT = "claude-sonnet-4-6";
/** Event Blueprint: the vendor page's two tiers ("quick" and "default"). */
export const BLUEPRINT_QUICK_MODEL_DEFAULT = "claude-haiku-4-5-20251001";
export const BLUEPRINT_MODEL_DEFAULT = "claude-sonnet-4-6";
/** Online venue AI attendees: the vendor page asks for the "quick" tier. */
export const VENUE_ATTENDEE_MODEL_DEFAULT = "claude-haiku-4-5-20251001";

/**
 * `provider` (default anthropic) picks the model id lane for features that
 * support per-org provider choice (Help Chat). Token caps + temperature are
 * provider-independent — they're the cost/quality levers, not vendor knobs.
 */
export function getModelConfig(
  feature: AiFeature,
  provider: "anthropic" | "openai" = "anthropic",
): ModelConfig {
  switch (feature) {
    case "helpChat":
      if (provider === "openai") {
        return {
          // gpt-4o — the broadly-available OpenAI tier for KB Q&A; env
          // override lets prod pin a successor without a deploy.
          model: process.env.HELP_CHAT_MODEL_OPENAI || HELP_CHAT_MODEL_OPENAI_DEFAULT,
          maxTokens: 1500,
          temperature: 0.3,
        };
      }
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
    case "blueprintQuick":
      // Event Blueprint suggestions (spaces, run of show, audience mix, a
      // short quick fill): small JSON answers, so the fast tier. 4096 holds
      // the largest (a 12-item programme) with room.
      return { model: process.env.BLUEPRINT_MODEL_QUICK || BLUEPRINT_QUICK_MODEL_DEFAULT, maxTokens: 4096, temperature: 0.4 };
    case "blueprintDefault":
      // Three full concepts, or a quick fill from a long document or a
      // picture: needs the stronger model and more room.
      return { model: process.env.BLUEPRINT_MODEL || BLUEPRINT_MODEL_DEFAULT, maxTokens: 8192, temperature: 0.7 };
    case "venueAttendee":
      // An AI attendee's reply in the online venue: 1 to 3 short sentences
      // and a gesture tag, so 300 tokens is ample and a runaway reply stops
      // here. Every reply is paid on MM Group's key (plan §5.4a), so the cap
      // is also the cost lever. 0.8: varied small talk, not a factual answer.
      return { model: process.env.VENUE_ATTENDEE_MODEL || VENUE_ATTENDEE_MODEL_DEFAULT, maxTokens: 300, temperature: 0.8 };
    case "agent":
      // Consumed by the Event Agent route
      // (src/app/api/events/[eventId]/agent/execute/route.ts) since
      // September 21, 2026; the route names no model of its own. The
      // agent still calls the Anthropic SDK directly for its tool loop,
      // so only the model, cap and temperature come from here.
      return {
        model: process.env.AGENT_MODEL || AGENT_MODEL_DEFAULT,
        // 4096 until September 22, 2026: three email bodies in one turn
        // overran it (golden W9, and the same request on production), and
        // the reply stopped at "I'll now create all three". A turn that
        // writes several HTML bodies needs room; a runaway reply still
        // stops here, and the loop now reports a cut reply as an error.
        maxTokens: 16384,
        // The SDK default; the lever to tighten the agent's behaviour
        // when the readiness eval (E5) says so.
        temperature: 1.0,
      };
  }
}
