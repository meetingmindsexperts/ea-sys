/**
 * Buying DTCM tickets from DET (docs/DTCM_ETICKET_PLAN.md §5.2, step 3).
 *
 * `issueDtcmTicket()` is the ONE purchase path. The desk calls it for one
 * registration now; the bulk run (step 4) will call `buyForRegistration()`
 * with a context it loads once per run. Errors as values; the caller maps
 * them to HTTP.
 *
 * THE RULES (each is a ticket against a government permit):
 *   1. A `DtcmOrder` row is written BEFORE the first DET call, with
 *      `activeKey` = registration id (unique). A second click, a second desk
 *      station or a re-delivered job stops at that insert.
 *   2. Anything that fails before the purchase call is a definite "not
 *      bought": the basket is released and the row is FAILED (retryable).
 *   3. A purchase error is judged by `DetApiError.outcomeUnknown`, never by
 *      "did it throw". A definite refusal is FAILED. An unknown outcome asks
 *      DET whether the basket still exists: still there means not bought
 *      (release it, FAILED); gone means most likely bought, so the row is
 *      UNCERTAIN, keeps `activeKey`, and waits for a person. Never retried.
 *   4. A purchase that succeeded but whose order cannot be read is PURCHASED
 *      without a barcode; `refreshDtcmOrderBarcode()` reads it again later.
 *   5. Every later call on an order uses the environment stored on the row,
 *      never the organisation's active one.
 */
import { Prisma, type DtcmOrder } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import {
  createDetBasket,
  createDetCustomer,
  DetApiError,
  deleteDetBasket,
  detBasketExists,
  getDetOrder,
  getDetPerformance,
  purchaseDetBasket,
} from "@/lib/dtcm-eticket/client";
import { getDetCredentials } from "@/lib/dtcm-eticket/credentials";
import { dtcmEligibility, type IneligibleReason } from "@/lib/dtcm-eticket/eligibility";
import { mappingProblem } from "@/lib/dtcm-eticket/sections";
import type { DetCredentials, DetEnvironment, DetPerformanceSummary } from "@/lib/dtcm-eticket/types";

export type DtcmSource = "rest" | "worker";

/**
 * A PENDING row older than this was left by a process that died mid-purchase.
 * It may have bought (the crash could follow the sale), so it is resolved like
 * UNCERTAIN, by a person, never retried. A purchase takes seconds; ten
 * minutes is far past any live attempt.
 */
export const STALE_PENDING_MS = 10 * 60 * 1000;

export function isStalePending(order: Pick<DtcmOrder, "status" | "updatedAt">, now = Date.now()): boolean {
  return order.status === "PENDING" && now - order.updatedAt.getTime() > STALE_PENDING_MS;
}

export type IssueDtcmTicketErrorCode =
  | "REGISTRATION_NOT_FOUND"
  | "NOT_CONFIGURED"
  | IneligibleReason
  | "ALREADY_IN_PROGRESS"
  | "PERFORMANCE_UNAVAILABLE"
  | "NOT_ON_DET_MAP"
  /** DET definitely did not sell it. Safe to try again or fall back. */
  | "DET_REFUSED"
  /** DET may have sold it. A person must resolve the order; never retry. */
  | "UNCERTAIN"
  /** Bought, but the order could not be read yet. */
  | "PURCHASED_NO_BARCODE"
  /** Bought, but the registration got a code another way while we were buying. */
  | "CODE_ARRIVED_MEANWHILE";

export type IssueDtcmTicketResult =
  | { ok: true; order: DtcmOrder; barcode: string }
  | { ok: false; code: IssueDtcmTicketErrorCode; message: string; order?: DtcmOrder };

export interface IssueDtcmTicketInput {
  organizationId: string;
  eventId: string;
  registrationId: string;
  userId: string | null;
  source: DtcmSource;
}

/** Everything a purchase needs that does not change per registration. Loaded once per run in step 4. */
export interface DtcmPurchaseContext {
  organizationId: string;
  eventId: string;
  creds: DetCredentials;
  performance: DetPerformanceSummary;
  event: { requiresDtcmBarcode: boolean; dtcmPerformanceCode: string | null; settings: unknown };
  userId: string | null;
  source: DtcmSource;
  runId: string | null;
}

