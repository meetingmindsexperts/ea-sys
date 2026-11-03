/**
 * The DET (Dubai Economy and Tourism) eTicketing API: the ONLY code in EA-SYS
 * that talks to it. A port of the Laravel barcodes app's ETicketClient, with
 * the behaviour verified against UAT on Nov 3, 2026 (docs/DTCM_ETICKET_PLAN.md
 * §10). Throws `DetApiError`; the service layer turns it into values.
 *
 * Rules carried over, because they are about DET rather than either codebase:
 *   - NEVER log a request body or a URL. Bodies carry the client secret and
 *     attendee PII; every URL carries the API key in its query string.
 *   - One OAuth token per (organisation, environment, client id), cached until
 *     five minutes before expiry and dropped on any 401.
 *   - No retries in here. A retried purchase buys a second ticket; deciding
 *     whether a failed step may be repeated is the caller's job.
 */
import { apiLogger } from "@/lib/logger";
import {
  DET_BASE_URLS,
  DET_CODES,
  type DetCredentials,
  type DetCustomer,
  type DetCustomerInput,
  type DetOrderSummary,
  type DetPerformanceSummary,
  type DetStage,
} from "./types";

const REQUEST_TIMEOUT_MS = 30_000;
const SLOW_CALL_MS = 2_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class DetApiError extends Error {
  constructor(
    message: string,
    readonly stage: DetStage,
    /** HTTP status, or null when the request never got an answer (timeout, DNS, refused). */
    readonly httpStatus: number | null,
    /** DET's own `code` from the error body ("5001", "4001", ...), when it sent one. */
    readonly detCode: string | null = null,
    /** DET's `reference`, which their support asks for. */
    readonly detReference: string | null = null,
    /** A 2xx whose body was cut off, unreadable, or missing the field that proves the outcome. */
    readonly bodyLost = false,
  ) {
    super(message);
    this.name = "DetApiError";
  }

  /** No answer at all: the request may or may not have reached DET. */
  get isNoResponse(): boolean {
    return this.httpStatus === null;
  }

  /**
   * Whether DET may have done the thing despite this error: no answer, a 5xx
   * (a gateway 502/504, or a 500 after the commit), or a success whose body
   * was lost. A caller that buys or reverses MUST branch on this, never on
   * isNoResponse alone, or a lost answer reads as a clean failure and the
   * retry buys a second ticket (review HIGH 1 and 2, Nov 3 2026).
   */
  get outcomeUnknown(): boolean {
    return this.httpStatus === null || this.httpStatus >= 500 || this.bodyLost;
  }
}

// ── Token cache ────────────────────────────────────────────────────

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Includes when the credentials were saved, so a rotated secret stops riding
 * on the old token in EVERY process (worker, the other blue/green container),
 * not only the one that served the save.
 */
function tokenCacheKey(creds: DetCredentials): string {
  return `${creds.organizationId}:${creds.environment}:${creds.clientId}:${creds.version}`;
}

/** Test seam: forget every cached token. */
export function clearDetTokenCache(): void {
  tokenCache.clear();
}

// ── Transport ──────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function url(creds: DetCredentials, path: string): string {
  return `${DET_BASE_URLS[creds.environment]}${path}?api_key=${encodeURIComponent(creds.apiKey)}`;
}

/** Never let a credential into a message that reaches logs or the browser, even if DET echoes one. */
function redact(creds: DetCredentials, text: string): string {
  return [creds.apiKey, creds.clientSecret].filter((v) => v.length >= 4).reduce((t, v) => t.replaceAll(v, "***"), text);
}

/** DET's error body is `{ code, httpStatusCode, message, reference }`; anything else is kept short. */
function errorFromBody(creds: DetCredentials, stage: DetStage, status: number, text: string): DetApiError {
  let parsed: Json | null = null;
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    // Not JSON: an HTML gateway page ("Developer Inactive"), handled below.
  }
  const detCode = str(parsed?.code);
  const reference = parsed && typeof parsed.reference === "string" ? parsed.reference : null;
  const detMessage =
    parsed && typeof parsed.message === "string" ? parsed.message : text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return new DetApiError(
    redact(creds, `DET ${stage} failed (HTTP ${status}${detCode ? `, code ${detCode}` : ""}): ${detMessage.slice(0, 300) || "no message"}`),
    stage,
    status,
    detCode,
    reference,
  );
}

