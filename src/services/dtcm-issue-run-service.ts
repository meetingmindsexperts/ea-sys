/**
 * Bulk DET runs: "Generate DTCM codes" for every eligible registration on an
 * event (docs/DTCM_ETICKET_PLAN.md §5.3, step 4). Errors as values.
 *
 * Every purchase goes through `buyForRegistration()` in
 * dtcm-eticket-service.ts, the same function the desk uses, and eligibility is
 * `dtcmEligibility()`, the same rule the desk uses. This file only decides
 * WHO is next and WHEN to stop.
 *
 * WHEN A RUN STOPS (status STOPPED, `stopReason`, for a person to read):
 *   - an UNCERTAIN purchase: DET lost an answer, and buying on while that is
 *     unexplained could compound it;
 *   - DET unreachable, credentials missing, the mapping no longer current, or
 *     the environment / performance code changed since the run was confirmed;
 *   - five definite DET refusals in a row that were not "section sold out".
 * A section DET refuses as sold out (5005) is added to `soldOutAreas` and its
 * remaining registrations are skipped; the rest of the run carries on.
 *
 * No automatic retry anywhere: a person starts a new run, which only picks up
 * registrations that still have no code.
 */
import { Prisma, type DtcmIssueRun } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { dtcmEligibility, type IneligibleReason } from "@/lib/dtcm-eticket/eligibility";
import { readDtcmEventSettings, sectionHeadroom } from "@/lib/dtcm-eticket/sections";
import type { DetEnvironment } from "@/lib/dtcm-eticket/types";
import { buyForRegistration, loadDtcmPurchaseContext, type DtcmPurchaseContext } from "@/services/dtcm-eticket-service";

const RUN_REGISTRATION_SELECT = {
  id: true,
  status: true,
  attendanceMode: true,
  dtcmBarcode: true,
  ticketTypeId: true,
  createdAt: true,
  attendee: { select: { title: true, firstName: true, lastName: true, email: true, phone: true, country: true } },
} satisfies Prisma.RegistrationSelect;

type RunRegistration = Prisma.RegistrationGetPayload<{ select: typeof RUN_REGISTRATION_SELECT }>;

/** Reasons that mean "this person needs nothing", not "this person has a problem". */
const NOT_NEEDED: ReadonlySet<IneligibleReason> = new Set(["CANCELLED", "VIRTUAL", "ALREADY_HAS_CODE"]);

/** Consecutive non-sold-out refusals after which DET is treated as unwell. */
const MAX_CONSECUTIVE_REFUSALS = 5;

// ── Preflight ──────────────────────────────────────────────────────

export interface DtcmRunPreflight {
  environment: DetEnvironment;
  performanceCode: string;
  /** Registrations a run would buy for, in the order it would. */
  eligibleIds: string[];
  /** People a run would skip because something must be fixed first. */
  problems: Partial<Record<IneligibleReason | "AWAITING_RESOLUTION", number>>;
  notNeeded: number;
  sections: { area: string; name: string; needed: number; headroom: number | null; over: boolean }[];
  /** True when any section needs more than DET can hold: the run is refused. */
  overCapacity: boolean;
}

export type PreflightResult =
  | { ok: true; preflight: DtcmRunPreflight; context: DtcmPurchaseContext }
  | { ok: false; code: "NOT_CONFIGURED" | "DTCM_OFF" | "PERFORMANCE_UNAVAILABLE" | "MAPPING_STALE"; message: string };

