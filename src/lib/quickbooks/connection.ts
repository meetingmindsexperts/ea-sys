/**
 * The per-organisation QuickBooks connection (September 22, 2026): which
 * company (realm) this organisation is linked to, its tokens, and when the
 * link was last known good.
 *
 * Stored in `Organization.settings.quickbooks`, the Zoom and EventsAir
 * pattern, so there is no migration and no new table. Tokens are
 * AES-256-GCM encrypted under NEXTAUTH_SECRET and never leave this module
 * in plaintext: `getAccessToken` is the only way out, and nothing it
 * returns is ever logged or put in an API response.
 *
 * The environment is stored beside the realm on purpose. A deployment that
 * flips from sandbox to production holds tokens minted by a different
 * Intuit app against a different company; treating that as connected would
 * send a test integration at real accounting, so a mismatch reads as
 * disconnected and says why.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { encryptSecret, decryptSecret } from "@/lib/eventsair-client";
import { updateOrganizationSettings } from "@/lib/event-settings";
import { loadQuickBooksApp } from "./app";
import type { QuickBooksApp, QuickBooksEnvironment } from "./config";
import { refreshTokens } from "./oauth";

/** What is written under `settings.quickbooks`. Secrets are the `*Encrypted` fields. */
export interface StoredQuickBooksConnection {
  realmId: string;
  environment: QuickBooksEnvironment;
  /**
   * The client id of the Intuit app that minted these tokens.
   *
   * Recorded because the app is now editable per organisation: changing the
   * client id leaves tokens that the new app cannot refresh, and without
   * this the card would go on saying "connected" against a dead link. Null
   * on a connection made before this was stored, which reads as unknown and
   * is never treated as a mismatch.
   */
  clientId?: string | null;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  connectedAt: string;
  connectedByUserId: string | null;
  companyName?: string | null;
  lastHealthCheckAt?: string | null;
  lastHealthCheckOk?: boolean | null;
  lastHealthCheckError?: string | null;
}

/** The safe view: everything a screen may show, and no token. */
export interface QuickBooksConnectionStatus {
  connected: boolean;
  realmId: string | null;
  environment: QuickBooksEnvironment | null;
  companyName: string | null;
  connectedAt: string | null;
  connectedByUserId: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  lastHealthCheckAt: string | null;
  lastHealthCheckOk: boolean | null;
  lastHealthCheckError: string | null;
  /** Set when a stored connection belongs to the other environment. */
  environmentMismatch: boolean;
  /** Set when the app's client id changed since the connection was made, so the tokens are dead. */
  appMismatch: boolean;
}

/**
 * An access token is refreshed this long before it actually expires, so a
 * call that takes a few seconds does not start valid and finish expired.
 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

function parse(settings: unknown): StoredQuickBooksConnection | null {
  if (!settings || typeof settings !== "object") return null;
  const raw = (settings as Record<string, unknown>).quickbooks;
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.realmId !== "string" || !c.realmId) return null;
  if (typeof c.accessTokenEncrypted !== "string" || typeof c.refreshTokenEncrypted !== "string") return null;
  return {
    realmId: c.realmId,
    environment: c.environment === "production" ? "production" : "sandbox",
    clientId: typeof c.clientId === "string" && c.clientId ? c.clientId : null,
    accessTokenEncrypted: c.accessTokenEncrypted,
    refreshTokenEncrypted: c.refreshTokenEncrypted,
    accessTokenExpiresAt: typeof c.accessTokenExpiresAt === "string" ? c.accessTokenExpiresAt : new Date(0).toISOString(),
    refreshTokenExpiresAt: typeof c.refreshTokenExpiresAt === "string" ? c.refreshTokenExpiresAt : new Date(0).toISOString(),
    connectedAt: typeof c.connectedAt === "string" ? c.connectedAt : new Date(0).toISOString(),
    connectedByUserId: typeof c.connectedByUserId === "string" ? c.connectedByUserId : null,
    companyName: typeof c.companyName === "string" ? c.companyName : null,
    lastHealthCheckAt: typeof c.lastHealthCheckAt === "string" ? c.lastHealthCheckAt : null,
    lastHealthCheckOk: typeof c.lastHealthCheckOk === "boolean" ? c.lastHealthCheckOk : null,
    lastHealthCheckError: typeof c.lastHealthCheckError === "string" ? c.lastHealthCheckError : null,
  };
}

/** Exported for tests and for callers that already hold the settings blob. */
export function readConnection(settings: unknown): StoredQuickBooksConnection | null {
  return parse(settings);
}

export async function loadConnection(organizationId: string): Promise<StoredQuickBooksConnection | null> {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  return parse(org?.settings);
}

export function toStatus(connection: StoredQuickBooksConnection | null, app: QuickBooksApp | null): QuickBooksConnectionStatus {
  const mismatch = !!connection && !!app && connection.environment !== app.environment;
  // Only when the connection actually recorded which app minted it; a null
  // reads as unknown, never as a mismatch, so older connections are unaffected.
  const appMismatch = !!connection?.clientId && !!app && connection.clientId !== app.clientId;
  return {
    connected: !!connection && !mismatch && !appMismatch,
    realmId: connection?.realmId ?? null,
    environment: connection?.environment ?? null,
    companyName: connection?.companyName ?? null,
    connectedAt: connection?.connectedAt ?? null,
    connectedByUserId: connection?.connectedByUserId ?? null,
    accessTokenExpiresAt: connection?.accessTokenExpiresAt ?? null,
    refreshTokenExpiresAt: connection?.refreshTokenExpiresAt ?? null,
    lastHealthCheckAt: connection?.lastHealthCheckAt ?? null,
    lastHealthCheckOk: connection?.lastHealthCheckOk ?? null,
    lastHealthCheckError: connection?.lastHealthCheckError ?? null,
    environmentMismatch: mismatch,
    appMismatch,
  };
}

