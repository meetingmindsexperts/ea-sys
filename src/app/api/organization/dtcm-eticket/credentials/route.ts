import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { encryptSecret } from "@/lib/eventsair-client";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { updateOrganizationSettings } from "@/lib/event-settings";
import { requirePermission } from "@/lib/permissions/require-permission";
import { clearDetTokenCache } from "@/lib/dtcm-eticket/client";
import {
  DET_SETTINGS_KEY,
  detCredentialsStatus,
  readStoredDetSettings,
  type StoredDetEnvironment,
  type StoredDetSettings,
} from "@/lib/dtcm-eticket/credentials";

/**
 * The organisation's DET eTicketing credentials (docs/DTCM_ETICKET_PLAN.md §4.1),
 * one set per environment. A save writes ONE environment. It switches the
 * ACTIVE environment only when asked (`activate`), or when none is active yet:
 * correcting the sandbox client id during a live event must not move every
 * later purchase onto test tickets (review MED 4, Nov 3 2026). A switch is
 * audited as its own action. Secrets are optional on update: blank keeps the
 * stored value.
 * Values are trimmed, as for Zoom: a pasted secret with a trailing newline
 * fails every token request with nothing to say why.
 */
const credentialsSchema = z.object({
  environment: z.enum(["staging", "production"]),
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().max(500).optional(),
  apiKey: z.string().trim().max(500).optional(),
  /** Make this environment the one new DTCM work uses. */
  activate: z.boolean().optional(),
});

/** Thrown inside the locked merge to abandon it; nothing is written. */
class IncompleteCredentials extends Error {
  constructor(readonly missing: string[]) {
    super("incomplete");
  }
}

/** Which environment fields a save altered, without a secret or its ciphertext. */
function describeChange(before: StoredDetSettings, after: StoredDetSettings): Prisma.JsonObject {
  const changed: Prisma.JsonObject = {};
  for (const env of ["staging", "production"] as const) {
    const b: StoredDetEnvironment = before[env] ?? {};
    const a: StoredDetEnvironment = after[env] ?? {};
    if (b.clientId !== a.clientId) changed[`${env}.clientId`] = { from: b.clientId ?? null, to: a.clientId ?? null };
    if (b.clientSecretEncrypted !== a.clientSecretEncrypted) changed[`${env}.clientSecret`] = { rotated: true };
    if (b.apiKeyEncrypted !== a.apiKeyEncrypted) changed[`${env}.apiKey`] = { rotated: true, last4: a.apiKeyLast4 ?? null };
  }
  if ((before.activeEnvironment ?? "staging") !== (after.activeEnvironment ?? "staging")) {
    changed.activeEnvironment = { from: before.activeEnvironment ?? "staging", to: after.activeEnvironment ?? "staging" };
  }
  return changed;
}

function audit(userId: string, organizationId: string, action: string, changes: Prisma.JsonObject, ip: string | null) {
  void db.auditLog
    .create({
      data: { userId, organizationId, action, entityType: "Organization", entityId: organizationId, changes, ipAddress: ip },
    })
    .catch((err) => apiLogger.error({ err, userId, msg: "dtcm-eticket:credentials-audit-failed" }));
}

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const gate = requirePermission(session, "org.credentials", { route: "organization/dtcm-eticket/credentials:GET" });
    if (!gate.ok) return gate.response;

    const org = await db.organization.findUnique({
      where: { id: session.user.organizationId },
      select: { settings: true },
    });
    return NextResponse.json(detCredentialsStatus(readStoredDetSettings(org?.settings)));
  } catch (error) {
    apiLogger.error({ err: error, msg: "dtcm-eticket:credentials-fetch-failed" });
    return NextResponse.json({ error: "Failed to fetch credentials" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json().catch(() => null)]);
    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const organizationId = session.user.organizationId;

    const gate = requirePermission(session, "org.credentials", { route: "organization/dtcm-eticket/credentials:PUT" });
    if (!gate.ok) return gate.response;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `dtcm-eticket-creds:${organizationId}`,
      limit: 10,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: session.user.id, msg: "dtcm-eticket:credentials-rate-limited" });
      return NextResponse.json(
        { error: "Too many requests", retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const validated = credentialsSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten(), msg: "dtcm-eticket:credentials-validation-failed" });
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }
    const { environment, clientId, clientSecret, apiKey, activate } = validated.data;

    // The whole read-modify-write runs under the settings row lock, so two
    // saves (one per environment) cannot overwrite each other.
    let before: StoredDetSettings = {};
    let after: StoredDetSettings = {};
    try {
      await updateOrganizationSettings(organizationId, (cur) => {
        before = readStoredDetSettings(cur);
        const current: StoredDetEnvironment = before[environment] ?? {};
        // A first save of an environment needs both secrets; later saves may keep them.
        const missing = [
          !clientSecret && !current.clientSecretEncrypted ? "client secret" : null,
          !apiKey && !current.apiKeyEncrypted ? "API key" : null,
        ].filter((m): m is string => m !== null);
        if (missing.length > 0) throw new IncompleteCredentials(missing);

        const next: StoredDetEnvironment = {
          ...current,
          clientId,
          ...(clientSecret && { clientSecretEncrypted: encryptSecret(clientSecret) }),
          ...(apiKey && { apiKeyEncrypted: encryptSecret(apiKey), apiKeyLast4: apiKey.slice(-4) }),
          configuredAt: new Date().toISOString(),
        };
        after = { ...before, [environment]: next, activeEnvironment: activate ? environment : (before.activeEnvironment ?? environment) };
        return { ...cur, [DET_SETTINGS_KEY]: after as unknown as Prisma.JsonObject };
      });
    } catch (err) {
      if (!(err instanceof IncompleteCredentials)) throw err;
      apiLogger.warn({ userId: session.user.id, environment, missing: err.missing, msg: "dtcm-eticket:credentials-incomplete" });
      return NextResponse.json(
        { error: `Enter the ${err.missing.join(" and ")} for this environment`, code: "CREDENTIALS_INCOMPLETE" },
        { status: 400 },
      );
    }
    // A rotated secret must not keep riding on a token minted with the old one.
    clearDetTokenCache();

    const changed = describeChange(before, after);
    const switched = "activeEnvironment" in changed;
    apiLogger.info({ userId: session.user.id, environment, changed, switched, msg: "dtcm-eticket:credentials-saved" });
    audit(
      session.user.id,
      organizationId,
      switched ? "SWITCH_DTCM_ETICKET_ENVIRONMENT" : "UPDATE_DTCM_ETICKET_CREDENTIALS",
      { changed },
      getClientIp(req),
    );

    return NextResponse.json(detCredentialsStatus(after));
  } catch (error) {
    apiLogger.error({ err: error, msg: "dtcm-eticket:credentials-save-failed" });
    return NextResponse.json({ error: "Failed to save credentials" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const organizationId = session.user.organizationId;

    const gate = requirePermission(session, "org.credentials", { route: "organization/dtcm-eticket/credentials:DELETE" });
    if (!gate.ok) return gate.response;

    await updateOrganizationSettings(organizationId, (cur) => {
      const next = { ...cur };
      delete next[DET_SETTINGS_KEY];
      return next;
    });
    clearDetTokenCache();

    apiLogger.info({ userId: session.user.id, msg: "dtcm-eticket:credentials-deleted" });
    audit(session.user.id, organizationId, "DELETE_DTCM_ETICKET_CREDENTIALS", { cleared: true }, getClientIp(req));

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "dtcm-eticket:credentials-delete-failed" });
    return NextResponse.json({ error: "Failed to delete credentials" }, { status: 500 });
  }
}
