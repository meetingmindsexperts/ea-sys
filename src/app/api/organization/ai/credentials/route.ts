import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { encryptSecret } from "@/lib/eventsair-client";
import { checkRateLimit } from "@/lib/security";
import { updateOrganizationSettings } from "@/lib/event-settings";
import { z } from "zod";
import type { Session } from "next-auth";

/**
 * Per-org AI credentials + Help Chat provider preference (item 7). ONE route
 * family for both providers because the preference spans them. Storage:
 *   settings.anthropic = { apiKeyEncrypted, apiKeyLast4, configuredAt }
 *   settings.openai    = { apiKeyEncrypted, apiKeyLast4, configuredAt }
 *   settings.ai        = { helpChatProvider }
 * Keys are AES-256-GCM-encrypted and NEVER returned by GET. No client-cache
 * invalidation is needed: the AI client caches are keyed by the API key
 * itself, so a changed key naturally misses.
 *
 * Consumed by aiConfigFromSettings / resolveAnthropicApiKey
 * (src/lib/ai/credentials.ts; org key → env fallback).
 */

const putSchema = z.object({
  helpChatProvider: z.enum(["anthropic", "openai"]).optional(),
  // Blank keeps the existing encrypted value (the Zoom convention).
  anthropicApiKey: z.string().max(500).optional(),
  openaiApiKey: z.string().max(500).optional(),
});

const deleteSchema = z.object({
  provider: z.enum(["anthropic", "openai"]),
});

function requireAdmin(session: Session | null) {
  if (!session?.user?.organizationId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "SUPER_ADMIN" && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

function readSub(settings: unknown, key: string): Record<string, unknown> {
  const s = (settings as Record<string, unknown> | null) || {};
  return typeof s[key] === "object" && s[key] !== null
    ? (s[key] as Record<string, unknown>)
    : {};
}

const ENV_KEY: Record<"anthropic" | "openai", () => string | undefined> = {
  anthropic: () => process.env.ANTHROPIC_API_KEY,
  openai: () => process.env.OPENAI_API_KEY,
};

export async function GET() {
  try {
    const session = await auth();
    const denied = requireAdmin(session);
    if (denied) return denied;

    const org = await db.organization.findUnique({
      where: { id: session!.user.organizationId! },
      select: { settings: true },
    });
    const anthropic = readSub(org?.settings, "anthropic");
    const openai = readSub(org?.settings, "openai");
    const ai = readSub(org?.settings, "ai");

    return NextResponse.json({
      helpChatProvider: ai.helpChatProvider === "openai" ? "openai" : "anthropic",
      anthropic: {
        configured: !!anthropic.apiKeyEncrypted,
        apiKeyLast4: anthropic.apiKeyLast4 || null,
        configuredAt: anthropic.configuredAt || null,
        envFallbackAvailable: !!ENV_KEY.anthropic(),
      },
      openai: {
        configured: !!openai.apiKeyEncrypted,
        apiKeyLast4: openai.apiKeyLast4 || null,
        configuredAt: openai.configuredAt || null,
        envFallbackAvailable: !!ENV_KEY.openai(),
      },
    });
  } catch (error) {
    apiLogger.error({ err: error }, "ai:credentials-fetch-failed");
    return NextResponse.json({ error: "Failed to fetch credentials" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json()]);
    const denied = requireAdmin(session);
    if (denied) return denied;
    const orgId = session!.user.organizationId!;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `ai-creds:${orgId}`,
      limit: 10,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: session!.user.id }, "ai:credentials-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const validated = putSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten() }, "ai:credentials-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { settings: true },
    });
    const existingAnthropic = readSub(org?.settings, "anthropic");
    const existingOpenai = readSub(org?.settings, "openai");
    const existingAi = readSub(org?.settings, "ai");

    // Selecting a provider requires a key that RESOLVES for it (the org key
    // being saved in this same request, an already-stored one, or the env
    // fallback) — a preference pointing at a keyless provider would degrade
    // every help-chat request with a warn (guarded in the reader too, but
    // reject it at write time where the admin can act on it).
    const chosen = validated.data.helpChatProvider;
    if (chosen) {
      const willHaveKey =
        chosen === "anthropic"
          ? !!(validated.data.anthropicApiKey || existingAnthropic.apiKeyEncrypted || ENV_KEY.anthropic())
          : !!(validated.data.openaiApiKey || existingOpenai.apiKeyEncrypted || ENV_KEY.openai());
      if (!willHaveKey) {
        apiLogger.warn({ userId: session!.user.id, chosen }, "ai:credentials-provider-without-key");
        return NextResponse.json(
          { error: `Add a ${chosen === "openai" ? "OpenAI" : "Anthropic"} API key before selecting it as the Help Chat provider` },
          { status: 400 },
        );
      }
    }

    const patch: Record<string, unknown> = {};
    if (validated.data.anthropicApiKey) {
      patch.anthropic = JSON.parse(JSON.stringify({
        ...existingAnthropic,
        apiKeyEncrypted: encryptSecret(validated.data.anthropicApiKey),
        apiKeyLast4: validated.data.anthropicApiKey.slice(-4),
        configuredAt: new Date().toISOString(),
      }));
    }
    if (validated.data.openaiApiKey) {
      patch.openai = JSON.parse(JSON.stringify({
        ...existingOpenai,
        apiKeyEncrypted: encryptSecret(validated.data.openaiApiKey),
        apiKeyLast4: validated.data.openaiApiKey.slice(-4),
        configuredAt: new Date().toISOString(),
      }));
    }
    if (chosen) {
      patch.ai = JSON.parse(JSON.stringify({ ...existingAi, helpChatProvider: chosen }));
    }
    if (Object.keys(patch).length === 0) {
      apiLogger.warn({ userId: session!.user.id }, "ai:credentials-empty-save");
      return NextResponse.json({ error: "Nothing to save" }, { status: 400 });
    }

    await updateOrganizationSettings(orgId, patch);

    apiLogger.info(
      { userId: session!.user.id, savedAnthropicKey: !!validated.data.anthropicApiKey, savedOpenaiKey: !!validated.data.openaiApiKey, helpChatProvider: chosen ?? null },
      "ai:credentials-saved",
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error }, "ai:credentials-save-failed");
    return NextResponse.json({ error: "Failed to save credentials" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json().catch(() => null)]);
    const denied = requireAdmin(session);
    if (denied) return denied;
    const orgId = session!.user.organizationId!;

    const validated = deleteSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten() }, "ai:credentials-delete-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }
    const provider = validated.data.provider;

    await updateOrganizationSettings(orgId, (cur) => {
      const next = { ...cur };
      delete next[provider];
      // A preference pointing at the just-cleared provider resets to the
      // default lane (the reader would degrade with a warn otherwise).
      const ai = typeof next.ai === "object" && next.ai !== null ? { ...(next.ai as Record<string, unknown>) } : {};
      if (ai.helpChatProvider === provider) {
        ai.helpChatProvider = "anthropic";
        next.ai = ai;
      }
      return next;
    });

    apiLogger.info({ userId: session!.user.id, provider }, "ai:credentials-deleted");
    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error }, "ai:credentials-delete-failed");
    return NextResponse.json({ error: "Failed to delete credentials" }, { status: 500 });
  }
}
