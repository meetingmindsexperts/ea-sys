/**
 * The CRM's email identity, PER ORGANISATION (Nov 6, 2026; CRM product review
 * P0-1/2). SERVER ONLY.
 *
 * Four things used to be one global value each: the From address every CRM
 * email goes out under, the shared mailbox a sponsor's reply is copied to, the
 * reply subdomain the tokenized Reply-To lives on, and the secret address the
 * mailbox capture arrives at. On one deployment serving several organisations
 * that meant tenant B's sponsor replies were forwarded into tenant A's
 * partnerships mailbox (docs/MULTI_TENANCY_IMPACT.md, the 🔴 item). So each is
 * now resolved from the organisation the email belongs to.
 *
 * WHERE IT COMES FROM, in order:
 *   1. `Organization.settings.crmEmail` (set by the platform operator,
 *      PUT /api/organizations/[orgId]/crm-email). When the block is there it is
 *      used WHOLE: never mixed with the environment, so an organisation can
 *      never inherit another's reply domain or mailbox one field at a time.
 *   2. The CRM_EMAIL_* / CRM_REPLY_DOMAIN / CRM_CAPTURE_ADDRESS environment,
 *      but ONLY for the organisation that environment describes:
 *      CRM_EMAIL_ORG_ID, else CRM_CAPTURE_ORG_ID (master sets the latter, so
 *      master needed no change). The environment names one mailbox, and a
 *      mailbox belongs to one organisation.
 *   3. Nothing. Sends go out under the deployment's default sender (or the
 *      event's), carry no tokenized Reply-To, and no reply is copied anywhere.
 *      The fail-closed answer: an organisation nobody configured leaks nothing.
 *
 * WHY IN CORE AND NOT src/crm/: it is ORGANISATION configuration the platform
 * operator sets (the operator route lives in core), the same reason the module
 * flags moved here. The CRM reads it; core never needs anything from the CRM.
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

export interface CrmEmailIdentity {
  /** The From for every CRM email; null = the deployment / event default. */
  sender: { email: string; name?: string } | null;
  /** The shared mailbox a sponsor's reply is copied to; null = none. */
  forwardTo: string | null;
  /** The subdomain tokenized Reply-To addresses live on; null = no Reply-To. */
  replyDomain: string | null;
  /** The secret address the mailbox rule copies mail to; null = no capture. */
  captureAddress: string | null;
  source: "organisation" | "environment" | "none";
}

const NONE: CrmEmailIdentity = { sender: null, forwardTo: null, replyDomain: null, captureAddress: null, source: "none" };

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, "Not a domain");
const email = z.string().trim().toLowerCase().email().max(254);

/** The stored block, as the operator route validates it. */
export const crmEmailSettingsSchema = z.object({
  fromAddress: email,
  fromName: z.string().trim().max(120).optional().nullable(),
  forwardTo: email.optional().nullable(),
  replyDomain: domain.optional().nullable(),
  captureAddress: email.optional().nullable(),
});
export type CrmEmailSettings = z.infer<typeof crmEmailSettingsSchema>;

/** Read `settings.crmEmail`; null when absent or corrupt (a corrupt block is logged, never half-used). */
export function readCrmEmailSettings(settings: unknown, organizationId?: string): CrmEmailSettings | null {
  const raw = (settings as { crmEmail?: unknown } | null)?.crmEmail;
  if (raw === undefined || raw === null) return null;
  const parsed = crmEmailSettingsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  apiLogger.error({ msg: "crm-email-identity:corrupt-settings", organizationId, errors: parsed.error.flatten().fieldErrors });
  return null;
}

/** The organisation the CRM email environment belongs to, if any. */
export function environmentOrgId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.CRM_EMAIL_ORG_ID?.trim() || env.CRM_CAPTURE_ORG_ID?.trim() || null;
}

