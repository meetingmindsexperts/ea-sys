/**
 * The organisation's Intuit app credentials: GET the safe view, PUT to save,
 * DELETE to remove.
 *
 * Lives beside the other QuickBooks routes rather than under
 * /api/organization/ (where the Zoom, Stripe and AI credentials sit) because
 * everything about QuickBooks is already in this namespace: the eslint
 * core-to-module exemption and the tenancy CI gate both name this directory,
 * and the redirect URI registered at Intuit is built from it.
 *
 * A client secret is never returned, not even as a prefix. The GET says
 * whether one exists; that is all a screen needs.
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { apiLogger } from "@/lib/logger";
import { rateLimited } from "@/lib/api-errors";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { procurementGuard } from "@/procurement/lib/route-helpers";
import {
  QBO_CALLBACK_PATH,
  clearQuickBooksApp,
  readStoredApp,
  saveQuickBooksApp,
  toAppStatus,
  validateRedirectUri,
  type StoredQuickBooksApp,
} from "@/procurement/integrations/quickbooks/app";
import type { QuickBooksEnvironment } from "@/procurement/integrations/quickbooks/config";
import { z } from "zod";

const ROUTE = "integrations/quickbooks/credentials";

const pairSchema = z
  .object({
    clientId: z.string().max(500).optional(),
    /** Omitted or empty KEEPS the stored secret; an explicit null clears it. */
    clientSecret: z.string().max(500).nullable().optional(),
    redirectUri: z.string().max(500).optional(),
  })
  .strict();

const bodySchema = z
  .object({
    environment: z.enum(["sandbox", "production"]).optional(),
    sandbox: pairSchema.optional(),
    production: pairSchema.optional(),
  })
  .strict();

/**
 * The redirect URI to offer when none is stored.
 *
 * `NEXT_PUBLIC_APP_URL` first because it is the address the deployment knows
 * itself by; the request origin as a fallback so a developer on a port the
 * env file does not name still gets a usable suggestion rather than a blank.
 */
function suggestedRedirectUri(req: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const base = configured && configured.length > 0 ? configured : new URL(req.url).origin;
  return `${base.replace(/\/+$/, "")}${QBO_CALLBACK_PATH}`;
}

export async function GET(req: NextRequest) {
  const g = await procurementGuard({ route: ROUTE, need: "integration" });
  if (!g.ok) return g.response;

  return runWithTenant(g.orgId, async () => {
    const org = await db.organization.findUnique({ where: { id: g.orgId }, select: { settings: true } });
    return NextResponse.json({
      app: toAppStatus(readStoredApp(org?.settings)),
      suggestedRedirectUri: suggestedRedirectUri(req),
    });
  });
}

