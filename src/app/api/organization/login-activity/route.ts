/**
 * GET /api/organization/login-activity
 *
 * Sign-in history for the caller's organization — who signed in, when, from
 * which address and approximately where.
 *
 * SCOPING
 * -------
 * Strictly `organizationId = caller's org`. Attempts against addresses that
 * match no account carry a null organizationId and are therefore invisible
 * here by construction. That is intended: address spray is background noise,
 * while an attack on a real account in this org resolves to a user and so
 * DOES show up. The full record remains queryable directly for forensics.
 *
 * GEO
 * ---
 * Locations are resolved here, lazily, rather than at sign-in time — a slow
 * provider must never sit between a password check and a session. Each row's
 * answer is written back so any given address costs one lookup ever, and the
 * write-back is keyed on the IP so every row sharing it is filled in at once.
 * A failed lookup writes nothing, leaving the row to be retried next time.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { denyLoginActivity } from "@/lib/login-visibility";
import { checkRateLimit } from "@/lib/security";
import { rateLimited, zodErrorResponse } from "@/lib/api-errors";
import { resolveIpLocation, isGeoEnabled } from "@/lib/login-geo";
import { mapWithConcurrency } from "@/lib/concurrency";
import type { Prisma } from "@prisma/client";

const ROUTE = "GET /api/organization/login-activity";

/** Bounded so one page-load can't fan out into dozens of outbound calls. */
const MAX_GEO_LOOKUPS_PER_REQUEST = 25;
const GEO_CONCURRENCY = 5;

const querySchema = z.object({
  outcome: z.enum(["all", "success", "failed"]).default("all"),
  /** Narrow to one person's history. */
  userId: z.string().min(1).max(64).optional(),
  /** Look-back window in days. */
  days: z.coerce.number().int().min(1).max(365).default(30),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      apiLogger.warn({ msg: `${ROUTE}:unauthenticated` });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const org = requireOrgId(session, { route: ROUTE });
    if ("error" in org) return org.error;

    const denied = denyLoginActivity({
      role: session.user.role,
      userId: session.user.id,
      organizationId: org.orgId,
    });
    if (denied) return denied;

    // Modest limit: this endpoint can trigger outbound geo lookups, so it
    // shouldn't be hammerable even by a legitimate admin holding refresh.
    const rl = checkRateLimit({
      key: `login-activity:${session.user.id}`,
      limit: 120,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      return rateLimited(rl, { route: ROUTE, userId: session.user.id, limit: 120, windowSeconds: 3600 });
    }

    const url = new URL(req.url);
    const parsed = querySchema.safeParse({
      outcome: url.searchParams.get("outcome") ?? undefined,
      userId: url.searchParams.get("userId") ?? undefined,
      days: url.searchParams.get("days") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route: ROUTE, userId: session.user.id });
    }
    const { outcome, userId, days, page, limit } = parsed.data;

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const where: Prisma.LoginEventWhereInput = {
      organizationId: org.orgId,
      createdAt: { gte: since },
      ...(userId ? { userId } : {}),
      ...(outcome === "success"
        ? { outcome: "SUCCESS" as const }
        : outcome === "failed"
          ? { outcome: { not: "SUCCESS" as const } }
          : {}),
    };

    const [total, rows] = await Promise.all([
      db.loginEvent.count({ where }),
      db.loginEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          email: true,
          outcome: true,
          surface: true,
          ipAddress: true,
          userAgent: true,
          geoCity: true,
          geoCountry: true,
          geoResolvedAt: true,
          createdAt: true,
          user: { select: { id: true, firstName: true, lastName: true, role: true } },
        },
      }),
    ]);

    const resolved = await fillInMissingLocations(rows, org.orgId);

    return NextResponse.json({
      events: resolved,
      total,
      page,
      limit,
      geoEnabled: isGeoEnabled(),
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to load sign-in activity" }, { status: 500 });
  }
}

type LoginRow = {
  id: string;
  ipAddress: string | null;
  geoCity: string | null;
  geoCountry: string | null;
  geoResolvedAt: Date | null;
};

/**
 * Resolve any not-yet-looked-up addresses on this page and persist the answers.
 *
 * Failure-isolated end to end: if geo is off, over budget, or the provider is
 * unreachable, the rows come back exactly as stored (location empty, IP still
 * shown) and the request still succeeds. Location is a nice-to-have; the list
 * itself is not.
 */
async function fillInMissingLocations<T extends LoginRow>(
  rows: T[],
  organizationId: string,
): Promise<T[]> {
  if (!isGeoEnabled()) return rows;

  const pending = [
    ...new Set(
      rows
        .filter((r) => r.geoResolvedAt === null && r.ipAddress)
        .map((r) => r.ipAddress as string),
    ),
  ].slice(0, MAX_GEO_LOOKUPS_PER_REQUEST);

  if (pending.length === 0) return rows;

  const found = new Map<string, { city: string | null; country: string | null }>();

  try {
    await mapWithConcurrency(pending, GEO_CONCURRENCY, async (ip) => {
      const lookup = await resolveIpLocation(ip);
      // `ok: false` means transient — write nothing so it retries next view.
      if (!lookup.ok) return;

      found.set(ip, lookup.location);

      // Stamp every row in this org sharing the address, not just the ones on
      // this page — one lookup, all rows filled.
      await db.loginEvent.updateMany({
        where: { organizationId, ipAddress: ip, geoResolvedAt: null },
        data: {
          geoCity: lookup.location.city,
          geoCountry: lookup.location.country,
          geoResolvedAt: new Date(),
        },
      });
    });
  } catch (err) {
    // Never fail the list because location lookup misbehaved.
    apiLogger.warn({ err, msg: "login-activity:geo-fill-failed" });
    return rows;
  }

  return rows.map((row) => {
    if (row.geoResolvedAt !== null || !row.ipAddress) return row;
    const hit = found.get(row.ipAddress);
    if (!hit) return row;
    return { ...row, geoCity: hit.city, geoCountry: hit.country, geoResolvedAt: new Date() };
  });
}
