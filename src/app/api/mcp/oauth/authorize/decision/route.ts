import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getClient, issueAuthCode } from "@/lib/mcp-oauth";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp, isSameOriginRequest } from "@/lib/security";
import { describeRedirectTarget } from "@/lib/mcp-client-trust";

/**
 * POST handler for the consent form at /mcp-authorize.
 *
 * Re-validates the OAuth params server-side (never trust the form fields),
 * checks the NextAuth session, then either:
 *   - approves: issues an auth code and 302s to `${redirect_uri}?code=...&state=...`
 *   - denies: 302s to `${redirect_uri}?error=access_denied&state=...`
 *
 * The redirect target is ALWAYS a validated URI from the registered client's
 * `redirectUris` list — never a user-supplied URL.
 */
export async function POST(req: Request) {
  // ── CSRF: this route is cookie-authenticated and mints a credential ──
  // `src/proxy.ts` skips its Origin/Host check for the whole `/api/mcp`
  // prefix so browser-based MCP clients are not blocked by the mobile CORS
  // allow-list. Correct for the transport endpoint (Bearer auth, not
  // CSRF-able), WRONG here: this one reads the session cookie. Until now the
  // only thing stopping a cross-site POST was Auth.js defaulting the cookie
  // to SameSite=Lax, which is real but is a browser default we inherited
  // rather than a guarantee we wrote. See `isSameOriginRequest`.
  const sameOrigin = isSameOriginRequest(req);
  if (!sameOrigin.ok) {
    apiLogger.warn({
      msg: "mcp-oauth:decision-cross-origin-refused",
      reason: sameOrigin.reason,
      ip: getClientIp(req),
    });
    return NextResponse.json(
      { error: "invalid_request", error_description: "Cross-origin authorization request refused" },
      { status: 403 },
    );
  }

  const formData = await req.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: "invalid_request", error_description: "Missing form body" }, { status: 400 });
  }

  const ip = getClientIp(req);
  const rl = checkRateLimit({
    key: `mcp-oauth-authorize:${ip}`,
    limit: 30,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    apiLogger.warn({ msg: "mcp-oauth:authorize-rate-limited", ip });
    return NextResponse.json(
      { error: "rate_limit_exceeded" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const clientId = String(formData.get("client_id") ?? "");
  const redirectUri = String(formData.get("redirect_uri") ?? "");
  const codeChallenge = String(formData.get("code_challenge") ?? "");
  const codeChallengeMethod = String(formData.get("code_challenge_method") ?? "S256");
  const state = String(formData.get("state") ?? "");
  const scope = String(formData.get("scope") ?? "mcp");
  const decision = String(formData.get("decision") ?? "");

  // ── Re-validate the client + redirect_uri (never trust form fields) ──
  const client = await getClient(clientId);
  if (!client) {
    return NextResponse.json(
      { error: "invalid_client", error_description: "Unknown client_id" },
      { status: 400 },
    );
  }
  if (!client.redirectUris.includes(redirectUri)) {
    apiLogger.warn({
      msg: "mcp-oauth:decision-redirect-uri-mismatch",
      clientId,
      provided: redirectUri,
    });
    return NextResponse.json(
      { error: "invalid_request", error_description: "Redirect URI mismatch" },
      { status: 400 },
    );
  }

  // ── Require a valid session ──────────────────────────────────────────
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json(
      { error: "access_denied", error_description: "Not signed in" },
      { status: 401 },
    );
  }

  // ── RBAC: only admin/organizer roles can grant access ───────────────
  const role = session.user.role;
  if (role !== "ADMIN" && role !== "SUPER_ADMIN" && role !== "ORGANIZER") {
    return NextResponse.json(
      { error: "access_denied", error_description: "Role not permitted to grant MCP access" },
      { status: 403 },
    );
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, organizationId: true },
  });
  if (!user?.organizationId) {
    return NextResponse.json(
      { error: "access_denied", error_description: "User has no organization" },
      { status: 403 },
    );
  }

  // ── Build the redirect URL back to the client ──────────────────────
  const target = new URL(redirectUri);
  if (state) target.searchParams.set("state", state);

  if (decision !== "approve") {
    apiLogger.info({ msg: "mcp-oauth:authorize-denied", clientId, userId: user.id });
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", "User denied the authorization request");
    return NextResponse.redirect(target.toString(), 302);
  }

  // ── Approve: issue a one-time auth code ─────────────────────────────
  try {
    const rawCode = await issueAuthCode({
      clientId,
      userId: user.id,
      organizationId: user.organizationId,
      codeChallenge,
      codeChallengeMethod,
      redirectUri,
      scope,
    });

    // Log the DESTINATION, not just the client id. If a grant is ever phished,
    // the question asked afterwards is "where did it go", and a client id alone
    // cannot answer it once the row is gone. An approval to an unrecognised
    // host logs at warn so it surfaces without anyone going looking.
    const destination = describeRedirectTarget(redirectUri);
    const approvalLog = {
      msg: "mcp-oauth:authorize-approved",
      clientId,
      clientName: client.clientName,
      userId: user.id,
      organizationId: user.organizationId,
      redirectHost: destination.host,
      recognizedDestination: destination.recognized,
      // NEVER log the raw code — only its prefix for debugging
      codePrefix: rawCode.slice(0, 12),
    };
    if (destination.recognized && !destination.insecure) {
      apiLogger.info(approvalLog);
    } else {
      apiLogger.warn({ ...approvalLog, msg: "mcp-oauth:authorize-approved-unrecognized-destination" });
    }

    target.searchParams.set("code", rawCode);
    return NextResponse.redirect(target.toString(), 302);
  } catch (err) {
    apiLogger.error({ err, msg: "mcp-oauth:authorize-failed", clientId });
    target.searchParams.set("error", "server_error");
    target.searchParams.set("error_description", "Failed to issue authorization code");
    return NextResponse.redirect(target.toString(), 302);
  }
}