const REGISTRATION_SELECT = {
  id: true,
  status: true,
  attendanceMode: true,
  dtcmBarcode: true,
  ticketTypeId: true,
  attendee: { select: { title: true, firstName: true, lastName: true, email: true, phone: true, country: true } },
} satisfies Prisma.RegistrationSelect;

type PurchaseRegistration = Prisma.RegistrationGetPayload<{ select: typeof REGISTRATION_SELECT }>;

function fail(code: IssueDtcmTicketErrorCode, message: string, log: Record<string, unknown>, order?: DtcmOrder): IssueDtcmTicketResult {
  const level = code === "UNCERTAIN" || code === "CODE_ARRIVED_MEANWHILE" ? "error" : "warn";
  apiLogger[level]({ msg: `dtcm-eticket:issue-${code.toLowerCase()}`, code, ...log });
  return { ok: false, code, message, ...(order && { order }) };
}

/** The desk path: load the context and the registration, then buy. */
export function issueDtcmTicket(input: IssueDtcmTicketInput): Promise<IssueDtcmTicketResult> {
  return runWithTenant(input.organizationId, async () => {
    const ctx = await loadDtcmPurchaseContext(input.organizationId, input.eventId, input.userId, input.source, null);
    if (!ctx.ok) return fail(ctx.code, ctx.message, { eventId: input.eventId, registrationId: input.registrationId });

    const registration = await db.registration.findFirst({
      where: { id: input.registrationId, eventId: input.eventId },
      select: REGISTRATION_SELECT,
    });
    if (!registration) {
      return fail("REGISTRATION_NOT_FOUND", "Registration not found", { eventId: input.eventId, registrationId: input.registrationId });
    }
    return buyForRegistration(ctx.context, registration);
  });
}

export type LoadContextResult =
  | { ok: true; context: DtcmPurchaseContext }
  | { ok: false; code: "NOT_CONFIGURED" | "DTCM_OFF" | "PERFORMANCE_UNAVAILABLE"; message: string };

/** Credentials (the ACTIVE environment: this starts new work) and the live performance map, once. */
export async function loadDtcmPurchaseContext(
  organizationId: string,
  eventId: string,
  userId: string | null,
  source: DtcmSource,
  runId: string | null,
): Promise<LoadContextResult> {
  const event = await db.event.findFirst({
    where: { id: eventId, organizationId },
    select: { requiresDtcmBarcode: true, dtcmPerformanceCode: true, settings: true },
  });
  if (!event?.requiresDtcmBarcode || !event.dtcmPerformanceCode) {
    return { ok: false, code: "DTCM_OFF", message: "DTCM barcodes are not on for this event, or it has no DET performance code" };
  }
  const creds = await getDetCredentials(organizationId);
  if (!creds) {
    return { ok: false, code: "NOT_CONFIGURED", message: "DET credentials are not set up (Settings, Integrations)" };
  }
  try {
    const performance = await getDetPerformance(creds, event.dtcmPerformanceCode);
    return { ok: true, context: { organizationId, eventId, creds, performance, event, userId, source, runId } };
  } catch (err) {
    if (!(err instanceof DetApiError)) throw err;
    apiLogger.warn({ msg: "dtcm-eticket:issue-map-unavailable", eventId, stage: err.stage, httpStatus: err.httpStatus, detCode: err.detCode });
    return { ok: false, code: "PERFORMANCE_UNAVAILABLE", message: `Could not read the performance from DET: ${err.message}` };
  }
}

