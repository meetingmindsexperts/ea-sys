/**
 * QuickBooks sales-side calls for CRM quotes (Nov 4, 2026): look up the
 * customers, products/services, tax codes and classes a quote maps onto, and
 * create the Estimate. This is the FIRST module that writes to QuickBooks.
 *
 * Reads go through `qboQuery`. A filter built from something a person typed
 * goes through `qboLiteral`, never plain interpolation (QuickBooks' query
 * language has its own quoting).
 *
 * `createEstimate` is the one write. It tells a definite refusal (QuickBooks
 * answered and said no, so nothing was created) from an unknown outcome (the
 * request may have landed), because only the first is safe to report as "not
 * sent". The caller resolves an unknown outcome by looking the Estimate up by
 * its number before trying again, and every create carries a `requestid`,
 * which QuickBooks uses to answer a repeated request with the original result.
 */
import { apiLogger } from "@/lib/logger";
import { QBO_MINOR_VERSION, QBO_TIMEOUT_MS, qboApiBase, type QuickBooksEnvironment } from "./config";
import { getAccessToken } from "./connection";
import { getCompanyInfo, qboQuery, type QboFailure, type QboResult } from "./client";

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function ref(v: unknown): string | null {
  return str((v as { value?: unknown } | undefined)?.value);
}

/**
 * A string as a QuickBooks query literal: backslash and single quote escaped,
 * capped so a pasted essay cannot become a query. `%` stays a wildcard, which
 * in a name search only widens the match.
 */
