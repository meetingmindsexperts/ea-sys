import { auth } from "@/lib/auth";
import { validateApiKey } from "@/lib/api-key";

export interface OrgContext {
  organizationId: string;
  /** userId is set when authenticated via session; null for API key auth */
  userId: string | null;
  /** role is set when authenticated via session; null for API key auth */
  role: string | null;
  fromApiKey: boolean;
}

/**
 * Resolves the org context from either:
 *   1. NextAuth session (dashboard users)
 *   2. x-api-key header (external tools like n8n)
 *   3. Authorization: Bearer <key> header
 *
 * Returns null if neither is present or valid.
 */
export async function getOrgContext(req: Request): Promise<OrgContext | null> {
  // 1. Try NextAuth session first
  const session = await auth();
  if (session?.user?.organizationId) {
    return {
      organizationId: session.user.organizationId,
      userId: session.user.id ?? null,
      role: session.user.role ?? null,
      fromApiKey: false,
    };
  }

  // 2. Try API key from x-api-key or Authorization: Bearer
  const rawKey =
    req.headers.get("x-api-key") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    null;

  if (rawKey) {
    const result = await validateApiKey(rawKey);
    if (result) {
      return {
        organizationId: result.organizationId,
        userId: null,
        role: null,
        fromApiKey: true,
      };
    }
  }

  return null;
}