/** Who a run would buy for now, who it would skip and why, and whether the sections can hold it. Reads DET once. */
export async function dtcmRunPreflight(organizationId: string, eventId: string, userId: string | null): Promise<PreflightResult> {
  const loaded = await loadDtcmPurchaseContext(organizationId, eventId, userId, "worker", null);
  if (!loaded.ok) return loaded;
  const ctx = loaded.context;

  const [registrations, live] = await Promise.all([
    db.registration.findMany({ where: { eventId }, select: RUN_REGISTRATION_SELECT, orderBy: { createdAt: "asc" } }),
    db.dtcmOrder.findMany({ where: { eventId, activeKey: { not: null } }, select: { registrationId: true } }),
  ]);
  const withLiveOrder = new Set(live.map((o) => o.registrationId));

  const eligibleIds: string[] = [];
  const problems: DtcmRunPreflight["problems"] = {};
  const neededByArea = new Map<string, number>();
  let notNeeded = 0;
  for (const r of registrations) {
    const e = dtcmEligibility(ctx.event, r, ctx.creds.environment);
    if (!e.ok && e.reason === "MAPPING_STALE") {
      return { ok: false, code: "MAPPING_STALE", message: e.message };
    }
    if (!e.ok && NOT_NEEDED.has(e.reason)) {
      notNeeded++;
      continue;
    }
    if (!e.ok) {
      problems[e.reason] = (problems[e.reason] ?? 0) + 1;
      continue;
    }
    // An earlier attempt still live (UNCERTAIN, or bought with the code since
    // removed): a run would stop at the insert, so it is a problem to resolve.
    if (withLiveOrder.has(r.id)) {
      problems.AWAITING_RESOLUTION = (problems.AWAITING_RESOLUTION ?? 0) + 1;
      continue;
    }
    eligibleIds.push(r.id);
    neededByArea.set(e.mapping.area, (neededByArea.get(e.mapping.area) ?? 0) + 1);
  }

  const sections = [...neededByArea.entries()].map(([area, needed]) => {
    const s = ctx.performance.sections.find((x) => x.code === area);
    const headroom = s ? sectionHeadroom(s) : null;
    return { area, name: s?.name ?? area, needed, headroom, over: headroom !== null && needed > headroom };
  });

  return {
    ok: true,
    context: ctx,
    preflight: {
      environment: ctx.creds.environment,
      performanceCode: ctx.event.dtcmPerformanceCode ?? "",
      eligibleIds,
      problems,
      notNeeded,
      sections,
      overCapacity: sections.some((s) => s.over),
    },
  };
}

// ── Start / cancel ─────────────────────────────────────────────────

export type StartDtcmRunErrorCode =
  | "NOT_CONFIGURED"
  | "DTCM_OFF"
  | "PERFORMANCE_UNAVAILABLE"
  | "MAPPING_STALE"
  | "NOTHING_TO_BUY"
  | "OVER_CAPACITY"
  | "CONFIRMATION_STALE"
  | "RUN_ACTIVE";

export type StartDtcmRunResult = { ok: true; run: DtcmIssueRun } | { ok: false; code: StartDtcmRunErrorCode; message: string };

/**
 * Starts a run, but only for what the organiser was shown: the confirmation
 * names the environment and the count, and a mismatch (someone switched to
 * production, or fifty people registered since the dialog opened) refuses
 * rather than buys something nobody confirmed.
 */
