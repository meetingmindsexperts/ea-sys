import { NextResponse } from "next/server";
import { SYSTEM_ROLES } from "@/lib/permissions/system-roles";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/permissions/require-permission";
import { can } from "@/lib/permissions/can";
import { generateApiKey, hashApiKey, keyPrefix } from "@/lib/api-key";
import { apiLogger } from "@/lib/logger";
import { firstGrantBeyondActor } from "@/lib/permissions/escalation";
import type { PermissionKey } from "@/lib/permissions/catalogue";

const createKeySchema = z.object({
  name: z.string().min(1).max(64),
  expiresAt: z.string().datetime().optional(),
  rateLimitTier: z.enum(["NORMAL", "INTERNAL"]).default("NORMAL"),
  /** The role the key acts with (Phase 5). Absent: full access, as every key before. */
  permissionSetId: z.string().min(1).max(100).nullable().optional(),
});

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "apiKeys.manage", { route: "organization/api-keys:GET" });
    if (!gate.ok) return gate.response;

    const keys = await db.apiKey.findMany({
      where: { organizationId: session.user.organizationId! },
      select: {
        id: true,
        name: true,
        prefix: true,
        isActive: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        rateLimitTier: true,
        permissionSet: { select: { id: true, name: true, archivedAt: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(keys);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to fetch API keys" });
    return NextResponse.json(
      { error: "Failed to fetch API keys" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "apiKeys.manage", { route: "organization/api-keys:POST" });
    if (!gate.ok) return gate.response;

    const body = await req.json();
    const parsed = createKeySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "organization/api-keys:zod-validation-failed", errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    // INTERNAL-tier keys bypass the MCP rate limit, so they're a privileged
    // capability gated to SUPER_ADMIN. ADMIN can issue NORMAL keys freely.
    if (parsed.data.rateLimitTier === "INTERNAL" && !can(gate.principal, "apiKeys.internalTier")) {
      apiLogger.warn({
        msg: "organization/api-keys:internal-tier-denied",
        userId: session.user.id,
        role: session.user.role,
      });
      return NextResponse.json(
        { error: "Only SUPER_ADMIN can issue INTERNAL-tier keys" },
        { status: 403 },
      );
    }

    // A key acting with a role: a live custom role of this organisation, and
    // no wider than the person minting it (plan §7.4, as assigning a role).
    const permissionSetId = parsed.data.permissionSetId ?? null;
    if (permissionSetId) {
      const role = await db.permissionSet.findFirst({
        where: { id: permissionSetId, organizationId: session.user.organizationId!, archivedAt: null, isSystem: false },
        select: { id: true, name: true, permissions: { select: { permission: true, scope: true } } },
      });
      if (!role) {
        apiLogger.warn({ msg: "organization/api-keys:role-not-found", userId: session.user.id, permissionSetId });
        return NextResponse.json({ error: "That role no longer exists.", code: "ROLE_NOT_FOUND" }, { status: 404 });
      }
      const beyond = firstGrantBeyondActor(
        gate.principal,
        role.permissions.map((p) => ({ permission: p.permission as PermissionKey, scope: p.scope })),
      );
      if (beyond) {
        apiLogger.warn({ msg: "organization/api-keys:role-beyond-creator", userId: session.user.id, permissionSetId, permission: beyond.permission });
        return NextResponse.json(
          { error: `A key can only act with a role you hold all of: you do not hold "${beyond.permission}".`, code: "BEYOND_YOUR_ACCESS" },
          { status: 403 },
        );
      }
    }

    // A key WITHOUT a role is the full API key (the API_KEY system role), so
    // minting one is granting all of that (review H1, Oct 6, 2026): only
    // someone who holds every grant of it may.
    if (!permissionSetId) {
      const beyond = firstGrantBeyondActor(gate.principal, SYSTEM_ROLES.API_KEY.grants.map((g) => ({ permission: g.permission, scope: g.scope ?? null })));
      if (beyond) {
        apiLogger.warn({ msg: "organization/api-keys:full-key-beyond-creator", userId: session.user.id, permission: beyond.permission });
        return NextResponse.json(
          { error: `A key without a role can do everything a full API key can, and you do not hold "${beyond.permission}". Choose a role for the key.`, code: "BEYOND_YOUR_ACCESS" },
          { status: 403 },
        );
      }
    }

    const rawKey = generateApiKey();
    const hash = hashApiKey(rawKey);
    const prefix = keyPrefix(rawKey);

    await db.apiKey.create({
      data: {
        organizationId: session.user.organizationId!,
        name: parsed.data.name,
        keyHash: hash,
        prefix,
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        rateLimitTier: parsed.data.rateLimitTier,
        permissionSetId,
      },
    });
    apiLogger.info({ msg: "organization/api-keys:created", userId: session.user.id, prefix, permissionSetId });

    if (parsed.data.rateLimitTier === "INTERNAL") {
      apiLogger.info({
        msg: "organization/api-keys:internal-tier-issued",
        userId: session.user.id,
        organizationId: session.user.organizationId,
        prefix,
      });
    }

    // Return the plaintext key ONCE — it is never stored and cannot be retrieved again
    return NextResponse.json(
      { key: rawKey, prefix, rateLimitTier: parsed.data.rateLimitTier },
      { status: 201 },
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to create API key" });
    return NextResponse.json(
      { error: "Failed to create API key" },
      { status: 500 }
    );
  }
}