/** Merge a patch into the stored connection. Atomic: the helper row-locks the organisation. */
export async function saveConnection(organizationId: string, patch: Partial<StoredQuickBooksConnection>): Promise<void> {
  await updateOrganizationSettings(organizationId, (current) => {
    const existing = (current.quickbooks && typeof current.quickbooks === "object" ? current.quickbooks : {}) as Record<string, unknown>;
    return { ...current, quickbooks: { ...existing, ...patch } };
  });
}

export async function storeNewConnection(input: {
  organizationId: string;
  realmId: string;
  environment: QuickBooksEnvironment;
  /** The app that minted these tokens, so a later credential change is visible rather than silent. */
  clientId: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}): Promise<void> {
  await updateOrganizationSettings(input.organizationId, (current) => ({
    ...current,
    // A fresh connection REPLACES the old block rather than merging into it, so
    // a previous realm's health history cannot read as this one's.
    quickbooks: {
      realmId: input.realmId,
      environment: input.environment,
      clientId: input.clientId,
      accessTokenEncrypted: encryptSecret(input.accessToken),
      refreshTokenEncrypted: encryptSecret(input.refreshToken),
      accessTokenExpiresAt: input.accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: input.refreshTokenExpiresAt.toISOString(),
      connectedAt: new Date().toISOString(),
      connectedByUserId: input.userId,
      companyName: null,
      lastHealthCheckAt: null,
      lastHealthCheckOk: null,
      lastHealthCheckError: null,
    } satisfies StoredQuickBooksConnection,
  }));
}

export async function clearConnection(organizationId: string): Promise<void> {
  await updateOrganizationSettings(organizationId, (current) => {
    const next = { ...current };
    delete next.quickbooks;
    return next;
  });
}

export type AccessTokenResult =
  | { ok: true; accessToken: string; realmId: string; environment: QuickBooksEnvironment; app: QuickBooksApp }
  | { ok: false; code: "NOT_CONFIGURED" | "NOT_CONNECTED" | "ENVIRONMENT_MISMATCH" | "APP_CHANGED" | "REFRESH_EXPIRED" | "REFRESH_FAILED"; message: string };

/**
 * A usable access token, refreshing first when the stored one is within the
 * skew of expiry.
 *
 * Concurrency, stated rather than defended against: two refreshes at once
 * both succeed at Intuit and the second's rotated token wins, which is
 * harmless because Intuit keeps the previous refresh token usable for a
 * short grace period. Accepted because the only automatic caller is the
 * daily health job, which holds a worker lease and therefore runs alone.
 * A second automatic reader is the point at which this needs a lock.
 */
export async function getAccessToken(organizationId: string): Promise<AccessTokenResult> {
  const app = await loadQuickBooksApp(organizationId);
  if (!app) return { ok: false, code: "NOT_CONFIGURED", message: "No QuickBooks app is configured for this organisation" };

  const connection = await loadConnection(organizationId);
  if (!connection) return { ok: false, code: "NOT_CONNECTED", message: "This organisation is not connected to QuickBooks" };
  if (connection.environment !== app.environment) {
    return {
      ok: false,
      code: "ENVIRONMENT_MISMATCH",
      message: `The stored connection is a ${connection.environment} company but the app is now set to ${app.environment}. Disconnect and connect again.`,
    };
  }
  if (connection.clientId && connection.clientId !== app.clientId) {
    return {
      ok: false,
      code: "APP_CHANGED",
      message: "The QuickBooks app credentials changed after this connection was made, so its tokens can no longer be refreshed. Disconnect and connect again.",
    };
  }

  const now = Date.now();
  if (new Date(connection.accessTokenExpiresAt).getTime() - REFRESH_SKEW_MS > now) {
    return { ok: true, accessToken: decryptSecret(connection.accessTokenEncrypted), realmId: connection.realmId, environment: connection.environment, app };
  }

  if (new Date(connection.refreshTokenExpiresAt).getTime() <= now) {
    return {
      ok: false,
      code: "REFRESH_EXPIRED",
      message: "The QuickBooks connection expired (a refresh token lasts about 100 days when unused). Connect again.",
    };
  }

  const refreshed = await refreshTokens(app, decryptSecret(connection.refreshTokenEncrypted));
  if (!refreshed.ok) {
    return { ok: false, code: "REFRESH_FAILED", message: refreshed.message };
  }

  // Written BEFORE the token is used: the refresh rotated it at Intuit, so a
  // crash between here and the next call would otherwise strand the connection.
  await saveConnection(organizationId, {
    accessTokenEncrypted: encryptSecret(refreshed.tokens.accessToken),
    refreshTokenEncrypted: encryptSecret(refreshed.tokens.refreshToken),
    accessTokenExpiresAt: refreshed.tokens.accessTokenExpiresAt.toISOString(),
    refreshTokenExpiresAt: refreshed.tokens.refreshTokenExpiresAt.toISOString(),
  });
  apiLogger.info({ msg: "quickbooks:token-refreshed", organizationId, realmId: connection.realmId });

  return { ok: true, accessToken: refreshed.tokens.accessToken, realmId: connection.realmId, environment: connection.environment, app };
}