export async function startDtcmRun(input: {
  organizationId: string;
  eventId: string;
  userId: string;
  confirm: { environment: DetEnvironment; count: number };
}): Promise<StartDtcmRunResult> {
  const log = { eventId: input.eventId, userId: input.userId };
  const pre = await dtcmRunPreflight(input.organizationId, input.eventId, input.userId);
  if (!pre.ok) {
    apiLogger.warn({ msg: "dtcm-run:start-refused", code: pre.code, ...log });
    return pre;
  }
  const p = pre.preflight;
  const refuse = (code: StartDtcmRunErrorCode, message: string): StartDtcmRunResult => {
    apiLogger.warn({ msg: "dtcm-run:start-refused", code, ...log, eligible: p.eligibleIds.length, environment: p.environment });
    return { ok: false, code, message };
  };
  if (p.eligibleIds.length === 0) return refuse("NOTHING_TO_BUY", "No registration needs a DTCM code from DET right now");
  if (p.overCapacity) {
    const over = p.sections.filter((s) => s.over).map((s) => `${s.area} needs ${s.needed}, DET has ${s.headroom}`);
    return refuse("OVER_CAPACITY", `More registrations than DET seats: ${over.join("; ")}. Change the DET sections or ask DET for more seats.`);
  }
  if (input.confirm.environment !== p.environment || input.confirm.count !== p.eligibleIds.length) {
    return refuse(
      "CONFIRMATION_STALE",
      `This would now buy ${p.eligibleIds.length} ${p.environment} tickets, not ${input.confirm.count} ${input.confirm.environment}. Check again and confirm.`,
    );
  }

  try {
    const run = await db.dtcmIssueRun.create({
      data: {
        eventId: input.eventId,
        organizationId: input.organizationId,
        environment: p.environment,
        performanceCode: p.performanceCode,
        status: "RUNNING",
        activeKey: input.eventId,
        expected: p.eligibleIds.length,
        createdById: input.userId,
      },
    });
    apiLogger.info({ msg: "dtcm-run:started", ...log, runId: run.id, expected: run.expected, environment: run.environment });
    void db.auditLog
      .create({
        data: {
          eventId: input.eventId,
          userId: input.userId,
          action: "DTCM_RUN_STARTED",
          entityType: "DtcmIssueRun",
          entityId: run.id,
          changes: { expected: run.expected, environment: run.environment, performanceCode: run.performanceCode },
        },
      })
      .catch((err) => apiLogger.error({ err, runId: run.id, msg: "dtcm-run:audit-failed" }));
    return { ok: true, run };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return refuse("RUN_ACTIVE", "A DTCM run is already working on this event");
    }
    throw err;
  }
}

export async function cancelDtcmRun(input: { eventId: string; runId: string; userId: string }): Promise<{ ok: boolean }> {
  const res = await db.dtcmIssueRun.updateMany({
    where: { id: input.runId, eventId: input.eventId, status: "RUNNING" },
    data: { status: "CANCELLED", activeKey: null, finishedAt: new Date(), stopReason: "Cancelled by an organiser" },
  });
  if (res.count === 0) {
    apiLogger.warn({ msg: "dtcm-run:cancel-not-running", ...input });
    return { ok: false };
  }
  apiLogger.info({ msg: "dtcm-run:cancelled", ...input });
  return { ok: true };
}

/** The run's progress, counted from its orders (the run stores no counters). */
export async function dtcmRunProgress(runId: string) {
  const counts = await db.dtcmOrder.groupBy({ by: ["status"], where: { runId }, _count: { _all: true } });
  const by = Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<Record<string, number>>;
  return {
    purchased: by.PURCHASED ?? 0,
    failed: by.FAILED ?? 0,
    uncertain: by.UNCERTAIN ?? 0,
    inFlight: by.PENDING ?? 0,
  };
}

// ── The worker's tick ──────────────────────────────────────────────

async function stopRun(runId: string, reason: string) {
  await db.dtcmIssueRun.updateMany({
    where: { id: runId, status: "RUNNING" },
    data: { status: "STOPPED", activeKey: null, finishedAt: new Date(), stopReason: reason.slice(0, 1000) },
  });
  apiLogger.warn({ msg: "dtcm-run:stopped", runId, reason });
}

/**
 * Works one run for up to `budgetMs`, one registration at a time. Called by
 * the worker inside the run's own tenant lane. Re-reads the run's status
 * before every purchase, so a Cancel takes effect at the next person.
 */
