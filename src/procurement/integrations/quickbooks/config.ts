/**
 * The Intuit app this deployment talks to (September 22, 2026).
 *
 * ONE Intuit app serves every tenant: the client id and secret identify
 * EA-SYS to Intuit and live in the environment, never per organisation.
 * What IS per organisation is the realm (the QuickBooks company) and the
 * tokens for it, which `connection.ts` keeps encrypted in the org's
 * settings. That split matters: a second tenant connecting its own
 * QuickBooks company needs no new Intuit app.
 *
 * Unset credentials mean the integration is simply absent: every route
 * answers "not configured" and nothing is attempted. Production has no
 * QuickBooks variables today, so this ships dark there.
 */

export type QuickBooksEnvironment = "sandbox" | "production";

export interface QuickBooksApp {
  clientId: string;
  clientSecret: string;
  /** Must match EXACTLY what the Intuit app registers, or Intuit refuses the redirect. */
  redirectUri: string;
  environment: QuickBooksEnvironment;
}

/** OAuth 2.0 endpoints, from Intuit's own discovery document; the same pair serves both environments. */
export const QBO_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QBO_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

/** The accounting scope; EA-SYS asks for nothing else (no payroll, no payments). */
export const QBO_SCOPE = "com.intuit.quickbooks.accounting";

/** Pinned rather than "latest": a minor version is Intuit's compatibility contract. */
export const QBO_MINOR_VERSION = "75";

/** Every outbound call is bounded; Node's default is no timeout at all. */
export const QBO_TIMEOUT_MS = 20_000;

const SANDBOX_API_BASE = "https://sandbox-quickbooks.api.intuit.com";
const PRODUCTION_API_BASE = "https://quickbooks.api.intuit.com";

export function qboApiBase(environment: QuickBooksEnvironment): string {
  return environment === "production" ? PRODUCTION_API_BASE : SANDBOX_API_BASE;
}

function env(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Which environment this deployment is pointed at. `QUICKBOOKS_ENVIRONMENT`
 * decides; `QUICKBOOKS_SANDBOX_ENVIRONMENT` is honoured because that is the
 * name already in the developer's .env.local. Anything unrecognised reads as
 * sandbox: guessing "production" from a typo would point real accounting at
 * a test integration.
 */
export function quickBooksEnvironment(): QuickBooksEnvironment {
  const raw = (env("QUICKBOOKS_ENVIRONMENT") ?? env("QUICKBOOKS_SANDBOX_ENVIRONMENT") ?? "sandbox").toLowerCase();
  return raw === "production" ? "production" : "sandbox";
}

/**
 * The configured app, or null when this deployment has no QuickBooks app.
 *
 * Sandbox reads the `QUICKBOOKS_SANDBOX_*` triple, production the
 * `QUICKBOOKS_*` one, so both can sit in one file and the environment
 * variable alone decides which is live. A partial triple is null, not a
 * half-configured app: a missing redirect URI fails at Intuit with a message
 * nobody can act on.
 */
export function resolveQuickBooksApp(): QuickBooksApp | null {
  const environment = quickBooksEnvironment();
  const prefix = environment === "production" ? "QUICKBOOKS" : "QUICKBOOKS_SANDBOX";
  const clientId = env(`${prefix}_CLIENT_ID`);
  const clientSecret = env(`${prefix}_CLIENT_SECRET`);
  const redirectUri = env(`${prefix}_REDIRECT_URI`) ?? env("QUICKBOOKS_REDIRECT_URI");
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri, environment };
}
