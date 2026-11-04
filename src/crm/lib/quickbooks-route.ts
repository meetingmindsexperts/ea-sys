/**
 * The CRM's mapping of a failed QuickBooks read to an error value (Nov 4,
 * 2026), shared by the three lookup routes. Server only: logs.
 */
import { apiLogger } from "@/lib/logger";

const NOT_CONNECTED = new Set(["NOT_CONFIGURED", "NOT_CONNECTED", "ENVIRONMENT_MISMATCH", "APP_CHANGED", "REFRESH_EXPIRED"]);

export function qboLookupFail(res: { code: string; message: string }, organizationId: string, lookup: string) {
  apiLogger.warn({ msg: "crm/quickbooks:lookup-failed", organizationId, lookup, qboCode: res.code, message: res.message });
  return NOT_CONNECTED.has(res.code)
    ? { code: "QBO_NOT_CONNECTED", message: "QuickBooks is not connected. An admin connects it in Settings → Integrations." }
    : { code: "QBO_ERROR", message: `QuickBooks did not answer: ${res.message}` };
}