export function qboLiteral(value: string): string {
  return `'${value.slice(0, 100).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export interface QboCustomer {
  id: string;
  displayName: string;
  /** The customer's currency; with multi-currency off, every customer is in the home currency. */
  currency: string | null;
  email: string | null;
  active: boolean;
}

export interface QboItem {
  id: string;
  name: string;
  type: string | null;
  active: boolean;
}

export interface QboTaxCode {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  /** The sales rate, read from the code's first sales tax rate; null when it has none. */
  rate: number | null;
}

export interface QboClassRef {
  id: string;
  name: string;
}

function toCustomer(row: Record<string, unknown>, homeCurrency: string | null): QboCustomer {
  return {
    id: String(row.Id ?? ""),
    displayName: str(row.DisplayName) ?? "",
    currency: ref(row.CurrencyRef) ?? homeCurrency,
    email: str((row.PrimaryEmailAddr as { Address?: unknown } | undefined)?.Address),
    active: row.Active !== false,
  };
}

/** Active customers whose display name contains `search`, at most 25. */
export async function searchCustomers(organizationId: string, search: string): Promise<QboResult<QboCustomer[]>> {
  const term = search.trim();
  const where = term ? ` WHERE Active = true AND DisplayName LIKE ${qboLiteral(`%${term}%`)}` : " WHERE Active = true";
  const [rows, company] = await Promise.all([
    qboQuery<Record<string, unknown>>(organizationId, `SELECT * FROM Customer${where} ORDERBY DisplayName MAXRESULTS 25`, "Customer"),
    getCompanyInfo(organizationId),
  ]);
  if (!rows.ok) return rows;
  const home = company.ok ? company.data.homeCurrency : null;
  return { ok: true, data: rows.data.map((r) => toCustomer(r, home)) };
}

/** One customer by id, whatever its state, so a send can refuse an inactive or re-currencied one. */
export async function getCustomer(organizationId: string, id: string): Promise<QboResult<QboCustomer | null>> {
  const [rows, company] = await Promise.all([
    qboQuery<Record<string, unknown>>(organizationId, `SELECT * FROM Customer WHERE Id = ${qboLiteral(id)}`, "Customer"),
    getCompanyInfo(organizationId),
  ]);
  if (!rows.ok) return rows;
  const home = company.ok ? company.data.homeCurrency : null;
  return { ok: true, data: rows.data[0] ? toCustomer(rows.data[0], home) : null };
}

const SALEABLE_TYPES = new Set(["Service", "NonInventory", "Inventory"]);

/** Active products/services a sale can post to, whose name contains `search`, at most 50. */
export async function searchItems(organizationId: string, search: string): Promise<QboResult<QboItem[]>> {
  const term = search.trim();
  const where = term ? ` WHERE Active = true AND Name LIKE ${qboLiteral(`%${term}%`)}` : " WHERE Active = true";
  const rows = await qboQuery<Record<string, unknown>>(organizationId, `SELECT * FROM Item${where} ORDERBY Name MAXRESULTS 50`, "Item");
  if (!rows.ok) return rows;
  return {
    ok: true,
    data: rows.data
      .map((r) => ({ id: String(r.Id ?? ""), name: str(r.FullyQualifiedName) ?? str(r.Name) ?? "", type: str(r.Type), active: r.Active !== false }))
      .filter((i) => i.type === null || SALEABLE_TYPES.has(i.type)),
  };
}

/** Products/services by id, so a send can refuse one that was made inactive after it was linked. */
export async function getItems(organizationId: string, ids: string[]): Promise<QboResult<QboItem[]>> {
  if (ids.length === 0) return { ok: true, data: [] };
  const list = ids.map(qboLiteral).join(", ");
  const rows = await qboQuery<Record<string, unknown>>(organizationId, `SELECT * FROM Item WHERE Id IN (${list})`, "Item");
  if (!rows.ok) return rows;
  return {
    ok: true,
    data: rows.data.map((r) => ({ id: String(r.Id ?? ""), name: str(r.FullyQualifiedName) ?? str(r.Name) ?? "", type: str(r.Type), active: r.Active !== false })),
  };
}

/** Every tax code with its sales rate, for the settings picker and the send's rate check. */
export async function listTaxCodes(organizationId: string): Promise<QboResult<QboTaxCode[]>> {
  const [codes, rates] = await Promise.all([
    qboQuery<Record<string, unknown>>(organizationId, "SELECT * FROM TaxCode MAXRESULTS 500", "TaxCode"),
    qboQuery<Record<string, unknown>>(organizationId, "SELECT * FROM TaxRate MAXRESULTS 500", "TaxRate"),
  ]);
  if (!codes.ok) return codes;
  if (!rates.ok) return rates;
  const rateById = new Map(rates.data.map((r) => [String(r.Id ?? ""), typeof r.RateValue === "number" ? r.RateValue : Number(r.RateValue)]));
  return {
    ok: true,
    data: codes.data.map((c) => {
      const detail = (c.SalesTaxRateList as { TaxRateDetail?: { TaxRateRef?: { value?: string } }[] } | undefined)?.TaxRateDetail ?? [];
      const rateId = detail[0]?.TaxRateRef?.value;
      const rate = rateId !== undefined ? rateById.get(rateId) : undefined;
      return {
        id: String(c.Id ?? ""),
        name: str(c.Name) ?? "",
        description: str(c.Description),
        active: c.Active !== false,
        rate: rate !== undefined && Number.isFinite(rate) ? rate : null,
      };
    }),
  };
}

/** The active Class named exactly `name` (an event code), or null. */
export async function findClassByName(organizationId: string, name: string): Promise<QboResult<QboClassRef | null>> {
  const rows = await qboQuery<Record<string, unknown>>(
    organizationId,
    `SELECT * FROM Class WHERE Active = true AND Name = ${qboLiteral(name)}`,
    "Class",
  );
  if (!rows.ok) return rows;
  const row = rows.data[0];
  return { ok: true, data: row ? { id: String(row.Id ?? ""), name: str(row.Name) ?? name } : null };
}

export interface QboEstimateSummary {
  id: string;
  docNumber: string | null;
  privateNote: string | null;
  totalAmt: number | null;
  currency: string | null;
  status: string | null;
}

function toEstimate(row: Record<string, unknown>): QboEstimateSummary {
  const total = typeof row.TotalAmt === "number" ? row.TotalAmt : Number(row.TotalAmt);
  return {
    id: String(row.Id ?? ""),
    docNumber: str(row.DocNumber),
    privateNote: str(row.PrivateNote),
    totalAmt: Number.isFinite(total) ? total : null,
    currency: ref(row.CurrencyRef),
    status: str(row.TxnStatus),
  };
}

/** Estimates carrying `docNumber`: how a send finds one an earlier, lost answer already made. */
export async function findEstimatesByDocNumber(organizationId: string, docNumber: string): Promise<QboResult<QboEstimateSummary[]>> {
  const rows = await qboQuery<Record<string, unknown>>(
    organizationId,
    `SELECT * FROM Estimate WHERE DocNumber = ${qboLiteral(docNumber)}`,
    "Estimate",
  );
  if (!rows.ok) return rows;
  return { ok: true, data: rows.data.map(toEstimate) };
}

export interface EstimateLineInput {
  itemId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  taxCodeId: string;
}

export interface EstimateInput {
  customerId: string;
  docNumber: string;
  txnDate: string;
  expirationDate: string;
  /** Sent only when multi-currency is on; otherwise the company's home currency applies. */
  currency: string | null;
  classId: string | null;
  customerMemo: string | null;
  privateNote: string;
  lines: EstimateLineInput[];
}

/** The Estimate body QuickBooks expects. Pure, so the mapping is testable without a network. */
export function buildEstimateBody(input: EstimateInput): Record<string, unknown> {
  return {
    CustomerRef: { value: input.customerId },
    DocNumber: input.docNumber,
    TxnDate: input.txnDate,
    ExpirationDate: input.expirationDate,
    ...(input.currency ? { CurrencyRef: { value: input.currency } } : {}),
    ...(input.classId ? { ClassRef: { value: input.classId } } : {}),
    ...(input.customerMemo ? { CustomerMemo: { value: input.customerMemo.slice(0, 1000) } } : {}),
    PrivateNote: input.privateNote.slice(0, 4000),
    // Quote prices are VAT-exclusive (computeQuoteTotals adds the tax on top).
    GlobalTaxCalculation: "TaxExcluded",
    Line: input.lines.map((l) => ({
      DetailType: "SalesItemLineDetail",
      Amount: l.amount,
      Description: l.description.slice(0, 4000),
      SalesItemLineDetail: {
        ItemRef: { value: l.itemId },
        Qty: l.quantity,
        UnitPrice: l.unitPrice,
        TaxCodeRef: { value: l.taxCodeId },
        ...(input.classId ? { ClassRef: { value: input.classId } } : {}),
      },
    })),
  };
}

export type CreateEstimateResult =
  | { ok: true; data: QboEstimateSummary; realmId: string; environment: QuickBooksEnvironment }
  | (QboFailure & { outcomeUnknown: boolean });

/**
 * Create one Estimate. `requestId` must be the same on every attempt for the
 * same quote: QuickBooks then returns the first attempt's result instead of a
 * second Estimate.
 *
 * `outcomeUnknown` is true when the request may have been applied: a network
 * error or timeout after sending, a 5xx, or a 2xx we cannot read. A 4xx is a
 * definite refusal.
 */
export async function createEstimate(
  organizationId: string,
  body: Record<string, unknown>,
  requestId: string,
): Promise<CreateEstimateResult> {
  const auth = await getAccessToken(organizationId);
  if (!auth.ok) return { ok: false, code: auth.code, message: auth.message, outcomeUnknown: false };

  const url =
    `${qboApiBase(auth.environment)}/v3/company/${encodeURIComponent(auth.realmId)}/estimate` +
    `?requestid=${encodeURIComponent(requestId)}&minorversion=${QBO_MINOR_VERSION}`;
  const started = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(QBO_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    apiLogger.error({ msg: "quickbooks:estimate-network", organizationId, requestId, err: message });
    return { ok: false, code: "NETWORK", message, outcomeUnknown: true };
  }

  const text = await res.text();
  if (!res.ok) {
    const outcomeUnknown = res.status >= 500;
    apiLogger.error({
      msg: "quickbooks:estimate-refused",
      organizationId,
      requestId,
      status: res.status,
      outcomeUnknown,
      durationMs: Date.now() - started,
      body: text.slice(0, 400),
    });
    return { ok: false, code: "HTTP_ERROR", status: res.status, message: faultMessage(text) ?? `HTTP ${res.status}`, outcomeUnknown };
  }

  try {
    const parsed = JSON.parse(text) as { Estimate?: Record<string, unknown> };
    if (!parsed.Estimate) throw new Error("no Estimate in response");
    const data = toEstimate(parsed.Estimate);
    apiLogger.info({ msg: "quickbooks:estimate-created", organizationId, requestId, estimateId: data.id, durationMs: Date.now() - started });
    return { ok: true, data, realmId: auth.realmId, environment: auth.environment };
  } catch {
    apiLogger.error({ msg: "quickbooks:estimate-unparsable", organizationId, requestId, body: text.slice(0, 200) });
    return { ok: false, code: "MALFORMED", message: "QuickBooks returned a response that is not an Estimate", outcomeUnknown: true };
  }
}

/** The human part of a QuickBooks fault ("Duplicate Document Number Error: ..."), when there is one. */
function faultMessage(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { Fault?: { Error?: { Message?: string; Detail?: string }[] } };
    const first = parsed.Fault?.Error?.[0];
    if (!first) return null;
    return [first.Message, first.Detail].filter(Boolean).join(": ").slice(0, 300) || null;
  } catch {
    return null;
  }
}

/** The connection's realm and environment, so a link can record which QuickBooks company it belongs to. */
export async function currentRealm(organizationId: string): Promise<QboResult<{ realmId: string; environment: QuickBooksEnvironment }>> {
  const auth = await getAccessToken(organizationId);
  if (!auth.ok) return { ok: false, code: auth.code, message: auth.message };
  return { ok: true, data: { realmId: auth.realmId, environment: auth.environment } };
}