export async function PUT(req: NextRequest) {
  const g = await procurementGuard({ route: ROUTE, need: "integration", write: true });
  if (!g.ok) return g.response;

  const rl = checkRateLimit({ key: `quickbooks-creds:${g.orgId}`, limit: 10, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) return rateLimited(rl, { route: ROUTE, userId: g.user.id, limit: 10, windowSeconds: 3600 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    apiLogger.warn({ msg: `${ROUTE}:invalid-json`, organizationId: g.orgId, userId: g.user.id });
    return NextResponse.json({ error: "Invalid JSON", code: "INVALID_JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    apiLogger.warn({ msg: `${ROUTE}:validation-failed`, organizationId: g.orgId, errors: parsed.error.flatten() });
    return NextResponse.json({ error: "Invalid input", code: "INVALID_INPUT", details: parsed.error.flatten() }, { status: 400 });
  }

  return runWithTenant(g.orgId, async () => {
    const org = await db.organization.findUnique({ where: { id: g.orgId }, select: { settings: true } });
    const before = readStoredApp(org?.settings);

    // Validate each redirect URI against the environment it belongs to, not the
    // live one: someone filling in production while still running sandbox must
    // still be told that an http production URI can never be registered.
    for (const env of ["sandbox", "production"] as const) {
      const value = parsed.data[env]?.redirectUri;
      if (value === undefined || value.trim().length === 0) continue;
      const problem = validateRedirectUri(value.trim(), env);
      if (problem) {
        apiLogger.warn({ msg: `${ROUTE}:bad-redirect-uri`, organizationId: g.orgId, environment: env });
        return NextResponse.json({ error: problem, code: "INVALID_REDIRECT_URI", field: `${env}.redirectUri` }, { status: 400 });
      }
    }

    const after = await saveQuickBooksApp(g.orgId, {
      environment: parsed.data.environment,
      sandbox: parsed.data.sandbox,
      production: parsed.data.production,
      userId: g.user.id,
    });

    const changed = describeChange(before, after);
    apiLogger.info({ msg: `${ROUTE}:saved`, organizationId: g.orgId, userId: g.user.id, environment: after.environment, changed });

    // Fire-and-forget: the credentials are already written, and losing the
    // audit row must not turn a successful save into a 500.
    void db.auditLog
      .create({
        data: {
          userId: g.user.id,
          organizationId: g.orgId,
          action: "UPDATE_QUICKBOOKS_CREDENTIALS",
          entityType: "Organization",
          entityId: g.orgId,
          changes: { changed, environment: after.environment, ip: getClientIp(req) },
          ipAddress: getClientIp(req),
        },
      })
      .catch((err) => apiLogger.error({ msg: `${ROUTE}:audit-failed`, organizationId: g.orgId, err: err instanceof Error ? err.message : String(err) }));

    return NextResponse.json({ app: toAppStatus(after), suggestedRedirectUri: suggestedRedirectUri(req) });
  });
}

export async function DELETE(req: NextRequest) {
  const g = await procurementGuard({ route: ROUTE, need: "integration", write: true });
  if (!g.ok) return g.response;

  const raw = new URL(req.url).searchParams.get("environment");
  if (raw !== null && raw !== "sandbox" && raw !== "production") {
    apiLogger.warn({ msg: `${ROUTE}:bad-environment`, organizationId: g.orgId, value: raw });
    return NextResponse.json({ error: "environment must be sandbox or production", code: "INVALID_ENVIRONMENT" }, { status: 400 });
  }
  const environment = (raw ?? undefined) as QuickBooksEnvironment | undefined;

  return runWithTenant(g.orgId, async () => {
    await clearQuickBooksApp(g.orgId, environment);
    apiLogger.info({ msg: `${ROUTE}:cleared`, organizationId: g.orgId, userId: g.user.id, environment: environment ?? "all" });

    void db.auditLog
      .create({
        data: {
          userId: g.user.id,
          organizationId: g.orgId,
          action: "UPDATE_QUICKBOOKS_CREDENTIALS",
          entityType: "Organization",
          entityId: g.orgId,
          changes: { cleared: environment ?? "all", ip: getClientIp(req) },
          ipAddress: getClientIp(req),
        },
      })
      .catch((err) => apiLogger.error({ msg: `${ROUTE}:audit-failed`, organizationId: g.orgId, err: err instanceof Error ? err.message : String(err) }));

    const org = await db.organization.findUnique({ where: { id: g.orgId }, select: { settings: true } });
    return NextResponse.json({ app: toAppStatus(readStoredApp(org?.settings)), suggestedRedirectUri: suggestedRedirectUri(req) });
  });
}

/**
 * Which fields a save altered, as a before to after of client ids plus a bare
 * "rotated" for secrets.
 *
 * The same shape the Zoom credentials route writes, and for the same reason:
 * on 2026-08-19 two people changed Zoom credentials on production hours apart
 * and the only trace was a single timestamp each save overwrote, which made a
 * failed live webinar impossible to explain. A client id is not a secret, so
 * it is recorded in full; a client secret is never recorded, not even a prefix.
 */
function describeChange(before: StoredQuickBooksApp | null, after: StoredQuickBooksApp): Prisma.JsonObject {
  const changed: Prisma.JsonObject = {};
  for (const env of ["sandbox", "production"] as const) {
    const b = before?.[env];
    const a = after[env];
    if ((b?.clientId ?? null) !== a.clientId) changed[`${env}.clientId`] = { from: b?.clientId ?? null, to: a.clientId };
    if ((b?.redirectUri ?? null) !== a.redirectUri) changed[`${env}.redirectUri`] = { from: b?.redirectUri ?? null, to: a.redirectUri };
    if ((b?.clientSecretEncrypted ?? null) !== a.clientSecretEncrypted) {
      changed[`${env}.clientSecret`] = a.clientSecretEncrypted ? { rotated: true } : { cleared: true };
    }
  }
  if ((before?.environment ?? null) !== after.environment) changed.environment = { from: before?.environment ?? null, to: after.environment };
  return changed;
}
