/**
 * Per-organization AI credentials (Platform decision item 7, Aug 4 2026).
 *
 * Storage (the Zoom/EventsAir pattern — encrypted in `Organization.settings`,
 * written by /api/organization/ai/credentials):
 *   settings.anthropic = { apiKeyEncrypted, apiKeyLast4, configuredAt }
 *   settings.openai    = { apiKeyEncrypted, apiKeyLast4, configuredAt }
 *   settings.ai        = { helpChatProvider: "anthropic" | "openai" }
 *
 * Resolution chain everywhere: org key → that provider's env var. Master
 * (nothing configured) keeps running Help Chat on Anthropic + env, byte-
 * identical to the pre-feature behavior.
 *
 * This file exists SEPARATE from the provider adapters so that `db` never
 * enters anthropic.ts/openai.ts (their unit tests stay hermetic).
 */

import { decryptSecret } from "@/lib/eventsair-client";
import { apiLogger } from "@/lib/logger";
import type { AiProviderName } from "./index";

type ProviderKeySettings = { apiKeyEncrypted?: string };

const ENV_KEY_FOR: Record<AiProviderName, () => string | undefined> = {
  anthropic: () => process.env.ANTHROPIC_API_KEY,
  openai: () => process.env.OPENAI_API_KEY,
};

function readSub(settings: unknown, key: string): Record<string, unknown> | null {
  if (typeof settings !== "object" || settings === null) return null;
  const sub = (settings as Record<string, unknown>)[key];
  if (typeof sub !== "object" || sub === null) return null;
  return sub as Record<string, unknown>;
}

/** The org's stored key for a provider (decrypted), or null when absent. */
function orgKeyFromSettings(settings: unknown, provider: AiProviderName): string | null {
  const sub = readSub(settings, provider) as ProviderKeySettings | null;
  if (!sub?.apiKeyEncrypted) return null;
  return decryptSecret(sub.apiKeyEncrypted);
}

export interface ResolvedAiConfig {
  provider: AiProviderName;
  /** Undefined → the provider adapter uses its env-var key. */
  apiKey: string | undefined;
  /** Where the key came from — surfaced by test-connection + logs. */
  source: "org" | "env";
}

/**
 * Resolve the Help Chat provider + key from an ALREADY-LOADED org settings
 * blob (pure — the caller did the DB read; help-chat piggybacks on its
 * existing org-name lookup so this adds zero queries).
 *
 * Preference rules:
 *  - `settings.ai.helpChatProvider` picks the provider (default anthropic).
 *  - The chosen provider uses the org key when stored, else its env key.
 *  - If the chosen provider has NO key at all (org or env), fall back to
 *    anthropic + env with a warn log — a misconfigured preference must
 *    degrade, never brick help chat.
 *
 * Pass `null` settings for org-null callers (REVIEWER/SUBMITTER/REGISTRANT):
 * resolves to anthropic + env by construction.
 */
export function aiConfigFromSettings(
  settings: unknown,
  logCtx?: { organizationId?: string | null },
): ResolvedAiConfig {
  const aiPrefs = readSub(settings, "ai");
  const preferred: AiProviderName =
    aiPrefs?.helpChatProvider === "openai" ? "openai" : "anthropic";

  const orgKey = safeOrgKey(settings, preferred, logCtx);
  if (orgKey) return { provider: preferred, apiKey: orgKey, source: "org" };
  if (ENV_KEY_FOR[preferred]()) {
    return { provider: preferred, apiKey: undefined, source: "env" };
  }

  if (preferred !== "anthropic") {
    // Chosen provider has no usable key anywhere — degrade to the default
    // lane rather than failing every help-chat request.
    apiLogger.warn({
      msg: "ai-credentials:preferred-provider-has-no-key; falling back to anthropic",
      preferred,
      organizationId: logCtx?.organizationId ?? null,
    });
    const anthropicOrgKey = safeOrgKey(settings, "anthropic", logCtx);
    if (anthropicOrgKey) return { provider: "anthropic", apiKey: anthropicOrgKey, source: "org" };
  }
  // Anthropic + env (the adapter throws its existing message if the env
  // key is also absent — same failure as pre-feature).
  return { provider: "anthropic", apiKey: undefined, source: "env" };
}

/**
 * Decryption failure degrades to "no org key" (env fallback) with an error
 * log. DELIBERATE ASYMMETRY vs the Stripe accessor (src/lib/stripe.ts),
 * which HARD-THROWS on the same condition: a mis-lane AI call only means the
 * platform's env key pays for a tenant's chat (a bounded cost leak, and Help
 * Chat must never brick), whereas a mis-lane Stripe call collects money into
 * the wrong legal entity (unrecoverable — so payments fail closed instead).
 */
function safeOrgKey(
  settings: unknown,
  provider: AiProviderName,
  logCtx?: { organizationId?: string | null },
): string | null {
  try {
    return orgKeyFromSettings(settings, provider);
  } catch (err) {
    apiLogger.error({
      msg: "ai-credentials:org-key-decrypt-failed; falling back to env",
      provider,
      organizationId: logCtx?.organizationId ?? null,
      err,
    });
    return null;
  }
}

/**
 * The Event Agent's key resolver (Anthropic-only — the agent's tool loop +
 * server-side web search are Anthropic-specific this round). Org key when
 * configured, else env; neither → the IDENTICAL error message the provider
 * adapter has always thrown.
 */
export async function resolveAnthropicApiKey(
  organizationId?: string | null,
): Promise<string> {
  if (organizationId) {
    try {
      const { db } = await import("@/lib/db");
      const org = await db.organization.findUnique({
        where: { id: organizationId },
        select: { settings: true },
      });
      const orgKey = safeOrgKey(org?.settings, "anthropic", { organizationId });
      if (orgKey) return orgKey;
    } catch (err) {
      apiLogger.error({
        msg: "ai-credentials:org-settings-read-failed; falling back to env",
        organizationId,
        err,
      });
    }
  }
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (!envKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — cannot use the Anthropic AI provider.",
    );
  }
  return envKey;
}
