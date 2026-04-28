import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";

/**
 * GET /api/organization/oauth-clients
 *
 * List all McpOAuthClient rows that have at least one access token issued
 * to a user belonging to the caller's organization. Each client row is the
 * "I connected EA-SYS to my claude.ai account" registration — flipping its
 * tier to INTERNAL makes every OAuth-minted token from that registration
 * bypass the MCP 100/hr rate limit.
 *
 * Org-scoped (admins can only see clients tied to grants they actually own
 * via their organization). SUPER_ADMIN/ADMIN only — REVIEWER/SUBMITTER/REGISTRANT
 * blocked by `denyReviewer`.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Only admins can view OAuth clients" }, { status: 403 });
    }

    const organizationId = session.user.organizationId!;

    // Pull every distinct client that has at least one token tied to this org.
    // Aggregate per-client to surface lastUsedAt + token count.
    const tokens = await db.mcpOAuthAccessToken.findMany({
      where: { organizationId },
      select: {
        clientId: true,
        userId: true,
        lastUsedAt: true,
        revokedAt: true,
        expiresAt: true,
        client: {
          select: {
            clientId: true,
            clientName: true,
            rateLimitTier: true,
            createdAt: true,
          },
        },
        user: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });

    // Group by client.clientId
    type GroupedUser = { id: string; name: string; email: string };
    const byClient = new Map<
      string,
      {
        clientId: string;
        clientName: string | null;
        rateLimitTier: "NORMAL" | "INTERNAL";
        createdAt: Date;
        activeTokenCount: number;
        revokedTokenCount: number;
        lastUsedAt: Date | null;
        users: GroupedUser[];
      }
    >();

    for (const tok of tokens) {
      const c = tok.client;
      const existing = byClient.get(c.clientId);
      const isActive = !tok.revokedAt && tok.expiresAt > new Date();
      const groupedUser: GroupedUser | null = tok.user
        ? {
            id: tok.user.id,
            name: `${tok.user.firstName} ${tok.user.lastName}`.trim(),
            email: tok.user.email,
          }
        : null;
      if (existing) {
        if (isActive) existing.activeTokenCount += 1;
        else existing.revokedTokenCount += 1;
        if (tok.lastUsedAt && (!existing.lastUsedAt || tok.lastUsedAt > existing.lastUsedAt)) {
          existing.lastUsedAt = tok.lastUsedAt;
        }
        if (groupedUser && !existing.users.some((u) => u.id === groupedUser.id)) {
          existing.users.push(groupedUser);
        }
      } else {
        byClient.set(c.clientId, {
          clientId: c.clientId,
          clientName: c.clientName,
          rateLimitTier: c.rateLimitTier,
          createdAt: c.createdAt,
          activeTokenCount: isActive ? 1 : 0,
          revokedTokenCount: isActive ? 0 : 1,
          lastUsedAt: tok.lastUsedAt,
          users: groupedUser ? [groupedUser] : [],
        });
      }
    }

    const clients = Array.from(byClient.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );

    return NextResponse.json(clients);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to list OAuth clients" });
    return NextResponse.json({ error: "Failed to list OAuth clients" }, { status: 500 });
  }
}
