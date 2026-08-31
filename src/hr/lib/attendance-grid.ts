/**
 * The attendance grid's keyboard and selection model.
 *
 * Pure, and separate from the page, because two of the things in here fail
 * SILENTLY. If `SHIFT_KEY_TO_CODE` pointed at SL-H rather than SL-HD the grid
 * would look and behave identically while booking a full day at half pay
 * instead of half a day at full pay, and nobody would find out until payroll.
 * If a code listed here were renamed in the seed the picker would offer a
 * button that quietly does nothing. Neither shows up in a screenshot, so both
 * are pinned by tests against the seed itself.
 */

import { HR_LEAVE_CODE_SEED } from "./hr-seed-data";

export interface GridCode {
  code: string;
  label: string;
  /** The bare letter that writes it; with Shift for the half-day pair. */
  key: string;
}

/**
 * The codes that carry a keyboard shortcut, in the order they appear.
 *
 * Five, from the imported data: AL and WFH alone are 85% of every entry, and
 * these five are 99.3%. The rest live behind "Another code", so the once-a-year
 * ones do not compete for attention with the daily ones.
 */
export const PRIMARY: readonly GridCode[] = [
  { code: "AL", label: "Annual", key: "a" },
  { code: "WFH", label: "From home", key: "w" },
  { code: "SL-F", label: "Sick", key: "s" },
  { code: "OD", label: "On duty", key: "o" },
  { code: "CO", label: "Comp-off", key: "c" },
];

/**
 * The two half-day codes, which get their own labelled row in the picker.
 *
 * They have always existed in the seed and the balance engine already halves
 * them, but they were reachable only as bare chips behind "Another code" —
 * sitting beside SL-H, which is a FULL day at half pay. One character apart,
 * both unlabelled.
 *
 * Shift is free as the modifier: the grid's handler refuses Cmd/Ctrl/Alt but
 * not Shift, and it lowercases the key, so Shift+A currently just writes a full
 * day of annual leave. The combination is unused and unambiguous.
 */
export const HALF_DAY: readonly GridCode[] = [
  { code: "AL-HD", label: "Annual ½", key: "a" },
  { code: "SL-HD", label: "Sick ½", key: "s" },
];

const KEY_TO_CODE = Object.fromEntries(PRIMARY.map((p) => [p.key, p.code]));
const SHIFT_KEY_TO_CODE = Object.fromEntries(HALF_DAY.map((h) => [h.key, h.code]));

/**
 * What a keypress writes. ONE function, so the half-day mapping cannot be
 * stated once in the handler and differently in the legend.
 */
export function resolveKeyCode(key: string, shift: boolean): string | null {
  const k = key.toLowerCase();
  return (shift ? SHIFT_KEY_TO_CODE[k] : KEY_TO_CODE[k]) ?? null;
}

/** Arrow key -> [row delta, day delta]. */
export const ARROW_STEP: Record<string, readonly [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

/** A rectangle of cells: an anchor (r0,d0) and a head (r1,d1). */
export interface Selection {
  r0: number;
  d0: number;
  r1: number;
  d1: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Move the selection. No new state was needed for keyboard navigation:
 * `Selection` was always an anchor and a head, and only the mouse could drive
 * it. A plain arrow moves both and collapses to one cell; Shift moves the head
 * alone and extends. Both clamp at the edges rather than wrapping — wrapping
 * from the last day of the month to the first would look like a bug.
 */
export function moveSelection(
  s: Selection,
  [dr, dd]: readonly [number, number],
  extend: boolean,
  rows: number,
  cols: number,
): Selection {
  const r1 = clamp(s.r1 + dr, 0, rows - 1);
  const d1 = clamp(s.d1 + dd, 0, cols - 1);
  return extend ? { ...s, r1, d1 } : { r0: r1, d0: d1, r1, d1 };
}

/** Collapse to the head, which is what a write leaves behind so the cursor survives it. */
export function collapseToHead(s: Selection): Selection {
  return { r0: s.r1, d0: s.d1, r1: s.r1, d1: s.d1 };
}

/** Every code the grid offers by shortcut, for the seed drift guard. */
export const GRID_SHORTCUT_CODES: readonly string[] = [...PRIMARY, ...HALF_DAY].map((c) => c.code);

/** True when the seed actually defines this code — a typo here is a dead button. */
export function seedHasCode(code: string): boolean {
  return HR_LEAVE_CODE_SEED.some((c) => c.code === code);
}
