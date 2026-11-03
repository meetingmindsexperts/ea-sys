/**
 * The organisation's DET eTicketing credentials, in `Organization.settings.dtcmEticket`.
 *
 * One set per environment, because UAT and production are separate DET
 * accounts and an organisation keeps both: the sandbox for rehearsal, the
 * production set for real permits. Client secret and API key are stored
 * AES-256-GCM encrypted (`encryptSecret`, the Zoom and EventsAir scheme); the
 * client id is not secret (it is the seller code on every order).
 *
 * The API key travels in DET's query string, so it is a secret here even
 * though DET calls it a key: anyone holding it with the client secret can buy
 * tickets against the permit.
 */
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/eventsair-client";
import { apiLogger } from "@/lib/logger";
import {
  DET_ENVIRONMENTS,
  type DetCredentials,
  type DetCredentialsStatus,
  type DetEnvironment,
  type DetEnvironmentStatus,
} from "./types";

/** As stored. Every field optional: an environment may be half set up. */
export interface StoredDetEnvironment {
  clientId?: string;
  clientSecretEncrypted?: string;
  apiKeyEncrypted?: string;
  apiKeyLast4?: string;
  configuredAt?: string;
}

export interface StoredDetSettings {
  activeEnvironment?: DetEnvironment;
  staging?: StoredDetEnvironment;
  production?: StoredDetEnvironment;
}

export const DET_SETTINGS_KEY = "dtcmEticket";

/** The stored block, or an empty one; never throws on a malformed blob. */
export function readStoredDetSettings(orgSettings: unknown): StoredDetSettings {
  if (!orgSettings || typeof orgSettings !== "object") return {};
  const raw = (orgSettings as Record<string, unknown>)[DET_SETTINGS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as StoredDetSettings;
}

function isComplete(env: StoredDetEnvironment | undefined): env is Required<Pick<StoredDetEnvironment, "clientId" | "clientSecretEncrypted" | "apiKeyEncrypted">> & StoredDetEnvironment {
  return Boolean(env?.clientId && env.clientSecretEncrypted && env.apiKeyEncrypted);
}

function environmentStatus(env: StoredDetEnvironment | undefined): DetEnvironmentStatus {
  return {
    configured: isComplete(env),
    clientId: env?.clientId ?? null,
    hasClientSecret: Boolean(env?.clientSecretEncrypted),
    apiKeyLast4: env?.apiKeyLast4 ?? null,
    configuredAt: env?.configuredAt ?? null,
  };
}

/** What the settings screen may see: no secret, no ciphertext. */
export function detCredentialsStatus(stored: StoredDetSettings): DetCredentialsStatus {
  return {
    activeEnvironment: stored.activeEnvironment ?? "staging",
    staging: environmentStatus(stored.staging),
    production: environmentStatus(stored.production),
  };
}

export function isDetEnvironment(value: unknown): value is DetEnvironment {
  return typeof value === "string" && (DET_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * Decrypted credentials for one environment, or null when that environment
 * is not fully set up or cannot be decrypted. A
 * decryption failure is logged: it means NEXTAUTH_SECRET rotated without the
 * fallback (see the EC2 deploy notes), not that DTCM is unconfigured.
 *
 * Omitting `environment` means the ACTIVE one, which is right only for
 * starting new work. Anything acting on an existing order or basket must pass
 * the environment recorded with it: the active one can change in between,
 * and DET answers "not found" for another environment's order.
 */
export async function getDetCredentials(
  organizationId: string,
  environment?: DetEnvironment,
): Promise<DetCredentials | null> {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  const stored = readStoredDetSettings(org?.settings);
  const env = environment ?? stored.activeEnvironment ?? "staging";
  const block = stored[env];
  if (!isComplete(block)) return null;

  try {
    return {
      organizationId,
      environment: env,
      clientId: block.clientId,
      clientSecret: decryptSecret(block.clientSecretEncrypted),
      apiKey: decryptSecret(block.apiKeyEncrypted),
      version: block.configuredAt ?? "",
    };
  } catch (err) {
    apiLogger.error({ err, organizationId, environment: env, msg: "dtcm-eticket:credentials-decrypt-failed" });
    return null;
  }
}