export async function tickDtcmRun(runId: string, budgetMs: number, pauseMs = 250): Promise<void> {
  const deadline = Date.now() + budgetMs;
  const run = await db.dtcmIssueRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== "RUNNING" || !run.organizationId) return;
  await db.dtcmIssueRun.update({ where: { id: runId }, data: { lastTickAt: new Date() } });

  const loaded = await loadDtcmPurchaseContext(run.organizationId, run.eventId, run.createdById, "worker", run.id);
  if (!loaded.ok) return stopRun(run.id, loaded.message);
  const ctx = loaded.context;
  if (ctx.creds.environment !== run.environment || ctx.event.dtcmPerformanceCode !== run.performanceCode) {
    return stopRun(
      run.id,
      `The run was confirmed for ${run.environment} / ${run.performanceCode}, but the event now uses ${ctx.creds.environment} / ${ctx.event.dtcmPerformanceCode}. Start a new run.`,
    );
  }

  const soldOut = new Set(run.soldOutAreas);
  const mappedTypes = Object.keys(readDtcmEventSettings(ctx.event.settings).sections ?? {});
  let refusalsInARow = 0;
  for (const registration of await nextCandidates(run.id, run.eventId, mappedTypes)) {
    if (Date.now() > deadline) return;
    const current = await db.dtcmIssueRun.findUnique({ where: { id: run.id }, select: { status: true } });
    if (current?.status !== "RUNNING") return;

    const e = dtcmEligibility(ctx.event, registration, ctx.creds.environment);
    if (!e.ok) continue; // someone fixed or coded meanwhile; the next tick re-reads
    if (soldOut.has(e.mapping.area)) continue;

    const result = await buyForRegistration(ctx, registration);
    if (result.ok) {
      refusalsInARow = 0;
    } else if (result.code === "UNCERTAIN") {
      return stopRun(run.id, `DET lost the answer to a purchase (${registration.id}). Resolve it on the registration before starting again.`);
    } else if (result.code === "MAPPING_STALE" || result.code === "DTCM_OFF" || result.code === "NOT_ON_DET_MAP") {
      return stopRun(run.id, result.message);
    } else if (result.code === "DET_REFUSED" && /code 5005/.test(result.order?.errorMessage ?? "")) {
      soldOut.add(e.mapping.area);
      await db.dtcmIssueRun.update({ where: { id: run.id }, data: { soldOutAreas: [...soldOut] } });
      apiLogger.warn({ msg: "dtcm-run:section-sold-out", runId: run.id, area: e.mapping.area });
    } else if (result.code === "DET_REFUSED") {
      refusalsInARow++;
      if (refusalsInARow >= MAX_CONSECUTIVE_REFUSALS) {
        return stopRun(run.id, `DET refused ${refusalsInARow} purchases in a row. Last: ${result.message}`);
      }
    }
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }

  // A full pass inside the budget means everyone left was either tried by
  // this run (and now carries its order, so the query drops them) or cannot be
  // bought for (no phone, sold-out section): nobody remains to buy for. A
  // later fix (a phone added) is picked up by starting a new run, which the
  // preflight shows.
  await db.dtcmIssueRun.updateMany({
    where: { id: run.id, status: "RUNNING" },
    data: { status: "COMPLETED", activeKey: null, finishedAt: new Date() },
  });
  apiLogger.info({ msg: "dtcm-run:completed", runId: run.id, ...(await dtcmRunProgress(run.id)) });
}

/**
 * Registrations on a mapped type that this run has not tried yet, with no
 * code and no live order. Eligibility proper (phone, country, mapping
 * current...) is checked per person by the caller, with the desk's rule.
 */
function nextCandidates(runId: string, eventId: string, mappedTypeIds: string[]): Promise<RunRegistration[]> {
  // No `take`: a page could fill with people who can never be bought for (no
  // phone), and those behind them would never be reached. Event-sized, and the
  // select is small.
  return db.registration.findMany({
    where: {
      eventId,
      ticketTypeId: { in: mappedTypeIds },
      dtcmBarcode: null,
      status: { in: ["PENDING", "CONFIRMED", "CHECKED_IN"] },
      attendanceMode: "IN_PERSON",
      dtcmOrders: { none: { OR: [{ runId }, { activeKey: { not: null } }] } },
    },
    select: RUN_REGISTRATION_SELECT,
    orderBy: { createdAt: "asc" },
  });
}
