/**
 * The onsite desk's day summary (owner, Nov 2, 2026; docs/ONSITE_DESK_PLAN.md):
 * how many walk-ins came in on which rate, and the cash and card each desk
 * user took, for one calendar day in the event's timezone. Pure, client-safe:
 * the route reads the rows, this module counts them.
 *
 * The status alone cannot tell "free" from "comp": both are saved as
 * COMPLIMENTARY (the owner kept one status). The rate tells them apart: a rate
 * at 0 that is not the Complimentary rate is Free; the Complimentary rate, or a
 * 100% code on a paid rate, is Comp.
 */
import { isComplimentaryRate } from "@/lib/desk-walkin-payment";
import { wallTimeInTzToDate } from "@/lib/event-time";

export type WalkInBucket = "free" | "comp" | "sponsor" | "paid" | "unpaid";

export const WALK_IN_BUCKETS: readonly WalkInBucket[] = ["free", "comp", "sponsor", "paid", "unpaid"];

/** The cash and onsite card a desk takes. A bank transfer never passes through the drawer. */
export const DESK_PAYMENT_METHODS = ["cash", "card_onsite"] as const;
export type DeskPaymentMethod = (typeof DESK_PAYMENT_METHODS)[number];

export interface WalkInRow {
  paymentStatus: string;
  ticketTypeName: string | null;
  rateName: string | null;
  ratePrice: number;
}

export interface DeskPaymentRow {
  method: DeskPaymentMethod;
  currency: string;
  amount: number;
  refunded: number;
  recordedByUserId: string | null;
}

export interface RateLine {
  ticketTypeName: string;
  rateName: string | null;
  counts: Record<WalkInBucket, number>;
}

export interface MoneyLine {
  userId: string | null;
  method: DeskPaymentMethod;
  currency: string;
  count: number;
  amount: number;
  refunded: number;
}

export interface DeskDaySummary {
  walkIns: { total: number; totals: Record<WalkInBucket, number>; byRate: RateLine[] };
  money: { byUser: MoneyLine[]; totals: Omit<MoneyLine, "userId">[] };
}

/** `YYYY-MM-DD`, a real date. */
export function isDeskDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return !Number.isNaN(wallTimeInTzToDate(`${value}T00:00`, "UTC").getTime());
}

/** The instants a calendar day in `timeZone` starts and ends (end exclusive). */
export function deskDayBounds(date: string, timeZone: string): { start: Date; end: Date } {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start: wallTimeInTzToDate(`${date}T00:00`, timeZone), end: wallTimeInTzToDate(`${next}T00:00`, timeZone) };
}

/** Which column a walk-in counts in. A walk-in left unpaid is one whose desk payment did not record. */
export function walkInBucket(row: Pick<WalkInRow, "paymentStatus" | "rateName" | "ratePrice">): WalkInBucket {
  if (row.paymentStatus === "INCLUSIVE") return "sponsor";
  if (row.paymentStatus === "PAID") return "paid";
  if (row.paymentStatus !== "COMPLIMENTARY") return "unpaid";
  return row.ratePrice <= 0 && !isComplimentaryRate(row.rateName) ? "free" : "comp";
}

const emptyCounts = (): Record<WalkInBucket, number> => ({ free: 0, comp: 0, sponsor: 0, paid: 0, unpaid: 0 });
const round2 = (n: number) => Math.round(n * 100) / 100;

export function summariseDeskDay(walkIns: readonly WalkInRow[], payments: readonly DeskPaymentRow[]): DeskDaySummary {
  const totals = emptyCounts();
  const rates = new Map<string, RateLine>();
  for (const w of walkIns) {
    const bucket = walkInBucket(w);
    totals[bucket] += 1;
    const ticketTypeName = w.ticketTypeName ?? "No type";
    const key = `${ticketTypeName}\u0000${w.rateName ?? ""}`;
    const line = rates.get(key) ?? { ticketTypeName, rateName: w.rateName, counts: emptyCounts() };
    line.counts[bucket] += 1;
    rates.set(key, line);
  }

  const byUser = new Map<string, MoneyLine>();
  const byMethod = new Map<string, Omit<MoneyLine, "userId">>();
  for (const p of payments) {
    const currency = p.currency.toUpperCase();
    const userKey = `${p.recordedByUserId ?? ""}\u0000${p.method}\u0000${currency}`;
    const user = byUser.get(userKey) ?? { userId: p.recordedByUserId, method: p.method, currency, count: 0, amount: 0, refunded: 0 };
    user.count += 1;
    user.amount = round2(user.amount + p.amount);
    user.refunded = round2(user.refunded + p.refunded);
    byUser.set(userKey, user);

    const methodKey = `${p.method}\u0000${currency}`;
    const total = byMethod.get(methodKey) ?? { method: p.method, currency, count: 0, amount: 0, refunded: 0 };
    total.count += 1;
    total.amount = round2(total.amount + p.amount);
    total.refunded = round2(total.refunded + p.refunded);
    byMethod.set(methodKey, total);
  }

  const byName = (a: RateLine, b: RateLine) =>
    a.ticketTypeName.localeCompare(b.ticketTypeName) || (a.rateName ?? "").localeCompare(b.rateName ?? "");
  return {
    walkIns: { total: walkIns.length, totals, byRate: [...rates.values()].sort(byName) },
    money: { byUser: [...byUser.values()], totals: [...byMethod.values()] },
  };
}
