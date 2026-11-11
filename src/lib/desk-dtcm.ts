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
 * to an organiser. It does not name the pool: the desk issues from DET
 * (owner, Nov 11 2026) and does not expect spares. (A walk-in still takes a
 * spare by itself when the pool has one, as it has since August: that happens
 * in `createRegistration`, before the desk is asked anything.)
 */
export function walkInDtcmWarning(name: string, canGetCode: boolean): string {
  const next = canGetCode ? "Get one on their row before you print the badge." : "Ask an organiser before you print the badge.";
  return `${name} has no DTCM code yet. A badge printed now would have no compliance QR. ${next}`;
}

/** What the desk reads of one of the person's DET orders (the per-registration DET read). */
export interface DeskDetOrder {
  status: string;
  /** UNCERTAIN, or a PENDING left by a crash: a person must settle it. */
  unresolved: boolean;
}

/**
 * Where this person stands with DET, for a row that has NO code:
 *
 * - `buying`: an order is PENDING and fresh. Another desk, the bulk run, or
 *   this desk's own press whose answer was cut off (a gateway timeout answers
 *   long before DET does). A ticket is being bought right now.
 * - `attention`: an order needs a person. UNCERTAIN (or a PENDING left by a
 *   crash), or PURCHASED, which on a row with no code means its barcode is
 *   unread or was never put on the row. The DET controls put a notice on it.
 * - `none`: nothing of theirs is live. FAILED and REVERSED orders are history.
 */
export type DeskDetState = "none" | "buying" | "attention";

export function deskDetState(orders: readonly DeskDetOrder[]): DeskDetState {
  if (orders.some((o) => o.status === "PENDING" && !o.unresolved)) return "buying";
  if (orders.some((o) => o.unresolved || o.status === "PURCHASED")) return "attention";
  return "none";
}

/**
 * Whether the desk may offer a spare code (review of 243b7136, HIGH). Never
 * while DET has anything live for this person: a spare taken beside a
 * purchase in flight leaves a bought ticket nobody holds
 * (`CODE_ARRIVED_MEANWHILE`: the seat is used and only an organiser can give
 * it back), and beside an uncertain or unread sale it settles for the desk
 * what the purchase route leaves to "the person resolving it". Never, either,
 * until the DET read has answered: not knowing is not "nothing live".
 *
 * The pool route itself does not know about DET orders, so this is the desk's
 * rule, not the server's (docs/ROADMAP.md, the spare pool and a live order).
 */
export function deskMayOfferSpare(args: { detKnown: boolean; detState: DeskDetState; buyingHere: boolean; spare: number }): boolean {
  return args.detKnown && args.detState === "none" && !args.buyingHere && args.spare > 0;
}

/**
 * What to say on a row's DTCM panel when nothing there can issue a code: DET
 * cannot sell for this person (no credentials, a mapping that is out of date,
 * or their type has no DET section), nothing of theirs is live at DET, and
 * the pool has no spares. Null when the desk has something to press or read.
 */
export function deskDtcmNoSourceMessage(args: { detReady: boolean; detState: DeskDetState; spare: number }): string | null {
  if (args.detReady || args.detState !== "none" || args.spare > 0) return null;
  return "No code can be issued here: DET cannot issue one for this registration (it is not set up for this event, or this registration type has no DET section), and there are no spare codes. Ask an organiser.";
}
