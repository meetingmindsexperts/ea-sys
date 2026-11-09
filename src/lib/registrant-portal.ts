import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { normalizeHost, resolveTenantOrg } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { loadRegistrantScope, type RegistrantScope } from "@/lib/registrant-access";

/**
 * The one way a page of a person's own portal (/my-registration and the pages
 * under it, docs/MY_PORTAL_PLAN.md) gets its data: signed in or off to sign
 * in, the tenant lane from the host (a registrant is org-null, so sign-in
 * resolves it the same way), the person's scope from the database, then the
 * page's own reads inside that lane.
 *
 * Every read goes through `scope`, never the session: what a person may see
 * is ownRegistrationWhere's rule (registrant-access.ts), and a page that
 * re-derived it would be the first to drift.
 */
export async function loadRegistrantPortal<T>(
  path: string,
  load: (scope: RegistrantScope) => Promise<T>,
): Promise<{ scope: RegistrantScope; data: T; role: string | null }> {
  const signIn = `/login?callbackUrl=${encodeURIComponent(path)}`;
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect(signIn);

  let result: { scope: RegistrantScope; data: T } | null;
  try {
    const { orgId } = await resolveTenantOrg(normalizeHost((await headers()).get("host")));
    result = await runWithTenantLane(orgId, { route: `page:${path}`, userId }, async () => {
      const scope = await loadRegistrantScope(userId, { sessionTokenVersion: session.user.tokenVersion });
      if (!scope) return null;
      return { scope, data: await load(scope) };
    });
  } catch (err) {
    apiLogger.error({ err, msg: "registrant-portal:load-failed", path, userId });
    throw err;
  }
  // A session for an account that no longer exists: back to sign-in.
  if (!result) {
    apiLogger.warn({ msg: "registrant-portal:user-not-found", path, userId });
    redirect(signIn);
  }
  return { ...result, role: session.user.role ?? null };
}