async function send(
  creds: DetCredentials,
  stage: DetStage,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Json,
  opts: { token?: boolean } = {},
): Promise<{ status: number; data: Json | null }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== false) headers.Authorization = `Bearer ${await getDetAccessToken(creds)}`;

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url(creds, path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
    apiLogger.warn({ msg: "dtcm-eticket:no-response", stage, environment: creds.environment, timedOut });
    throw new DetApiError(
      timedOut ? `DET ${stage} timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : `DET ${stage} could not be reached`,
      stage,
      null,
    );
  }

  const ms = Date.now() - started;
  if (ms > SLOW_CALL_MS) apiLogger.warn({ msg: "dtcm-eticket:slow-call", stage, environment: creds.environment, ms });

  let text: string;
  try {
    text = await res.text();
  } catch {
    // The status arrived but the body did not (timeout or reset mid-body):
    // on a 2xx, DET may well have done it.
    apiLogger.warn({ msg: "dtcm-eticket:body-lost", stage, environment: creds.environment, status: res.status });
    throw new DetApiError(`DET ${stage} answered ${res.status} but the body was lost`, stage, res.status, null, null, res.ok);
  }
  if (!res.ok) {
    if (res.status === 401) tokenCache.delete(tokenCacheKey(creds));
    throw errorFromBody(creds, stage, res.status, text);
  }
  if (text.trim() === "") return { status: res.status, data: null };
  try {
    return { status: res.status, data: JSON.parse(text) as Json };
  } catch {
    throw new DetApiError(`DET ${stage} answered ${res.status} with a body that is not JSON`, stage, res.status, null, null, true);
  }
}

function requireString(stage: DetStage, data: Json | null, field: string): string {
  const value = data?.[field];
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number") return String(value);
  // A success without the field that proves the outcome is not a clean failure.
  throw new DetApiError(`DET ${stage} answered without ${field}`, stage, 200, null, null, true);
}

// ── Calls ──────────────────────────────────────────────────────────

/** OAuth2 client-credentials token, shared across calls until shortly before expiry. */
export async function getDetAccessToken(creds: DetCredentials): Promise<string> {
  const key = tokenCacheKey(creds);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const { data } = await send(
    creds,
    "token",
    "POST",
    "/adfs/oauth2/token",
    {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      scope: "profile",
      grant_type: "client_credentials",
      resource: DET_BASE_URLS[creds.environment],
    },
    { token: false },
  );
  const token = requireString("token", data, "access_token");
  const expiresInMs = (typeof data?.expires_in === "number" ? data.expires_in : 3600) * 1000;
  tokenCache.set(key, { token, expiresAt: Date.now() + Math.max(expiresInMs - TOKEN_REFRESH_BUFFER_MS, 60_000) });
  return token;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
function str(v: unknown): string | null {
  if (typeof v === "number") return String(v);
  return typeof v === "string" && v !== "" ? v : null;
}
const list = (v: unknown): Json[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Json[]) : []);

/** The performance's sections, capacities and price types. Section capacity is the real budget; see §10. */
export async function getDetPerformance(creds: DetCredentials, performanceCode: string): Promise<DetPerformanceSummary> {
  const { data } = await send(creds, "performanceMap", "GET", `/performances/${encodeURIComponent(performanceCode)}/map`);
  const typeNames = new Map(list(data?.priceTypes).map((t) => [str(t.priceTypeCode ?? t.code), str(t.priceTypeName ?? t.name)]));
  return {
    performanceCode: str(data?.performanceCode) ?? performanceCode,
    name: str(data?.name) ?? performanceCode,
    startDate: str(data?.startDate),
    endDate: str(data?.endDate),
    venueCode: str(data?.venueCode),
    sections: list(data?.sections).map((s) => ({
      code: str(s.code) ?? "",
      name: str(s.name) ?? "",
      categoryId: num(s.categoryId),
      capacity: num(s.capacity),
      holds: num(s.holds),
    })),
    priceTypes: list(data?.ticketPrices).map((p) => ({
      code: str(p.typeCode) ?? "",
      name: typeNames.get(str(p.typeCode)) ?? null,
      categoryId: num(p.categoryId),
      price: num(p.price),
    })),
  };
}

/** Holds one seat in a section. Returns the basket id. A `5005` means the section cannot sell. */
export async function createDetBasket(
  creds: DetCredentials,
  offer: { performanceCode: string; area: string; priceTypeCode: string },
): Promise<string> {
  const { data } = await send(creds, "createBasket", "POST", "/baskets", {
    Channel: "API",
    Seller: creds.clientId,
    Performancecode: offer.performanceCode,
    Area: offer.area,
    autoReduce: false,
    holdcode: "",
    Demand: [
      {
        PriceTypeCode: offer.priceTypeCode,
        Quantity: 1,
        Admits: 1,
        offerCode: "",
        qualifierCode: "",
        entitlement: "",
        Customer: [],
      },
    ],
  });
  return requireString("createBasket", data, "id");
}

/**
 * Whether a basket still exists. After a purchase DET answers `5001 Basket is
 * not found` (UAT, Nov 3 2026), so after a purchase that got no answer:
 * still there = not bought, safe to delete and retry; gone = most likely bought.
 */
export async function detBasketExists(creds: DetCredentials, basketId: string): Promise<boolean> {
  try {
    await send(creds, "getBasket", "GET", `/baskets/${encodeURIComponent(basketId)}`);
    return true;
  } catch (err) {
    if (err instanceof DetApiError && err.detCode === DET_CODES.BASKET_NOT_FOUND) return false;
    throw err;
  }
}

/** Releases an unpurchased basket's seat. */
export async function deleteDetBasket(creds: DetCredentials, basketId: string): Promise<void> {
  await send(creds, "deleteBasket", "DELETE", `/baskets/${encodeURIComponent(basketId)}`);
}

export async function createDetCustomer(creds: DetCredentials, customer: DetCustomerInput): Promise<DetCustomer> {
  const { data } = await send(creds, "createCustomer", "POST", "/customers", {
    eventsairid: customer.externalId,
    ...(customer.title ? { title: customer.title } : {}),
    firstname: customer.firstName,
    lastname: customer.lastName,
    email: customer.email,
    nationality: customer.nationality,
    phonenumber: customer.phoneNumber,
    countrycode: customer.countryCode,
  });
  return {
    id: requireString("createCustomer", data, "id"),
    account: String(data?.account ?? ""),
    aFile: String(data?.aFile ?? ""),
  };
}

/** Buys the basket. Returns the order id. The one call whose lost answer is ambiguous. */
export async function purchaseDetBasket(
  creds: DetCredentials,
  basketId: string,
  customer: DetCustomer,
  amount: number,
): Promise<string> {
  const { data } = await send(creds, "purchaseBasket", "POST", `/baskets/${encodeURIComponent(basketId)}/purchase`, {
    Seller: creds.clientId,
    customer: { ID: customer.id, Account: customer.account, AFile: customer.aFile },
    Payments: [{ Amount: amount, MeansOfPayment: "EXTERNAL" }],
  });
  return requireString("purchaseBasket", data, "orderId");
}

/** The order and its barcode, or null when DET has no such order (`4001`: never existed or reversed). */
export async function getDetOrder(creds: DetCredentials, orderId: string): Promise<DetOrderSummary | null> {
  let data: Json | null;
  try {
    ({ data } = await send(creds, "getOrder", "GET", `/orders/${encodeURIComponent(orderId)}`));
  } catch (err) {
    if (err instanceof DetApiError && err.detCode === DET_CODES.ORDER_NOT_FOUND) return null;
    throw err;
  }
  const item = list(list(data?.orderLines)[0]?.orderLineItems)[0];
  const seat = item?.seat && typeof item.seat === "object" ? (item.seat as Json) : null;
  const customer = item?.customer && typeof item.customer === "object" ? (item.customer as Json) : null;
  return {
    orderId: str(data?.id) ?? orderId,
    barcode: str(item?.barcode),
    lineItemId: str(item?.id),
    section: str(seat?.section),
    priceTypeCode: str(item?.priceTypeCode),
    priceTypeName: str(item?.priceTypeName),
    customerId: str(customer?.id),
  };
}

/**
 * Reverses (refunds) an order, releasing its seat. The refund amount mirrors
 * the purchase amount. Answers "not-found" on `4001`, which UAT returns for a
 * second reverse, but DET returns the same for an order it never had, e.g.
 * one looked up in the wrong environment. So "not-found" is NOT proof of a
 * reversal: the caller passes the order's own environment explicitly (never
 * the org's active one) and decides what the answer means.
 */
export async function reverseDetOrder(
  creds: DetCredentials,
  orderId: string,
  amount: number,
): Promise<"reversed" | "not-found"> {
  try {
    await send(creds, "reverseOrder", "POST", `/orders/${encodeURIComponent(orderId)}/reverse`, {
      Seller: creds.clientId,
      refunds: [{ Amount: String(amount), MeansOfPayment: "EXTERNAL" }],
    });
    return "reversed";
  } catch (err) {
    if (err instanceof DetApiError && err.detCode === DET_CODES.ORDER_NOT_FOUND) return "not-found";
    throw err;
  }
}
