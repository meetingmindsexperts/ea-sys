/**
 * Reads from QuickBooks Online (September 22, 2026). This slice only ever
 * READS: the company, its Classes (an event code is a Class, spec §8) and
 * its chart of accounts. Writing purchase orders is Phase 3 and goes
 * through the outbox, never straight from a request.
 *
 * Every call goes through `qboQuery`, so the realm binding, the token, the
 * timeout and the error shape are decided once. Errors are values, never
 * throws, because every caller is a route or a worker tick that has to
 * report rather than crash.
 */
import { apiLogger } from "@/lib/logger";
import { QBO_MINOR_VERSION, QBO_TIMEOUT_MS, qboApiBase } from "./config";
import { getAccessToken, saveConnection } from "./connection";

export type QboFailure = {
  ok: false;
  code: "NOT_CONFIGURED" | "NOT_CONNECTED" | "ENVIRONMENT_MISMATCH" | "APP_CHANGED" | "REFRESH_EXPIRED" | "REFRESH_FAILED" | "HTTP_ERROR" | "NETWORK" | "MALFORMED";
  message: string;
  status?: number;
};
export type QboResult<T> = { ok: true; data: T } | QboFailure;

/** One row of the chart of accounts, trimmed to what a screen shows. */
export interface QboAccount {
  id: string;
  name: string;
  acctNum: string | null;
  accountType: string | null;
  accountSubType: string | null;
  classification: string | null;
  active: boolean;
  fullyQualifiedName: string | null;
}

/** A QuickBooks Class. The event code is the Class, so this is the list a budget maps onto. */
export interface QboClass {
  id: string;
  name: string;
  fullyQualifiedName: string | null;
  active: boolean;
}

export interface QboCompany {
  companyName: string | null;
  legalName: string | null;
  country: string | null;
  homeCurrency: string | null;
  multiCurrencyEnabled: boolean | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Run one QuickBooks query. `sql` is QuickBooks' own query language, built
 * here from literals only: nothing user-typed reaches it in this slice, and
 * a future caller that needs a filter should add a typed parameter rather
 * than interpolate.
 */
export async function qboQuery<T = Record<string, unknown>>(
  organizationId: string,
  sql: string,
  entity: string,
): Promise<QboResult<T[]>> {
  const auth = await getAccessToken(organizationId);
  if (!auth.ok) return { ok: false, code: auth.code, message: auth.message };

  const url = `${qboApiBase(auth.environment)}/v3/company/${encodeURIComponent(auth.realmId)}/query?query=${encodeURIComponent(sql)}&minorversion=${QBO_MINOR_VERSION}`;

  let res: Response;
  const started = Date.now();
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(QBO_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    apiLogger.error({ msg: "quickbooks:query-network", organizationId, entity, err: message });
    return { ok: false, code: "NETWORK", message };
  }

  const text = await res.text();
  if (!res.ok) {
    apiLogger.error({
      msg: "quickbooks:query-failed",
      organizationId,
      entity,
      status: res.status,
      durationMs: Date.now() - started,
      body: text.slice(0, 400),
    });
    return { ok: false, code: "HTTP_ERROR", status: res.status, message: text.slice(0, 200) || `HTTP ${res.status}` };
  }

  try {
    const parsed = JSON.parse(text) as { QueryResponse?: Record<string, unknown> };
    const rows = parsed.QueryResponse?.[entity];
    apiLogger.info({ msg: "quickbooks:query", organizationId, entity, rows: Array.isArray(rows) ? rows.length : 0, durationMs: Date.now() - started });
    // An empty result set omits the key entirely rather than sending [].
    return { ok: true, data: Array.isArray(rows) ? (rows as T[]) : [] };
  } catch {
    apiLogger.error({ msg: "quickbooks:query-unparsable", organizationId, entity, body: text.slice(0, 200) });
    return { ok: false, code: "MALFORMED", message: "QuickBooks returned a response that is not JSON" };
  }
}

export async function getCompanyInfo(organizationId: string): Promise<QboResult<QboCompany>> {
  const res = await qboQuery<Record<string, unknown>>(organizationId, "SELECT * FROM CompanyInfo", "CompanyInfo");
  if (!res.ok) return res;
  const row = res.data[0] ?? {};
  const prefs = (row.NameValue as { Name?: string; Value?: string }[] | undefined) ?? [];
  const multiCurrency = prefs.find((p) => p?.Name === "MultiCurrencyEnabled")?.Value;
  return {
    ok: true,
    data: {
      companyName: str(row.CompanyName),
      legalName: str(row.LegalName),
      country: str(row.Country),
      homeCurrency: str((row.HomeCurrencyRef as { value?: string } | undefined)?.value),
      multiCurrencyEnabled: multiCurrency === undefined ? null : multiCurrency === "true",
    },
  };
}

export async function listClasses(organizationId: string): Promise<QboResult<QboClass[]>> {
  const res = await qboQuery<Record<string, unknown>>(organizationId, "SELECT * FROM Class MAXRESULTS 1000", "Class");
  if (!res.ok) return res;
  return {
    ok: true,
    data: res.data.map((c) => ({
      id: String(c.Id ?? ""),
      name: str(c.Name) ?? "",
      fullyQualifiedName: str(c.FullyQualifiedName),
      active: c.Active !== false,
    })),
  };
}

export async function listAccounts(organizationId: string): Promise<QboResult<QboAccount[]>> {
  const res = await qboQuery<Record<string, unknown>>(organizationId, "SELECT * FROM Account MAXRESULTS 1000", "Account");
  if (!res.ok) return res;
  return {
    ok: true,
    data: res.data.map((a) => ({
      id: String(a.Id ?? ""),
      name: str(a.Name) ?? "",
      acctNum: str(a.AcctNum),
      accountType: str(a.AccountType),
      accountSubType: str(a.AccountSubType),
      classification: str(a.Classification),
      active: a.Active !== false,
      fullyQualifiedName: str(a.FullyQualifiedName),
    })),
  };
}

/**
 * Probe the connection and record the verdict on it.
 *
 * The result is stored because a connection dies quietly: a refresh token
 * unused for 100 days simply stops working, and without a recorded
 * last-good nobody notices until a purchase order fails to post.
 */
export async function runHealthCheck(organizationId: string): Promise<QboResult<QboCompany>> {
  const res = await getCompanyInfo(organizationId);
  const at = new Date().toISOString();

  if (res.ok) {
    await saveConnection(organizationId, {
      lastHealthCheckAt: at,
      lastHealthCheckOk: true,
      lastHealthCheckError: null,
      companyName: res.data.companyName,
    }).catch((err) => apiLogger.warn({ msg: "quickbooks:health-save-failed", organizationId, err: String(err) }));
    return res;
  }

  // Nothing to record against when there is no connection to record on.
  if (res.code !== "NOT_CONFIGURED" && res.code !== "NOT_CONNECTED") {
    await saveConnection(organizationId, {
      lastHealthCheckAt: at,
      lastHealthCheckOk: false,
      lastHealthCheckError: `${res.code}: ${res.message}`.slice(0, 500),
    }).catch((err) => apiLogger.warn({ msg: "quickbooks:health-save-failed", organizationId, err: String(err) }));
  }
  return res;
}
