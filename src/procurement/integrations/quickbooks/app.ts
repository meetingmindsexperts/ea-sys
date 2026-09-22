/**
 * The per-organisation Intuit app (September 22, 2026): the client id,
 * secret and redirect URI that identify US to Intuit, held once per
 * environment so one organisation can carry a sandbox app and a production
 * app side by side and switch between them.
 *
 * This REVERSES the connector's first shape, which read a single app out of
 * the environment and said so in this module's predecessor: "ONE Intuit app
 * serves every tenant". That was true of a single-tenant deployment and
 * wrong for the platform, where a tenant brings its own Intuit app the same
 * way it brings its own Stripe and Zoom credentials. There is no environment
 * fallback: the variables are gone, and an organisation with nothing saved
 * here has no QuickBooks app at all.
 *
 * Stored in `Organization.settings.quickbooksApp`, deliberately NOT inside
 * `settings.quickbooks`, which holds the connection. Disconnecting deletes
 * that key wholesale, and credentials that lived inside it would go with it:
 * separate keys make "disconnect must not lose the app" structural rather
 * than something to remember.
 *
 * Secrets are AES-256-GCM under NEXTAUTH_SECRET, the Zoom and EventsAir
 * pattern, and leave this module only as part of a resolved `QuickBooksApp`
 * handed straight to the OAuth calls. Nothing here is ever logged or put in
 * an API response.
 */
import { db } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/eventsair-client";
import { updateOrganizationSettings } from "@/lib/event-settings";
import { apiLogger } from "@/lib/logger";
import type { QuickBooksApp, QuickBooksEnvironment } from "./config";

/** The path Intuit redirects back to; the registered URI must end in exactly this. */
export const QBO_CALLBACK_PATH = "/api/integrations/quickbooks/callback";

/**
 * Whether a redirect URI can possibly work, returning the reason when it cannot.
 *
 * Checked here rather than left to Intuit because Intuit's own refusal is
 * `invalid_redirect_uri` on the consent screen, AFTER the person has clicked
 * Connect and left our app: the cheapest place to say "that is not a URL" is
 * the form they typed it into. Production is held to https because Intuit
 * refuses to register anything else, so http there can only ever fail; a
 * development URI may be http, which is what makes localhost work.
 */
export function validateRedirectUri(value: string, environment: QuickBooksEnvironment): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "The redirect URI must be a full URL, for example https://events.example.com" + QBO_CALLBACK_PATH;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "The redirect URI must start with http:// or https://";
  if (environment === "production" && url.protocol !== "https:") return "A production redirect URI must use https; Intuit will not register an http one";
  if (url.hash) return "The redirect URI must not contain a #fragment";
  // A trailing slash is the same route to Next and a different string to Intuit;
  // tolerated here so the guard does not reject a URI that will actually work.
  if (!url.pathname.replace(/\/+$/, "").endsWith(QBO_CALLBACK_PATH)) {
    return `The redirect URI must end in ${QBO_CALLBACK_PATH}, because that is the route Intuit sends the browser back to`;
  }
  return null;
}

/** One environment's half of the app. Any field may be absent while it is being filled in. */
export interface StoredQuickBooksAppPair {
  clientId: string | null;
  clientSecretEncrypted: string | null;
  redirectUri: string | null;
}

/** What is written under `settings.quickbooksApp`. */
export interface StoredQuickBooksApp {
  /** Which pair is live. Sandbox unless explicitly production, so a corrupt value can never aim at real accounting. */
  environment: QuickBooksEnvironment;
  sandbox: StoredQuickBooksAppPair;
  production: StoredQuickBooksAppPair;
  configuredAt: string | null;
  configuredByUserId: string | null;
}

/** The safe view: what a screen may show. Ids are shown, secrets only as a boolean. */
export interface QuickBooksAppStatus {
  environment: QuickBooksEnvironment;
  sandbox: { clientId: string | null; hasClientSecret: boolean; redirectUri: string | null };
  production: { clientId: string | null; hasClientSecret: boolean; redirectUri: string | null };
  configuredAt: string | null;
  configuredByUserId: string | null;
  /** True when the LIVE environment's three fields are all present, i.e. a connect can be attempted. */
  ready: boolean;
}

const EMPTY_PAIR: StoredQuickBooksAppPair = { clientId: null, clientSecretEncrypted: null, redirectUri: null };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function parsePair(raw: unknown): StoredQuickBooksAppPair {
  if (!raw || typeof raw !== "object") return { ...EMPTY_PAIR };
  const p = raw as Record<string, unknown>;
  return {
    clientId: str(p.clientId),
    clientSecretEncrypted: str(p.clientSecretEncrypted),
    redirectUri: str(p.redirectUri),
  };
}

/** Exported for tests and for callers that already hold the settings blob. */
export function readStoredApp(settings: unknown): StoredQuickBooksApp | null {
  if (!settings || typeof settings !== "object") return null;
  const raw = (settings as Record<string, unknown>).quickbooksApp;
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  return {
    environment: a.environment === "production" ? "production" : "sandbox",
    sandbox: parsePair(a.sandbox),
    production: parsePair(a.production),
    configuredAt: str(a.configuredAt),
    configuredByUserId: str(a.configuredByUserId),
  };
}

