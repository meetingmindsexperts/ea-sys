/**
 * What is fixed about talking to Intuit (September 22, 2026): endpoints,
 * scope, minor version, timeout, and the two API bases.
 *
 * Nothing here is per deployment or per tenant. WHICH Intuit app we are —
 * the client id, secret and redirect URI — is per organisation and lives in
 * `app.ts`; which QuickBooks company an organisation is linked to lives in
 * `connection.ts`. This module deliberately reads no environment variables
 * and touches no database, so it stays a pure constants module.
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
