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
 * Judged only when a request TOUCHES either field, so an unrelated agent edit
 * (a venue change) on the one DTCM event that predates the code still saves.
 * The Settings page sends both fields on every save, so its organiser is asked
 * for the code the next time they save that tab, which is the intent.
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

  const touched = next.requiresDtcmBarcode !== undefined || next.dtcmPerformanceCode !== undefined;
  if (touched && requiresDtcmBarcode && dtcmPerformanceCode === null) {
    return {
      ok: false,
      code: "DTCM_PERFORMANCE_CODE_REQUIRED",
      message: "Enter the event's DET performance code (for example PDUB01DEC2023B) to turn on DTCM barcodes",
    };
  }

  return { ok: true, requiresDtcmBarcode, dtcmPerformanceCode };
}

export function isValidDtcmPerformanceCode(code: string): boolean {
  return code.length <= DTCM_PERFORMANCE_CODE_MAX && DTCM_PERFORMANCE_CODE_PATTERN.test(code);
}
