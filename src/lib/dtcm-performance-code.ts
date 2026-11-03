/**
 * The DET performance code an event's DTCM compliance codes are bought against
 * (e.g. `PDUB01DEC2023B`), and the one rule about it: **DTCM on means a code
 * is set**. See docs/DTCM_ETICKET_PLAN.md.
 *
 * Every writer of `Event.requiresDtcmBarcode` goes through
 * `resolveDtcmEventConfig()`: the event edit, event creation (dashboard, agent,
 * Blueprint) and the agent's update_event. Clone does not need it because a
 * clone always starts with DTCM off.
 *
 * Judged only when a request CHANGES either field: turning DTCM on, or setting
 * or clearing the code. Sending the stored values back is not a change, and
 * the Settings page sends both on every save of three tabs, so a "touched"
 * test would block every save on the one DTCM event that predates the code
 * (and lock out a details-only editor, who cannot hold the code's key).
 * Owner, Nov 3 2026: the code is asked for when DTCM is ENABLED.
 *
 * Client-safe: no imports, so the Settings page shares the normaliser.
 */

export const DTCM_PERFORMANCE_CODE_MAX = 100;

/** DET's codes are upper-case letters and digits; `-` and `_` are tolerated. */
const DTCM_PERFORMANCE_CODE_PATTERN = /^[A-Z0-9_-]+$/;

/** Trim and upper-case; empty means no code. Non-strings are no code. */
export function normalizeDtcmPerformanceCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return code === "" ? null : code;
}

export type DtcmEventConfigErrorCode = "DTCM_PERFORMANCE_CODE_REQUIRED" | "INVALID_DTCM_PERFORMANCE_CODE";

export type DtcmEventConfigResult =
  | { ok: true; requiresDtcmBarcode: boolean; dtcmPerformanceCode: string | null }
  | { ok: false; code: DtcmEventConfigErrorCode; message: string };

/**
 * The event's DTCM settings after a write, or why the write is refused.
 *
 * `next` holds only what the request sent (`undefined` = not sent); `stored`
 * is the event as it is now, or null on create. Turning DTCM off keeps the
 * code, so switching it back on later does not ask for it again.
 */
export function resolveDtcmEventConfig(
  next: { requiresDtcmBarcode?: boolean; dtcmPerformanceCode?: unknown },
  stored: { requiresDtcmBarcode: boolean; dtcmPerformanceCode: string | null } | null,
): DtcmEventConfigResult {
  const sent = next.dtcmPerformanceCode;
  if (sent !== undefined && sent !== null && typeof sent !== "string") {
    // A door that skips Zod (a raw agent call) must not clear the code by
    // sending a number; refuse rather than read it as "no code".
    return { ok: false, code: "INVALID_DTCM_PERFORMANCE_CODE", message: "The DET performance code must be text" };
  }
  const requiresDtcmBarcode = next.requiresDtcmBarcode ?? stored?.requiresDtcmBarcode ?? false;
  const dtcmPerformanceCode =
    next.dtcmPerformanceCode === undefined
      ? (stored?.dtcmPerformanceCode ?? null)
      : normalizeDtcmPerformanceCode(next.dtcmPerformanceCode);

  if (dtcmPerformanceCode !== null && !isValidDtcmPerformanceCode(dtcmPerformanceCode)) {
    return {
      ok: false,
      code: "INVALID_DTCM_PERFORMANCE_CODE",
      message: `The DET performance code may use only letters, digits, - and _ (up to ${DTCM_PERFORMANCE_CODE_MAX} characters)`,
    };
  }

  const turnedOn = requiresDtcmBarcode && !(stored?.requiresDtcmBarcode ?? false);
  const codeChanged = dtcmPerformanceCode !== (stored?.dtcmPerformanceCode ?? null);
  if (requiresDtcmBarcode && dtcmPerformanceCode === null && (turnedOn || codeChanged)) {
    return {
      ok: false,
      code: "DTCM_PERFORMANCE_CODE_REQUIRED",
      message: "DTCM barcodes need the event's DET performance code (for example PDUB01DEC2023B), under Settings, Registration",
    };
  }

  return { ok: true, requiresDtcmBarcode, dtcmPerformanceCode };
}

export function isValidDtcmPerformanceCode(code: string): boolean {
  return code.length <= DTCM_PERFORMANCE_CODE_MAX && DTCM_PERFORMANCE_CODE_PATTERN.test(code);
}
