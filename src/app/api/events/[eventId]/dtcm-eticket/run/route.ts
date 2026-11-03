import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { INELIGIBLE_MESSAGES } from "@/lib/dtcm-eticket/eligibility";
import {
  cancelDtcmRun,
  dtcmRunPreflight,
  dtcmRunProgress,
  startDtcmRun,
  type StartDtcmRunErrorCode,
} from "@/services/dtcm-issue-run-service";

/**
 * The bulk "Generate DTCM codes" run for an event (docs/DTCM_ETICKET_PLAN.md
 * §5.3, step 4).
 *
 * GET               — the latest run and its progress (counted from its orders).
 * GET ?preflight=1  — what a run would do now: how many it would buy, in which
 *                     environment, who it would skip and why, and whether the
 *                     DET sections can hold it. Reads DET once.
 * POST              — start, confirming the environment and count the person
 *                     was shown; a mismatch is refused, never bought.
 * DELETE            — cancel the running run (it stops at the next person).
 *
 * `dtcm.import` (ADMIN and ORGANIZER): a bulk purchase against the permit is
 * an organiser decision, like the CSV import it replaces. Organisation
 * members only.
 */
interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const startSchema = z.object({
  confirm: z.object({
    environment: z.enum(["staging", "production"]),
    performanceCode: z.string().trim().min(1).max(100),
    count: z.number().int().min(1).max(100_000),
  }),
});

const START_STATUS: Record<StartDtcmRunErrorCode, number> = {
  NOT_CONFIGURED: 400,
  DTCM_OFF: 400,
  PERFORMANCE_UNAVAILABLE: 502,
  MAPPING_STALE: 400,
  NOTHING_TO_BUY: 400,
  OVER_CAPACITY: 400,
  CONFIRMATION_STALE: 409,
  RUN_ACTIVE: 409,
};

type Gate =
  | { response: NextResponse }
  | { eventId: string; userId: string; organizationId: string; eventWhere: Prisma.EventWhereInput };

async function gate(params: RouteParams["params"], method: "GET" | "POST" | "DELETE"): Promise<Gate> {
  const [{ eventId }, session] = await Promise.all([params, auth()]);
  if (!session?.user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!session.user.organizationId) {
    apiLogger.warn({ msg: "dtcm-run:no-org", eventId, userId: session.user.id, method });
    return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const access = requirePermission(session, "dtcm.import", { route: `events/[eventId]/dtcm-eticket/run:${method}`, eventId });
  if (!access.ok) return { response: access.response };
  return { eventId, userId: session.user.id, organizationId: session.user.organizationId, eventWhere: access.eventWhere };
}

async function latestRun(eventId: string) {
  const run = await db.dtcmIssueRun.findFirst({ where: { eventId }, orderBy: { createdAt: "desc" } });
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    environment: run.environment,
    expected: run.expected,
    soldOutAreas: run.soldOutAreas,
    stopReason: run.stopReason,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lastTickAt: run.lastTickAt,
    progress: await dtcmRunProgress(run.id),
  };
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const g = await gate(params, "GET");
    if ("response" in g) return g.response;
    const wantPreflight = new URL(req.url).searchParams.get("preflight") === "1";

    return await runWithTenantLane(g.organizationId, { route: "events:dtcm-run:GET", userId: g.userId }, async () => {
      const event = await db.event.findFirst({ where: g.eventWhere, select: { id: true } });
      if (!event) {
        apiLogger.warn({ msg: "dtcm-run:event-not-found", eventId: g.eventId, userId: g.userId });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const run = await latestRun(g.eventId);
      if (!wantPreflight) return NextResponse.json({ run, preflight: null });

      const pre = await dtcmRunPreflight(g.organizationId, g.eventId, g.userId);
      if (!pre.ok) {
        apiLogger.warn({ msg: "dtcm-run:preflight-refused", eventId: g.eventId, code: pre.code });
        return NextResponse.json({ run, preflight: null, preflightError: { code: pre.code, message: pre.message } });
      }
      const { eligibleIds, problems, ...rest } = pre.preflight;
      return NextResponse.json({
        run,
        preflight: {
          ...rest,
          eligible: eligibleIds.length,
          problems: Object.entries(problems).map(([reason, count]) => ({
            reason,
            count,
            message:
              reason === "AWAITING_RESOLUTION"
                ? "An earlier DET purchase is still open for them (uncertain, or sold with the code since removed)"
                : INELIGIBLE_MESSAGES[reason as keyof typeof INELIGIBLE_MESSAGES],
          })),
        },
      });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "dtcm-run:get-failed" });
    return NextResponse.json({ error: "Failed to read the DTCM run" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const g = await gate(params, "POST");
    if ("response" in g) return g.response;

    // Starting reads DET's map and can queue hundreds of purchases.
    const limit = checkRateLimit({ key: `dtcm-run-start:${g.eventId}`, limit: 10, windowMs: 3600_000 });
    if (!limit.allowed) return rateLimited(limit, { route: "events/dtcm-eticket/run", eventId: g.eventId, userId: g.userId });

    const parsed = startSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      apiLogger.warn({ msg: "dtcm-run:start-validation-failed", eventId: g.eventId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    return await runWithTenantLane(g.organizationId, { route: "events:dtcm-run:POST", userId: g.userId }, async () => {
      const event = await db.event.findFirst({ where: g.eventWhere, select: { id: true } });
      if (!event) {
        apiLogger.warn({ msg: "dtcm-run:event-not-found", eventId: g.eventId, userId: g.userId });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const result = await startDtcmRun({ organizationId: g.organizationId, eventId: g.eventId, userId: g.userId, confirm: parsed.data.confirm });
      if (!result.ok) return NextResponse.json({ error: result.message, code: result.code }, { status: START_STATUS[result.code] });
      return NextResponse.json({ run: await latestRun(g.eventId) }, { status: 201 });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "dtcm-run:start-failed" });
    return NextResponse.json({ error: "Failed to start the DTCM run" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const g = await gate(params, "DELETE");
    if ("response" in g) return g.response;
    return await runWithTenantLane(g.organizationId, { route: "events:dtcm-run:DELETE", userId: g.userId }, async () => {
      const event = await db.event.findFirst({ where: g.eventWhere, select: { id: true } });
      if (!event) {
        apiLogger.warn({ msg: "dtcm-run:event-not-found", eventId: g.eventId, userId: g.userId });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const running = await db.dtcmIssueRun.findFirst({ where: { eventId: g.eventId, status: "RUNNING" }, select: { id: true } });
      if (!running) {
        apiLogger.warn({ msg: "dtcm-run:cancel-none-running", eventId: g.eventId, userId: g.userId });
        return NextResponse.json({ error: "No DTCM run is working on this event", code: "NOT_RUNNING" }, { status: 409 });
      }
      const out = await cancelDtcmRun({ eventId: g.eventId, runId: running.id, userId: g.userId });
      if (!out.ok) return NextResponse.json({ error: "The run had already stopped", code: "NOT_RUNNING" }, { status: 409 });
      return NextResponse.json({ run: await latestRun(g.eventId) });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "dtcm-run:cancel-failed" });
    return NextResponse.json({ error: "Failed to cancel the DTCM run" }, { status: 500 });
  }
}