/** One purchase, under the rules in the header. Callers have checked access; this checks everything else. */
export async function buyForRegistration(ctx: DtcmPurchaseContext, registration: PurchaseRegistration): Promise<IssueDtcmTicketResult> {
  const log = { eventId: ctx.eventId, registrationId: registration.id, environment: ctx.creds.environment, source: ctx.source };

  const eligibility = dtcmEligibility(ctx.event, registration, ctx.creds.environment);
  if (!eligibility.ok) return fail(eligibility.reason, eligibility.message, log);
  const { mapping, customer, performanceCode } = eligibility;

  const problem = mappingProblem(mapping, ctx.performance);
  if (problem) return fail("NOT_ON_DET_MAP", `${problem}. Check the DET sections (Settings, Registration).`, log);
  const section = ctx.performance.sections.find((s) => s.code === mapping.area);
  const price = ctx.performance.priceTypes.find((p) => p.code === mapping.priceTypeCode && p.categoryId === section?.categoryId)?.price ?? 0;

  // Rule 1: the intent row, before any DET call.
  let order: DtcmOrder;
  try {
    order = await db.dtcmOrder.create({
      data: {
        eventId: ctx.eventId,
        organizationId: ctx.organizationId,
        registrationId: registration.id,
        environment: ctx.creds.environment,
        status: "PENDING",
        activeKey: registration.id,
        performanceCode,
        area: mapping.area,
        priceTypeCode: mapping.priceTypeCode,
        amount: new Prisma.Decimal(price),
        runId: ctx.runId,
        createdById: ctx.userId,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const live = await db.dtcmOrder.findUnique({ where: { activeKey: registration.id } });
      return fail(
        "ALREADY_IN_PROGRESS",
        live && (live.status === "UNCERTAIN" || isStalePending(live))
          ? "An earlier DET purchase for this registration may have gone through. Resolve it before buying again."
          : "A DET purchase for this registration is already in progress",
        { ...log, liveOrderId: live?.id, liveStatus: live?.status },
        live ?? undefined,
      );
    }
    throw err;
  }
  const orderLog = { ...log, dtcmOrderId: order.id };

  // Rule 2: before the purchase call, every failure is a definite "not bought".
  let basketId: string | null = null;
  let purchased: string;
  try {
    basketId = await createDetBasket(ctx.creds, { performanceCode, area: mapping.area, priceTypeCode: mapping.priceTypeCode });
    await db.dtcmOrder.update({ where: { id: order.id }, data: { basketId } });
    const detCustomer = await createDetCustomer(ctx.creds, customer);
    await db.dtcmOrder.update({ where: { id: order.id }, data: { detCustomerId: detCustomer.id } });

    try {
      purchased = await purchaseDetBasket(ctx.creds, basketId, detCustomer, price);
    } catch (err) {
      if (!(err instanceof DetApiError)) throw err;
      return await afterPurchaseError(ctx, order.id, basketId, err, orderLog);
    }
  } catch (err) {
    if (!(err instanceof DetApiError)) throw err;
    if (basketId) await releaseBasket(ctx.creds, basketId, orderLog);
    const failed = await markFailed(order.id, err);
    const message = err.detCode === "5005" ? `DET cannot sell in section ${mapping.area}: ${err.message}` : err.message;
    return fail("DET_REFUSED", message, { ...orderLog, stage: err.stage, httpStatus: err.httpStatus, detCode: err.detCode }, failed);
  }

  // Bought. From here nothing may mark the row FAILED: the ticket exists.
  // Logged BEFORE the write: if the process dies in between, the DET order
  // number survives in the logs, and the row is a stale PENDING that a person
  // resolves (resolveDtcmOrder accepts those, see STALE_PENDING_MS).
  apiLogger.info({ msg: "dtcm-eticket:issue-purchased", ...orderLog, detOrderId: purchased });
  await db.dtcmOrder.update({ where: { id: order.id }, data: { orderId: purchased, status: "PURCHASED" } });
  return recordBarcode(ctx, order.id, registration.id, purchased, orderLog);
}

/** Rule 3. */
async function afterPurchaseError(
  ctx: DtcmPurchaseContext,
  orderId: string,
  basketId: string,
  err: DetApiError,
  log: Record<string, unknown>,
): Promise<IssueDtcmTicketResult> {
  const errLog = { ...log, stage: err.stage, httpStatus: err.httpStatus, detCode: err.detCode };
  if (!err.outcomeUnknown) {
    await releaseBasket(ctx.creds, basketId, log);
    return fail("DET_REFUSED", err.message, errLog, await markFailed(orderId, err));
  }

  let basketStillThere: boolean | null;
  try {
    basketStillThere = await detBasketExists(ctx.creds, basketId);
  } catch (checkErr) {
    apiLogger.warn({ msg: "dtcm-eticket:issue-basket-check-failed", ...log, err: checkErr instanceof Error ? checkErr.message : String(checkErr) });
    basketStillThere = null;
  }

  if (basketStillThere) {
    await releaseBasket(ctx.creds, basketId, log);
    return fail("DET_REFUSED", `${err.message} (DET still held the basket, so nothing was bought)`, errLog, await markFailed(orderId, err));
  }

  const uncertain = await db.dtcmOrder.update({
    where: { id: orderId },
    data: { status: "UNCERTAIN", errorStage: err.stage, errorStatus: err.httpStatus, errorMessage: err.message.slice(0, 1000) },
  });
  await audit(ctx, uncertain, "DTCM_ORDER_UNCERTAIN");
  return fail(
    "UNCERTAIN",
    "DET may have issued this ticket but the answer was lost. Do not try again: find the order in DET and enter its number on this registration, or mark it as not bought.",
    errLog,
    uncertain,
  );
}

/** Reads the order's barcode and puts it on the registration, if the registration still has none. */
async function recordBarcode(
  ctx: Pick<DtcmPurchaseContext, "creds" | "eventId" | "organizationId" | "userId" | "source">,
  orderRowId: string,
  registrationId: string,
  detOrderId: string,
  log: Record<string, unknown>,
): Promise<IssueDtcmTicketResult> {
  let barcode: string | null = null;
  try {
    barcode = (await getDetOrder(ctx.creds, detOrderId))?.barcode ?? null;
  } catch (err) {
    apiLogger.warn({ msg: "dtcm-eticket:issue-order-read-failed", ...log, err: err instanceof Error ? err.message : String(err) });
  }
  if (!barcode) {
    const row = await db.dtcmOrder.findUniqueOrThrow({ where: { id: orderRowId } });
    return fail("PURCHASED_NO_BARCODE", `DET sold the ticket (order ${detOrderId}) but its barcode could not be read yet. Try "Read barcode again".`, log, row);
  }

  const [row, written] = await db.$transaction([
    db.dtcmOrder.update({ where: { id: orderRowId }, data: { barcode, status: "PURCHASED" } }),
    db.registration.updateMany({ where: { id: registrationId, dtcmBarcode: null }, data: { dtcmBarcode: barcode } }),
  ]);
  await audit(ctx, row, "DTCM_ORDER_PURCHASED");
  if (written.count === 0) {
    return fail(
      "CODE_ARRIVED_MEANWHILE",
      `The registration got a DTCM code another way while DET was selling one (order ${detOrderId}). Reverse the unused DET order.`,
      { ...log, detOrderId },
      row,
    );
  }
  apiLogger.info({ msg: "dtcm-eticket:issue-recorded", ...log, detOrderId });
  return { ok: true, order: row, barcode };
}

async function releaseBasket(creds: DetCredentials, basketId: string, log: Record<string, unknown>) {
  try {
    await deleteDetBasket(creds, basketId);
  } catch (err) {
    // Best effort: an undeleted basket expires on DET's side. Logged so a
    // held seat that will not free up can be traced.
    apiLogger.warn({ msg: "dtcm-eticket:issue-basket-release-failed", ...log, basketId, err: err instanceof Error ? err.message : String(err) });
  }
}

function markFailed(orderId: string, err: DetApiError) {
  return db.dtcmOrder.update({
    where: { id: orderId },
    data: { status: "FAILED", activeKey: null, errorStage: err.stage, errorStatus: err.httpStatus, errorMessage: err.message.slice(0, 1000) },
  });
}

function audit(ctx: { userId: string | null; source: DtcmSource }, order: DtcmOrder, action: string) {
  return db.auditLog
    .create({
      data: {
        eventId: order.eventId,
        userId: ctx.userId,
        action,
        entityType: "Registration",
        entityId: order.registrationId ?? order.id,
        changes: {
          source: ctx.source,
          dtcmOrderId: order.id,
          status: order.status,
          environment: order.environment,
          detOrderId: order.orderId,
          area: order.area,
          priceTypeCode: order.priceTypeCode,
        },
      },
    })
    .catch((err) => apiLogger.error({ err, dtcmOrderId: order.id, msg: "dtcm-eticket:audit-failed" }));
}

// ── Recovery: the organiser's side of UNCERTAIN and PURCHASED-without-barcode ──

export type ResolveDtcmOrderErrorCode =
  | "ORDER_NOT_FOUND"
  | "WRONG_STATUS"
  | "NOT_CONFIGURED"
  | "DET_ORDER_NOT_FOUND"
  | "DET_FAILED"
  | IssueDtcmTicketErrorCode;

export type ResolveDtcmOrderResult =
  | { ok: true; order: DtcmOrder; barcode: string | null }
  | { ok: false; code: ResolveDtcmOrderErrorCode; message: string; order?: DtcmOrder };

export interface ResolveDtcmOrderInput {
  organizationId: string;
  eventId: string;
  dtcmOrderId: string;
  userId: string;
  /**
   * found: the person looked the order up in DET and enters its number.
   * not-bought: DET has no such sale; the attempt becomes FAILED and a new one may start.
   * read-barcode: a PURCHASED order whose barcode was not read yet.
   */
  action: { kind: "found"; detOrderId: string } | { kind: "not-bought" } | { kind: "read-barcode" };
}

export function resolveDtcmOrder(input: ResolveDtcmOrderInput): Promise<ResolveDtcmOrderResult> {
  return runWithTenant(input.organizationId, async () => {
    const log = { eventId: input.eventId, dtcmOrderId: input.dtcmOrderId, userId: input.userId, action: input.action.kind };
    const order = await db.dtcmOrder.findFirst({ where: { id: input.dtcmOrderId, eventId: input.eventId } });
    if (!order) {
      apiLogger.warn({ msg: "dtcm-eticket:resolve-not-found", ...log });
      return { ok: false, code: "ORDER_NOT_FOUND", message: "DET order record not found" };
    }

    const unresolved = order.status === "UNCERTAIN" || isStalePending(order);
    const allowed = input.action.kind === "read-barcode" ? order.status === "PURCHASED" && !order.barcode : unresolved;
    if (!allowed) {
      apiLogger.warn({ msg: "dtcm-eticket:resolve-wrong-status", ...log, status: order.status });
      return { ok: false, code: "WRONG_STATUS", message: `This DET order is ${order.status.toLowerCase()}, so that is not possible`, order };
    }

    const ctx = { userId: input.userId, source: "rest" as const };
    if (input.action.kind === "not-bought") {
      const failed = await db.dtcmOrder.update({
        where: { id: order.id },
        data: { status: "FAILED", activeKey: null, errorMessage: `Marked as not bought by a person after: ${order.errorMessage ?? "no answer"}`.slice(0, 1000) },
      });
      await audit(ctx, failed, "DTCM_ORDER_MARKED_NOT_BOUGHT");
      apiLogger.info({ msg: "dtcm-eticket:resolve-not-bought", ...log });
      return { ok: true, order: failed, barcode: null };
    }

    // Rule 5: the order's own environment.
    const creds = await getDetCredentials(input.organizationId, order.environment as DetEnvironment);
    if (!creds) {
      apiLogger.warn({ msg: "dtcm-eticket:resolve-not-configured", ...log, environment: order.environment });
      return { ok: false, code: "NOT_CONFIGURED", message: `DET ${order.environment} credentials are not set up` };
    }

    const detOrderId = input.action.kind === "found" ? input.action.detOrderId : (order.orderId ?? "");
    if (input.action.kind === "found") {
      // Prove the number is a real order before trusting it.
      try {
        if (!(await getDetOrder(creds, detOrderId))) {
          apiLogger.warn({ msg: "dtcm-eticket:resolve-det-order-missing", ...log, detOrderId });
          return { ok: false, code: "DET_ORDER_NOT_FOUND", message: `DET has no order ${detOrderId} in ${order.environment}`, order };
        }
      } catch (err) {
        if (!(err instanceof DetApiError)) throw err;
        apiLogger.warn({ msg: "dtcm-eticket:resolve-det-failed", ...log, stage: err.stage, httpStatus: err.httpStatus });
        return { ok: false, code: "DET_FAILED", message: err.message, order };
      }
      await db.dtcmOrder.update({ where: { id: order.id }, data: { orderId: detOrderId, status: "PURCHASED" } });
    }

    if (!order.registrationId) {
      const row = await db.dtcmOrder.findUniqueOrThrow({ where: { id: order.id } });
      return { ok: true, order: row, barcode: row.barcode };
    }
    const recorded = await recordBarcode(
      { creds, eventId: input.eventId, organizationId: input.organizationId, ...ctx },
      order.id,
      order.registrationId,
      detOrderId,
      log,
    );
    return recorded.ok ? { ok: true, order: recorded.order, barcode: recorded.barcode } : recorded;
  });
}
