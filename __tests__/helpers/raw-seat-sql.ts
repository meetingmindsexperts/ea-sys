/**
 * Helpers for asserting on the raw guarded seat claims in
 * src/lib/registration-seat-db.ts (`claimSeats` issues ONE statement per
 * counter: `UPDATE ... SET soldCount = soldCount + n WHERE id = $id AND
 * soldCount + n <= quantity`). A Prisma tagged-template call arrives as
 * (strings, ...values); these turn it into something a test can read.
 */
import type { Mock } from "vitest";

export type SeatTable = "TicketType" | "PricingTier" | "Event" | "other";

export interface RawSeatCall {
  table: SeatTable;
  sql: string;
  values: unknown[];
}

function tableOf(sql: string): SeatTable {
  if (sql.includes('"PricingTier"')) return "PricingTier";
  if (sql.includes('"TicketType"')) return "TicketType";
  if (sql.includes('"Event"')) return "Event";
  return "other";
}

/** Every `$executeRaw` call on a mock, decoded. */
export function rawSeatCalls(mock: Mock): RawSeatCall[] {
  return mock.mock.calls.map((args) => {
    const strings = args[0] as readonly string[];
    const values = args.slice(1);
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    return { table: tableOf(sql), sql, values };
  });
}

/** Only the claims against one table, as `{ id, count }` in call order. */
export function rawClaims(mock: Mock, table: SeatTable): Array<{ id: unknown; count: unknown }> {
  return rawSeatCalls(mock)
    .filter((c) => c.table === table && c.sql.includes("<= \"quantity\""))
    .map((c) => ({ count: c.values[0], id: c.values[1] }));
}

/**
 * A `$executeRaw` implementation that answers per table: 1 affected row
 * unless `fits[table] === false`, then 0. Covers the seat claims and the
 * event-cap claim (also raw) in one mock.
 */
export function seatRawExecutor(
  fits: Partial<Record<SeatTable, boolean>> = {},
): (...args: unknown[]) => Promise<number> {
  return async (...args: unknown[]) => {
    const strings = (args[0] ?? []) as readonly string[];
    const table = tableOf(strings.join("?"));
    return fits[table] === false ? 0 : 1;
  };
}
