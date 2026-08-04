import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { db } from "@/lib/db";
import { z } from "zod";

/**
 * Probe an AI provider with the org's EFFECTIVE key (org key → env fallback
 * — the same chain production uses). Both probes are free metadata GETs
 * (`models.list`), not completions. `source` tells the admin which lane
 * answered so a broken org key can't hide behind a working env fallback.
 */

const bodySchema = z.object({
  provider: z.enum(["anthropic", "openai"]),
});

export async function POST(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json().catch(() => null)]);
    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (session.user.role !== "SUPER_ADMIN" && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const orgId = session.user.organizationId;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `ai-test:${orgId}`,
      limit: 10,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: session.user.id }, "ai:test-connection-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const validated = bodySchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten() }, "ai:test-connection-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }
    const provider = validated.data.provider;

    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { settings: true },
    });
    const settings = (org?.settings as Record<string, unknown> | null) || {};
    const sub = settings[provider] as Record<string, unknown> | undefined;

    const { decryptSecret } = await import("@/lib/eventsair-client");
    let apiKey: string | undefined;
    let source: "org" | "env" = "env";
    if (sub?.apiKeyEncrypted && typeof sub.apiKeyEncrypted === "string") {
      apiKey = decryptSecret(sub.apiKeyEncrypted);
      source = "org";
    }

    if (provider === "anthropic") {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!key) {
        return NextResponse.json({ success: false, source, error: "No Anthropic API key configured (org or env)" }, { status: 400 });
      }
      const client = new Anthropic({ apiKey: key });
      await client.models.list({ limit: 1 });
    } else {
      const { default: OpenAI } = await import("openai");
      const key = apiKey ?? process.env.OPENAI_API_KEY;
      if (!key) {
        return NextResponse.json({ success: false, source, error: "No OpenAI API key configured (org or env)" }, { status: 400 });
      }
      const client = new OpenAI({ apiKey: key });
      await client.models.list();
    }

    return NextResponse.json({ success: true, source, provider });
  } catch (error) {
    // Review L7: the SDK's error message can embed a (masked) key fragment —
    // log the real error, return static text.
    apiLogger.warn({ err: error }, "ai:test-connection-failed");
    return NextResponse.json(
      { success: false, error: "Connection failed — check the key and try again" },
      { status: 400 },
    );
  }
}