/** Pure: the identity for one organisation from its settings and the environment. */
export function resolveIdentity(organizationId: string, settings: unknown, env: NodeJS.ProcessEnv = process.env): CrmEmailIdentity {
  const own = readCrmEmailSettings(settings, organizationId);
  if (own) {
    return {
      sender: { email: own.fromAddress, ...(own.fromName ? { name: own.fromName } : {}) },
      forwardTo: own.forwardTo ?? own.fromAddress,
      replyDomain: own.replyDomain ?? null,
      captureAddress: own.captureAddress ?? null,
      source: "organisation",
    };
  }
  if (environmentOrgId(env) !== organizationId) return NONE;
  const from = env.CRM_EMAIL_FROM_ADDRESS?.trim().toLowerCase() || null;
  return {
    sender: from ? { email: from, ...(env.CRM_EMAIL_FROM_NAME?.trim() ? { name: env.CRM_EMAIL_FROM_NAME.trim() } : {}) } : null,
    forwardTo: from,
    replyDomain: env.CRM_REPLY_DOMAIN?.trim().toLowerCase() || null,
    captureAddress: env.CRM_CAPTURE_ADDRESS?.trim().toLowerCase() || null,
    source: "environment",
  };
}

/**
 * The identity for an organisation. NONE means "nothing configured" (or no
 * such organisation); a READ FAILURE THROWS instead, because the two must not
 * look alike: read as NONE, a database blip filed a real reply as unmatched
 * for good and sent a deal email with no Reply-To (review of e6dc9745, MED-2).
 * The worker retries a throw next tick; a send reports it as a failure.
 */
export async function crmEmailIdentity(organizationId: string): Promise<CrmEmailIdentity> {
  let org: { settings: unknown } | null;
  try {
    org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  } catch (err) {
    apiLogger.error({ msg: "crm-email-identity:read-failed", organizationId, err: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  if (!org) {
    apiLogger.warn({ msg: "crm-email-identity:org-not-found", organizationId });
    return NONE;
  }
  return resolveIdentity(organizationId, org.settings);
}

/** True when the address is the environment's capture address and the organisation is not the environment's. */
export function claimsEnvironmentAddress(organizationId: string, address: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const envAddress = env.CRM_CAPTURE_ADDRESS?.trim().toLowerCase();
  return !!envAddress && envAddress === address.trim().toLowerCase() && environmentOrgId(env) !== organizationId;
}

/**
 * Which organisation a capture address belongs to: the one whose own block
 * names it, else the environment's organisation when it is the environment's
 * address. Null when nobody claims it (the mail stays unmatched). Two
 * organisations claiming one address answers null too, logged: guessing would
 * file one tenant's mail into another's inbox.
 */
export async function organisationForCaptureAddress(address: string): Promise<string | null> {
  const addr = address.trim().toLowerCase();
  if (!addr) return null;
  const claimed = await db.organization.findMany({
    where: { settings: { path: ["crmEmail", "captureAddress"], equals: addr } },
    select: { id: true },
    take: 2,
  });
  if (claimed.length > 1) {
    apiLogger.error({ msg: "crm-email-identity:capture-address-claimed-twice", address: addr });
    return null;
  }
  if (claimed.length === 1) {
    // The environment's address belongs to the environment's organisation:
    // another organisation naming it in its block would reroute that mailbox's
    // copies into its own inbox (review of e6dc9745, MED-1). Refuse, loudly.
    if (claimsEnvironmentAddress(claimed[0].id, addr)) {
      apiLogger.error({ msg: "crm-email-identity:env-capture-address-claimed", address: addr, organizationId: claimed[0].id });
      return null;
    }
    return claimed[0].id;
  }
  const envOrg = environmentOrgId();
  const envAddress = process.env.CRM_CAPTURE_ADDRESS?.trim().toLowerCase();
  if (!envOrg || envAddress !== addr) {
    apiLogger.warn({ msg: "crm-email-identity:capture-address-unclaimed", address: addr });
    return null;
  }
  // The environment's organisation may have its own block now, naming another address.
  const own = await crmEmailIdentity(envOrg);
  if (own.source === "environment") return envOrg;
  // A wrong CRM_CAPTURE_ORG_ID (no such organisation), or the organisation moved to its own block.
  apiLogger.error({ msg: "crm-email-identity:env-capture-org-unusable", organizationId: envOrg, source: own.source });
  return null;
}
