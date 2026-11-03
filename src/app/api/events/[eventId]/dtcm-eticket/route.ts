import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { updateEventSettings } from "@/lib/event-settings";
import { DetApiError, getDetPerformance } from "@/lib/dtcm-eticket/client";
import { getDetCredentials } from "@/lib/dtcm-eticket/credentials";
import {
  DTCM_EVENT_SETTINGS_KEY,
  mappingProblem,
  readDtcmEventSettings,
  type DtcmSectionMapping,
  type StoredDtcmEventSettings,
} from "@/lib/dtcm-eticket/sections";
import type { DetPerformanceSummary } from "@/lib/dtcm-eticket/types";

/**
 * An event's DET sections (docs/DTCM_ETICKET_PLAN.md step 2).
 *
 * GET — the event's performance as DET has it now (sections, capacities,
 *       price types), each registration type's mapping, and how many in-person
 *       registrations each type holds. A DET failure is part of the answer
 *       (`det.error`), not a 5xx: the page shows it and the mapping stays
 *       readable.
 * PUT — save the mapping. Every entry is checked against DET's live map
 *       first, so nothing is saved that DET would refuse at purchase time.
 *
 * `events.settings`: the mapping is event configuration, beside the
 * performance code it belongs to. Nothing is bought here.
 *
 * Organisation members only, like the event Zoom settings: the DET account is
 * the organisation's, and a caller with no organisation (the platform
 * operator) must not reach a tenant's permit through it.
 */
interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const mappingSchema = z.object({
  area: z.string().trim().min(1).max(50),
  priceTypeCode: z.string().trim().min(1).max(50),
});

const putSchema = z.object({
  /** Every mapped type; a type left out (or null) is unmapped. */
  sections: z.record(z.string().min(1).max(50), mappingSchema.nullable()),
});

