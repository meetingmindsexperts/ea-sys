import { redactBarcodeFields } from "@/lib/barcode-visibility";
import { redactFinancialFields } from "@/lib/finance-visibility";
import { can, type Principal } from "@/lib/permissions/can";
import { ZOOM_HOST_KEYS } from "@/lib/zoom-visibility";

/**
 * What a tool result must lose for the person (or key) it is going to: the
 * same three field boundaries the REST routes apply (Phase 6 review, Oct 7,
 * 2026). Before this the in-app agent redacted money only, so a MEMBER read
 * every entry barcode through `list_registrations`, and the role-keyed MCP
 * door redacted nothing at all. All three keys are organisation-wide, so no
 * event is needed to ask them.
 */
export interface ToolRedactions {
  finance: boolean;
  barcodes: boolean;
  zoomHost: boolean;
}

export const NO_REDACTIONS: ToolRedactions = { finance: false, barcodes: false, zoomHost: false };

export function redactionsFor(principal: Principal): ToolRedactions {
  return {
    finance: !can(principal, "finance.view"),
    barcodes: !can(principal, "barcode.view"),
    zoomHost: !can(principal, "zoomHost.view"),
  };
}

export function needsRedaction(r: ToolRedactions): boolean {
  return r.finance || r.barcodes || r.zoomHost;
}

/** Nulls the Zoom host credentials wherever they appear, the REST convention. */
function redactZoomHostDeep<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactZoomHostDeep(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = (ZOOM_HOST_KEYS as readonly string[]).includes(k) ? null : redactZoomHostDeep(v);
  }
  return out as T;
}

export function redactToolValue<T>(value: T, r: ToolRedactions): T {
  let out = value;
  if (r.finance) out = redactFinancialFields(out);
  if (r.barcodes) out = redactBarcodeFields(out);
  if (r.zoomHost) out = redactZoomHostDeep(out);
  return out;
}

/**
 * A tool's text result with the fields removed. Tool results are JSON; a
 * plain-text result passes through, since the executors that return text
 * (contact and event lists) carry none of these fields.
 */
export function redactToolText(text: string, r: ToolRedactions): string {
  if (!needsRedaction(r)) return text;
  try {
    return JSON.stringify(redactToolValue(JSON.parse(text), r), null, 2);
  } catch {
    return text;
  }
}