/**
 * The live app, or null when the chosen environment's pair is incomplete.
 *
 * A partial pair is no app rather than a half-configured one: a missing
 * redirect URI fails at Intuit with a message nobody can act on, and a
 * missing secret fails at the token exchange, after the person has already
 * granted consent.
 */
export function resolveStoredApp(stored: StoredQuickBooksApp | null): QuickBooksApp | null {
  if (!stored) return null;
  const pair = stored.environment === "production" ? stored.production : stored.sandbox;
  if (!pair.clientId || !pair.clientSecretEncrypted || !pair.redirectUri) return null;
  let clientSecret: string;
  try {
    clientSecret = decryptSecret(pair.clientSecretEncrypted);
  } catch (err) {
    // Almost always a rotated NEXTAUTH_SECRET. Treated as "no app" rather than
    // thrown, so the card says not configured instead of every route 500ing.
    apiLogger.error({ msg: "quickbooks:client-secret-decrypt-failed", err: err instanceof Error ? err.message : String(err) });
    return null;
  }
  return { clientId: pair.clientId, clientSecret, redirectUri: pair.redirectUri, environment: stored.environment };
}

/** The organisation's live Intuit app, or null. The one resolver every route and worker uses. */
export async function loadQuickBooksApp(organizationId: string): Promise<QuickBooksApp | null> {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  return resolveStoredApp(readStoredApp(org?.settings));
}

export function toAppStatus(stored: StoredQuickBooksApp | null): QuickBooksAppStatus {
  const s = stored ?? { environment: "sandbox" as const, sandbox: { ...EMPTY_PAIR }, production: { ...EMPTY_PAIR }, configuredAt: null, configuredByUserId: null };
  const view = (p: StoredQuickBooksAppPair) => ({ clientId: p.clientId, hasClientSecret: !!p.clientSecretEncrypted, redirectUri: p.redirectUri });
  return {
    environment: s.environment,
    sandbox: view(s.sandbox),
    production: view(s.production),
    configuredAt: s.configuredAt,
    configuredByUserId: s.configuredByUserId,
    ready: !!resolveStoredApp(stored),
  };
}

export interface SaveQuickBooksAppPair {
  clientId?: string | null;
  /** Absent or empty KEEPS the stored secret, so editing an id does not force a re-paste. */
  clientSecret?: string | null;
  redirectUri?: string | null;
}

export interface SaveQuickBooksAppInput {
  environment?: QuickBooksEnvironment;
  sandbox?: SaveQuickBooksAppPair;
  production?: SaveQuickBooksAppPair;
  userId: string;
}

function mergePair(existing: StoredQuickBooksAppPair, patch: SaveQuickBooksAppPair | undefined): StoredQuickBooksAppPair {
  if (!patch) return existing;
  const next: StoredQuickBooksAppPair = { ...existing };
  if (patch.clientId !== undefined) next.clientId = str(patch.clientId);
  if (patch.redirectUri !== undefined) next.redirectUri = str(patch.redirectUri);
  if (patch.clientSecret !== undefined) {
    const secret = str(patch.clientSecret);
    // An explicit null CLEARS; an empty string is "left blank, keep what is there".
    if (patch.clientSecret === null) next.clientSecretEncrypted = null;
    else if (secret) next.clientSecretEncrypted = encryptSecret(secret);
  }
  return next;
}

/** Merge a patch into the stored app. Atomic: the helper row-locks the organisation. */
export async function saveQuickBooksApp(organizationId: string, input: SaveQuickBooksAppInput): Promise<StoredQuickBooksApp> {
  let saved: StoredQuickBooksApp | null = null;
  await updateOrganizationSettings(organizationId, (current) => {
    const existing = readStoredApp(current) ?? {
      environment: "sandbox" as QuickBooksEnvironment,
      sandbox: { ...EMPTY_PAIR },
      production: { ...EMPTY_PAIR },
      configuredAt: null,
      configuredByUserId: null,
    };
    const next: StoredQuickBooksApp = {
      environment: input.environment ?? existing.environment,
      sandbox: mergePair(existing.sandbox, input.sandbox),
      production: mergePair(existing.production, input.production),
      configuredAt: new Date().toISOString(),
      configuredByUserId: input.userId,
    };
    saved = next;
    return { ...current, quickbooksApp: next };
  });
  return saved!;
}

/** Remove one environment's credentials, or the whole app when no environment is named. */
export async function clearQuickBooksApp(organizationId: string, environment?: QuickBooksEnvironment): Promise<void> {
  await updateOrganizationSettings(organizationId, (current) => {
    if (!environment) {
      const next = { ...current };
      delete next.quickbooksApp;
      return next;
    }
    const existing = readStoredApp(current);
    if (!existing) return current;
    return { ...current, quickbooksApp: { ...existing, [environment]: { ...EMPTY_PAIR } } };
  });
}