function noOrganisation(eventId: string, userId: string, method: string) {
  apiLogger.warn({ msg: "dtcm-eticket:event-sections-no-org", eventId, userId, method });
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

type DetLookup =
  | { performance: DetPerformanceSummary; environment: "staging" | "production"; error: null }
  | { performance: null; environment: "staging" | "production" | null; error: { message: string; stage: string; code: string } };

/** The event's performance from DET, or why it could not be read. Never throws a DET error. */
async function lookUpPerformance(organizationId: string, performanceCode: string, eventId: string): Promise<DetLookup> {
  const creds = await getDetCredentials(organizationId);
  if (!creds) {
    apiLogger.warn({ msg: "dtcm-eticket:event-sections-not-configured", eventId });
    return {
      performance: null,
      environment: null,
      error: { message: "DET credentials are not set up. Add them under Settings, Integrations.", stage: "config", code: "NOT_CONFIGURED" },
    };
  }
  try {
    return { performance: await getDetPerformance(creds, performanceCode), environment: creds.environment, error: null };
  } catch (err) {
    if (!(err instanceof DetApiError)) throw err;
    apiLogger.warn({
      msg: "dtcm-eticket:event-sections-det-failed",
      eventId,
      environment: creds.environment,
      stage: err.stage,
      httpStatus: err.httpStatus,
      detCode: err.detCode,
    });
    return { performance: null, environment: creds.environment, error: { message: err.message, stage: err.stage, code: "DET_FAILED" } };
  }
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!session.user.organizationId) return noOrganisation(eventId, session.user.id, "GET");
    const gate = requirePermission(session, "events.settings", { route: "events/[eventId]/dtcm-eticket:GET", eventId });
    if (!gate.ok) return gate.response;

    return await runWithTenantLane(session.user.organizationId, { route: "events:dtcm-eticket:GET", userId: session.user.id }, async () => {
      const event = await db.event.findFirst({
        where: gate.eventWhere,
        select: { id: true, organizationId: true, requiresDtcmBarcode: true, dtcmPerformanceCode: true, settings: true },
      });
      if (!event) {
        apiLogger.warn({ msg: "dtcm-eticket:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }

      const stored = readDtcmEventSettings(event.settings);
      const [ticketTypes, counts] = await Promise.all([
        db.ticketType.findMany({
          where: { eventId },
          select: { id: true, name: true, isFaculty: true, isActive: true },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        }),
        db.registration.groupBy({
          by: ["ticketTypeId"],
          where: { eventId, status: { not: "CANCELLED" }, attendanceMode: "IN_PERSON" },
          _count: { _all: true },
        }),
      ]);
      const countByType = new Map(counts.map((c) => [c.ticketTypeId, c._count._all]));

      const base = {
        requiresDtcmBarcode: event.requiresDtcmBarcode,
        performanceCode: event.dtcmPerformanceCode,
        mapping: {
          sections: stored.sections ?? {},
          environment: stored.environment ?? null,
          performanceCode: stored.performanceCode ?? null,
          checkedAt: stored.checkedAt ?? null,
        },
        ticketTypes: ticketTypes.map((t) => ({ ...t, registrations: countByType.get(t.id) ?? 0 })),
      };

      // Nothing to ask DET until DTCM is on with a code (step 0's rule).
      if (!event.requiresDtcmBarcode || !event.dtcmPerformanceCode) {
        return NextResponse.json({ ...base, det: null });
      }
      const det = await lookUpPerformance(event.organizationId, event.dtcmPerformanceCode, eventId);
      return NextResponse.json({ ...base, det });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "dtcm-eticket:event-sections-get-failed" });
    return NextResponse.json({ error: "Failed to load DET sections" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([params, auth(), req.json().catch(() => null)]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!session.user.organizationId) return noOrganisation(eventId, session.user.id, "PUT");
    const gate = requirePermission(session, "events.settings", { route: "events/[eventId]/dtcm-eticket:PUT", eventId });
    if (!gate.ok) return gate.response;

    // Each save asks DET for the map once; this bounds that.
    const rl = checkRateLimit({ key: `dtcm-eticket-sections:${session.user.id}`, limit: 30, windowMs: 3600_000 });
    if (!rl.allowed) return rateLimited(rl, { route: "events/[eventId]/dtcm-eticket:PUT", eventId, userId: session.user.id });

    const validated = putSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "dtcm-eticket:event-sections-validation-failed", eventId, errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    return await runWithTenantLane(session.user.organizationId, { route: "events:dtcm-eticket:PUT", userId: session.user.id }, async () => {
      const event = await db.event.findFirst({
        where: gate.eventWhere,
        select: { id: true, organizationId: true, requiresDtcmBarcode: true, dtcmPerformanceCode: true, settings: true },
      });
      if (!event) {
        apiLogger.warn({ msg: "dtcm-eticket:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      if (!event.requiresDtcmBarcode || !event.dtcmPerformanceCode) {
        apiLogger.warn({ msg: "dtcm-eticket:event-sections-dtcm-off", eventId, userId: session.user.id });
        return NextResponse.json(
          { error: "Turn on DTCM barcodes and enter the DET performance code first", code: "DTCM_NOT_ENABLED" },
          { status: 400 },
        );
      }

      const entries = Object.entries(validated.data.sections).filter((e): e is [string, DtcmSectionMapping] => e[1] !== null);
      const known = new Set(
        (await db.ticketType.findMany({ where: { eventId, id: { in: entries.map(([id]) => id) } }, select: { id: true } })).map((t) => t.id),
      );
      const foreign = entries.filter(([id]) => !known.has(id)).map(([id]) => id);
      if (foreign.length > 0) {
        apiLogger.warn({ msg: "dtcm-eticket:event-sections-unknown-type", eventId, userId: session.user.id, foreign });
        return NextResponse.json({ error: "A registration type in this mapping is not on this event", code: "UNKNOWN_TICKET_TYPE" }, { status: 400 });
      }

      const det = await lookUpPerformance(event.organizationId, event.dtcmPerformanceCode, eventId);
      if (det.error) {
        return NextResponse.json(
          { error: `Could not check the mapping with DET, so nothing was saved. ${det.error.message}`, code: det.error.code },
          { status: det.error.code === "NOT_CONFIGURED" ? 400 : 502 },
        );
      }

      const problems = entries
        .map(([ticketTypeId, m]) => ({ ticketTypeId, problem: mappingProblem(m, det.performance) }))
        .filter((p): p is { ticketTypeId: string; problem: string } => p.problem !== null);
      if (problems.length > 0) {
        apiLogger.warn({ msg: "dtcm-eticket:event-sections-refused-by-map", eventId, userId: session.user.id, problems });
        return NextResponse.json({ error: problems[0].problem, code: "NOT_ON_DET_MAP", problems }, { status: 400 });
      }

      const next: StoredDtcmEventSettings = {
        sections: Object.fromEntries(entries),
        environment: det.environment,
        performanceCode: event.dtcmPerformanceCode,
        checkedAt: new Date().toISOString(),
      };
      const before = readDtcmEventSettings(event.settings);
      await updateEventSettings(
        eventId,
        (current) => ({ ...current, [DTCM_EVENT_SETTINGS_KEY]: next as unknown as Prisma.JsonObject }),
        { organizationId: event.organizationId },
      );

      apiLogger.info({
        msg: "dtcm-eticket:event-sections-saved",
        eventId,
        userId: session.user.id,
        environment: det.environment,
        mapped: entries.length,
      });
      void db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "UPDATE",
            entityType: "DtcmSections",
            entityId: eventId,
            changes: {
              before: (before.sections ?? {}) as unknown as Prisma.JsonObject,
              after: next.sections as unknown as Prisma.JsonObject,
              environment: det.environment,
              performanceCode: event.dtcmPerformanceCode,
            },
          },
        })
        .catch((err) => apiLogger.error({ err, eventId, msg: "dtcm-eticket:event-sections-audit-failed" }));

      return NextResponse.json({ mapping: next });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "dtcm-eticket:event-sections-save-failed" });
    return NextResponse.json({ error: "Failed to save DET sections" }, { status: 500 });
  }
}
