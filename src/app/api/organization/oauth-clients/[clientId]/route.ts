import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/permissions/require-permission";
import { apiLogger } from "@/lib/logger";

const patchSchema = z.object({
  rateLimitTier: z.enum(["NORMAL", "INTERNAL"]),
});

interface RouteContext {
  params: Promise<{ clientId: string }>;
}

/**
 * PATCH /api/organization/oauth-clients/[clientId]
 *
 * Flip an OAuth client's rate-limit tier. INTERNAL bypasses the MCP 100/hr
 * cap for every token minted from this DCR registration. Gated to
 * SUPER_ADMIN — same threat model as INTERNAL API keys.
 *
 * The client row must have at least one token tied to the caller's org
 * (defense-in-depth so an admin in org A can't flip a row claude.ai
 * registered for org B).
 */
export async function PATCH(req: Request, { params }: RouteContext) {
  try {
    const [{ clientId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json().catch(() => null),
    ]);

    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // INTERNAL bypasses the MCP limit for every token the client mints:
    // `apiKeys.internalTier`, SUPER_ADMIN only (same threat model as INTERNAL keys).
    const gate = requirePermission(session, "apiKeys.internalTier", { route: "organization/oauth-clients/[clientId]:PATCH" });
    if (!gate.ok) return gate.response;

    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({
        msg: "oauth-client:zod-validation-failed",
        errors: parsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const organizationId = session.user.organizationId!;

    // Ownership check: confirm at least one token from this client belongs
    // to the caller's org. Without this, a SUPER_ADMIN could flip any
    // unrelated DCR registration in the system.
    const ownership = await db.mcpOAuthAccessToken.findFirst({
      where: { clientId, organizationId },
      select: { id: true },
    });
    if (!ownership) {
      apiLogger.warn({
        msg: "oauth-client:ownership-check-failed",
        userId: session.user.id,
        organizationId,
        clientId,
      });
      return NextResponse.json(
        { error: "OAuth client not found in your organization" },
        { status: 404 },
      );
    }

    const updated = await db.mcpOAuthClient.update({
      where: { clientId },
      data: { rateLimitTier: parsed.data.rateLimitTier },
      select: { clientId: true, clientName: true, rateLimitTier: true },
    });

    apiLogger.info({
      msg: "oauth-client:tier-changed",
      userId: session.user.id,
      organizationId,
      clientId,
      newTier: updated.rateLimitTier,
    });

    return NextResponse.json(updated);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to update OAuth client tier" });
    return NextResponse.json(
      { error: "Failed to update OAuth client" },
      { status: 500 },
    );
  }
}
