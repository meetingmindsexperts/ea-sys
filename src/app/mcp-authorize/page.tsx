import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getClient } from "@/lib/mcp-oauth";
import { apiLogger } from "@/lib/logger";

/**
 * OAuth 2.1 authorization endpoint — rendered as a Next.js page (server
 * component) so we get clean access to NextAuth session, server-side query
 * validation, and a native HTML form that POSTs to the decision route.
 *
 * MCP clients (claude.ai, etc.) open a popup at this URL. We validate the
 * client_id + redirect_uri + PKCE params, check the logged-in user's role,
 * and render an Approve / Deny screen. On submit, the form POSTs to
 * `/api/mcp/oauth/authorize/decision` which mints the auth code and 302s
 * back to the client's redirect_uri.
 */

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function errorPage(title: string, detail: string) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="max-w-md w-full bg-white rounded-lg shadow-sm border border-red-200 p-8">
        <h1 className="text-xl font-semibold text-red-700 mb-2">{title}</h1>
        <p className="text-sm text-gray-600 leading-relaxed">{detail}</p>
        <p className="mt-6 text-xs text-gray-500">
          If you believe this is a mistake, contact your EA-SYS administrator. This URL is only
          meant to be opened by an MCP client (e.g. Claude). Opening it directly in a browser is
          usually a sign something went wrong in the OAuth handshake.
        </p>
      </div>
    </div>
  );
}

export default async function McpAuthorizePage({ searchParams }: PageProps) {
  const params = await searchParams;

  const pick = (k: string): string | null => {
    const v = params[k];
    if (typeof v === "string") return v;
    return null;
  };

  const clientId = pick("client_id");
  const redirectUri = pick("redirect_uri");
  const responseType = pick("response_type");
  const codeChallenge = pick("code_challenge");
  const codeChallengeMethod = pick("code_challenge_method") ?? "S256";
  const state = pick("state") ?? "";
  const scope = pick("scope") ?? "mcp";

  // ── Validate OAuth params ───────────────────────────────────────────
  if (!clientId) {
    return errorPage("Invalid authorization request", "Missing client_id parameter.");
  }
  if (!redirectUri) {
    return errorPage("Invalid authorization request", "Missing redirect_uri parameter.");
  }
  if (responseType !== "code") {
    return errorPage(
      "Unsupported response type",
      "This server only supports response_type=code (Authorization Code flow with PKCE).",
    );
  }
  if (!codeChallenge) {
    return errorPage(
      "PKCE required",
      "A code_challenge parameter is required. Plain OAuth without PKCE is not supported.",
    );
  }
  if (codeChallengeMethod !== "S256") {
    return errorPage(
      "Unsupported PKCE method",
      "This server only supports code_challenge_method=S256.",
    );
  }

  // ── Look up the client and verify redirect_uri ──────────────────────
  const client = await getClient(clientId);
  if (!client) {
    return errorPage(
      "Unknown client",
      "This client_id is not registered. The MCP client should call /api/mcp/oauth/register before authorizing.",
    );
  }
  if (!client.redirectUris.includes(redirectUri)) {
    apiLogger.warn({
      msg: "mcp-oauth:redirect-uri-mismatch",
      clientId,
      provided: redirectUri,
      registered: client.redirectUris,
    });
    return errorPage(
      "Redirect URI mismatch",
      "The redirect_uri does not match any URI registered for this client. This is a security error — never click through.",
    );
  }

  // ── Check NextAuth session; if missing, redirect through /login ─────
  const session = await auth();
  if (!session?.user) {
    const currentUrl = new URL(`/mcp-authorize?${new URLSearchParams(params as Record<string, string>).toString()}`, "http://placeholder");
    const callbackUrl = currentUrl.pathname + currentUrl.search;
    redirect(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  // ── RBAC: only ADMIN / SUPER_ADMIN / ORGANIZER can grant MCP access ─
  const role = session.user.role;
  if (role !== "ADMIN" && role !== "SUPER_ADMIN" && role !== "ORGANIZER") {
    return errorPage(
      "Access denied",
      "Only organization admins and organizers can grant MCP access. Your role does not have permission to approve this request.",
    );
  }

  // ── Load the user's organization for display ────────────────────────
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      organizationId: true,
      organization: { select: { name: true, id: true } },
    },
  });
  if (!user?.organization || !user.organizationId) {
    return errorPage(
      "No organization",
      "Your user account is not bound to an organization. MCP grants require an organization context.",
    );
  }

  // ── Render the consent UI ───────────────────────────────────────────
  const clientName = client.clientName ?? "An MCP client";

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="max-w-md w-full bg-white rounded-lg shadow-sm border border-gray-200 p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-full bg-[#00aade] flex items-center justify-center text-white text-sm font-semibold">
            EA
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">EA-SYS MCP</p>
            <p className="text-sm font-semibold text-gray-900">Authorize access</p>
          </div>
        </div>

        <h1 className="text-xl font-semibold text-gray-900 mb-2">
          {clientName} wants access
        </h1>
        <p className="text-sm text-gray-600 mb-6 leading-relaxed">
          This MCP client is requesting read and write access to your EA-SYS organization{" "}
          <strong className="text-gray-900">{user.organization.name}</strong>.
        </p>

        <div className="rounded-md border border-gray-200 bg-gray-50 p-4 mb-6 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Signed in as</span>
            <span className="text-gray-900 font-medium">
              {user.firstName} {user.lastName}
            </span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Email</span>
            <span className="text-gray-900">{user.email}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Organization</span>
            <span className="text-gray-900">{user.organization.name}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Scope</span>
            <span className="text-gray-900 font-mono text-[11px]">{scope}</span>
          </div>
        </div>

        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 mb-6">
          <p className="text-xs text-amber-800 leading-relaxed">
            By approving, you grant this client full MCP access to {user.organization.name} for
            30 days. The token can be revoked at any time from your MCP sessions page.
          </p>
        </div>

        <form action="/api/mcp/oauth/authorize/decision" method="POST" className="space-y-3">
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="redirect_uri" value={redirectUri} />
          <input type="hidden" name="code_challenge" value={codeChallenge} />
          <input type="hidden" name="code_challenge_method" value={codeChallengeMethod} />
          <input type="hidden" name="state" value={state} />
          <input type="hidden" name="scope" value={scope} />

          <button
            type="submit"
            name="decision"
            value="approve"
            className="w-full rounded-md bg-[#00aade] hover:bg-[#0097c2] text-white font-medium py-2.5 px-4 text-sm transition-colors"
          >
            Approve access
          </button>
          <button
            type="submit"
            name="decision"
            value="deny"
            className="w-full rounded-md border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 font-medium py-2.5 px-4 text-sm transition-colors"
          >
            Deny
          </button>
        </form>

        <p className="mt-6 text-xs text-gray-500 text-center">
          Not your account? <Link href="/api/auth/signout" className="text-[#00aade] hover:underline">Sign out</Link>
        </p>
      </div>
    </div>
  );
}
