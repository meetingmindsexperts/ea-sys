/**
 * DTCM compliance codes at the onsite desk (docs/DTCM_ETICKET_PLAN.md §5.4,
 * built Nov 11, 2026): which rows the desk flags as having no code, what a
 * walk-in's answer says about its code, and what to tell staff when no source
 * can issue one. The buying and the spare pool are the routes the registration
 * sheet already uses; this file only decides what the desk shows.
 *
 * Pure and client-safe.
 */
import { lacksDtcmCode } from "@/lib/dtcm-walkup";

/** What the desk reads of a row. */
export interface DeskDtcmRow {
  status: string;
  attendanceMode?: string | null;
  /**
   * ABSENT, not null, for a role that may not see door credentials: the list
   * strips the key (barcode-visibility.ts). So "no value" alone says nothing,
   * which is why `canSeeCodes` is asked first below.
   */
  dtcmBarcode?: string | null;
}

/**
 * Whether the desk flags a row "No DTCM code" and offers to get one.
 *
 * Never for a role that cannot see codes: every row would read as missing
 * (the reason the spare-code button was once offered on all of them, see the
 * dtcm-pool route). Never for a cancelled or waitlisted person: neither has a
 * place at the event, and DET refuses both.
 */
export function deskRowNeedsDtcmCode(event: { requiresDtcm: boolean; canSeeCodes: boolean }, row: DeskDtcmRow): boolean {
  if (!event.canSeeCodes) return false;
  if (row.status === "CANCELLED" || row.status === "WAITLISTED") return false;
  return lacksDtcmCode({ requiresDtcm: event.requiresDtcm, attendanceMode: row.attendanceMode, dtcmBarcode: row.dtcmBarcode });
}

/**
 * Whether a walk-in just registered was left with no code, read from the
 * walk-in route's `dtcm` (the spare pool's outcome). Read from the answer and
 * not from the refreshed row, so it also holds for desk staff who cannot see
 * codes: they cannot fix it, but they can be told. A walk-in is in person.
 *
 * Only a known "no code" outcome counts. An answer with no outcome at all (an
 * older server during a deploy) says nothing; the row's own flag still shows
 * once the list refreshes.
 */
export function walkInLeftWithoutDtcmCode(requiresDtcm: boolean, outcome: unknown): boolean {
  if (!requiresDtcm) return false;
  const status = outcome && typeof outcome === "object" ? (outcome as { status?: unknown }).status : undefined;
  return status === "pool-empty" || status === "failed";
}

/**
 * What the desk says after such a walk-in. Staff who can get a code are sent
 * to the row, where its panel is already open on "Get code from DET"; others
 * to an organiser. It does not name the pool: at the desk a code comes from
 * DET first (owner, Nov 11 2026), and an empty pool is the ordinary state.
 */
export function walkInDtcmWarning(name: string, canGetCode: boolean): string {
  const next = canGetCode ? "Get one on their row before you print the badge." : "Ask an organiser before you print the badge.";
  return `${name} has no DTCM code yet. A badge printed now would have no compliance QR. ${next}`;
}

/**
 * What to say on a row's DTCM panel when nothing there can issue a code: DET
 * cannot sell for this person (not set up, or their type has no DET section),
 * no DET order of theirs is waiting on someone, and the pool has no spares.
 * Null when at least one of those gives the desk something to press or read.
 */
export function deskDtcmNoSourceMessage(args: { detReady: boolean; hasDetOrderToShow: boolean; spare: number }): string | null {
  if (args.detReady || args.hasDetOrderToShow || args.spare > 0) return null;
  return "No code can be issued here: DET is not set up for this registration type, and there are no spare codes. Ask an organiser to import codes or to map this type to a DET section.";
}
