import { auth } from "@/lib/auth";
import { validateApiKey } from "@/lib/api-key";
import { verifyMobileToken } from "@/lib/mobile-jwt";
import { resolveActingOrgId } from "@/lib/platform-operator";

export interface OrgContext {
  organizationId: string;
  /** userId is set when authenticated via session or mobile JWT; null for API key auth */
  userId: string | null;
  /** role is set when authenticated via session or mobile JWT; null for API key auth */
  role: string | null;
  fromApiKey: boolean;
  /** true when authenticated via mobile JWT */
  fromMobile: boolean;
}

/**
 * Resolves the org context from either:
 *   1. NextAuth session (dashboard users)
 *   2. Mobile JWT (Authorization: Bearer <mobile-jwt>)
 *   3. x-api-key header (external tools like n8n)
 *   4. Authorization: Bearer <api-key> (external tools)
 *
 * Returns null if none is present or valid.
 */
export async function getOrgContext(req: Request): Promise<OrgContext | null> {
  // 1. Try NextAuth session first
  const session = await auth();
  if (session?.user?.organizationId) {
    // The x-org-id override is honoured for a PLATFORM OPERATOR only, never
    // for a tenant's own SUPER_ADMIN. See resolveActingOrgId for why.
    const orgId = resolveActingOrgId(req, session.user, session.user.organizationId, {
      route: "getOrgContext:session",
    });

    return {
      organizationId: orgId,
      userId: session.user.id ?? null,
      role: session.user.role ?? null,
      fromApiKey: false,
      fromMobile: false,
    };
  }

  // 2. Try Bearer token (mobile JWT or API key)
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.replace(/^Bearer\s+/i, "").trim() ?? null;

  // 2a. Try mobile JWT first (mobile JWTs contain a dot-separated structure)
  if (bearerToken && bearerToken.split(".").length === 3) {
    const decoded = verifyMobileToken(bearerToken);
    if (decoded && decoded.type === "access" && decoded.organizationId) {
      const orgId = resolveActingOrgId(
        req,
        { id: decoded.userId, role: decoded.role, organizationId: decoded.organizationId },
        decoded.organizationId,
        { route: "getOrgContext:mobile" },
      );

      return {
        organizationId: orgId,
        userId: decoded.userId,
        role: decoded.role,
        fromApiKey: false,
        fromMobile: true,
      };
    }
  }

  // 2b. Try API key from x-api-key or Authorization: Bearer
  const rawKey = req.headers.get("x-api-key") ?? bearerToken ?? null;

  if (rawKey) {
    const result = await validateApiKey(rawKey);
    if (result) {
      return {
        organizationId: result.organizationId,
        userId: null,
        role: null,
        fromApiKey: true,
        fromMobile: false,
      };
    }
  }

  return null;
}
