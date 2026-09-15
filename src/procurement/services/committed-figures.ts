/**
 * A budget line's committed figures, summed from the orders themselves.
 *
 * Two things these figures have to survive (review of 15 September 2026).
 * Two orders issued or cancelled on one line at the same moment: each used to
 * read the line's figure and write back that figure plus or minus its own
 * amount, so under READ COMMITTED one update could vanish. And a new budget
 * version: the figures were copied once when the draft was made, while an
 * order keeps the version it was issued on, so an order issued after the copy,
 * or cancelled after the new version took over, moved the wrong version's line.
 *
 * So a figure is never incremented. Under a per-event advisory lock, held to
 * the end of the transaction (safe through the pooler), it is summed again
 * from the event's orders on that line key across every version, and written
 * to the version that is current now: the active or frozen one, or the order's
 * own version when the event has neither. Every write that changes an order's
 * committed state calls `syncLineCommitted` after that write; activating a
 * version takes `lockEventCommitted` BEFORE it touches the budget rows (the
 * order of locks is what keeps the two from deadlocking) and then calls
 * `syncBudgetCommitted`. Callers recompute the budget totals themselves, so
 * this file imports no service and the graph has no cycle.
 *
 * Open is every order not cancelled or closed; total is every order not
 * cancelled. Receiving moves neither; the invoice read-back will.
 */
import { apiLogger } from "@/lib/logger";
import type { Db } from "@/lib/approvals/approvals-service";
import { money, storedString } from "../lib/money";
import { toReporting } from "../lib/spend-request-rules";

const CURRENT_STATUSES = new Set(["ACTIVE", "FROZEN"]);

type Figures = { open: string; total: string };
const NONE: Figures = { open: "0.0000", total: "0.0000" };

async function takeLock(tx: Db, key: string): Promise<void> {
  // ::text because pg_advisory_xact_lock returns void, which $queryRaw cannot read.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`procurement-committed:${key}`}))::text`;
}

/** Locks the event a budget version belongs to and returns every version of it, read after the lock. */
export async function lockEventCommitted(tx: Db, organizationId: string, budgetId: string): Promise<{ originId: string; versions: { id: string; status: string }[] } | null> {
  const origin = await tx.eventBudget.findFirst({ where: { id: budgetId, organizationId }, select: { id: true, eventId: true } });
  if (!origin) return null;
  await takeLock(tx, origin.eventId ?? origin.id);
  const versions = await tx.eventBudget.findMany({
    where: origin.eventId ? { organizationId, eventId: origin.eventId } : { id: origin.id, organizationId },
    select: { id: true, status: true },
  });
  return { originId: origin.id, versions };
}

/** Every version of the event a budget belongs to (only the budget itself when it has no event), read without a lock: for display, and for a check that locks before it writes. */
export async function eventBudgetIds(client: Db, organizationId: string, budgetId: string): Promise<string[]> {
  const origin = await client.eventBudget.findFirst({ where: { id: budgetId, organizationId }, select: { id: true, eventId: true } });
  if (!origin) return [budgetId];
  if (!origin.eventId) return [origin.id];
  const rows = await client.eventBudget.findMany({ where: { organizationId, eventId: origin.eventId }, select: { id: true } });
  return rows.map((r) => r.id);
}

async function committedByLineKey(tx: Db, organizationId: string, budgetIds: string[], lineKeys?: string[]): Promise<Map<string, Figures>> {
  const orders = await tx.commitment.findMany({
    where: { organizationId, budgetId: { in: budgetIds }, status: { not: "CANCELLED" }, ...(lineKeys ? { lineKey: { in: lineKeys } } : {}) },
    select: { lineKey: true, amount: true, fxRateToReporting: true, status: true },
  });
  const sums = new Map<string, { open: ReturnType<typeof money>; total: ReturnType<typeof money> }>();
  for (const o of orders) {
    const reporting = toReporting(o.amount, money(o.fxRateToReporting));
    const s = sums.get(o.lineKey) ?? { open: money(0), total: money(0) };
    s.total = s.total.plus(reporting);
    if (o.status !== "CLOSED") s.open = s.open.plus(reporting);
    sums.set(o.lineKey, s);
  }
  return new Map([...sums].map(([k, s]) => [k, { open: storedString(s.open), total: storedString(s.total) }]));
}

/**
 * After an order on (budgetId, lineKey) is issued or cancelled: the line on
 * the event's current version gets the summed figures. Returns the id of the
 * version written to, for the caller's totals recompute, or null when the
 * budget itself is gone.
 */
export async function syncLineCommitted(tx: Db, input: { organizationId: string; budgetId: string; lineKey: string }): Promise<string | null> {
  const locked = await lockEventCommitted(tx, input.organizationId, input.budgetId);
  if (!locked) {
    apiLogger.warn({ msg: "procurement/commitments:committed-budget-missing", organizationId: input.organizationId, budgetId: input.budgetId, lineKey: input.lineKey });
    return null;
  }
  const targetId = locked.versions.find((v) => CURRENT_STATUSES.has(v.status))?.id ?? locked.originId;
  const line = await tx.budgetLine.findFirst({ where: { budgetId: targetId, lineKey: input.lineKey, deletedAt: null }, select: { id: true } });
  if (!line) {
    apiLogger.warn({ msg: "procurement/commitments:committed-line-missing", organizationId: input.organizationId, budgetId: targetId, lineKey: input.lineKey });
    return targetId;
  }
  const figures = (await committedByLineKey(tx, input.organizationId, locked.versions.map((v) => v.id), [input.lineKey])).get(input.lineKey) ?? NONE;
  await tx.budgetLine.update({ where: { id: line.id }, data: { committedOpen: figures.open, committedTotal: figures.total } });
  return targetId;
}

/**
 * When a version becomes current: every line on it gets the summed figures of
 * the event's orders, so an order issued on the previous version after this
 * one was drafted is counted, and one cancelled since is not. The caller took
 * `lockEventCommitted` before archiving the previous version.
 */
export async function syncBudgetCommitted(tx: Db, organizationId: string, budgetId: string): Promise<void> {
  const locked = await lockEventCommitted(tx, organizationId, budgetId);
  if (!locked) return;
  const lines = await tx.budgetLine.findMany({ where: { budgetId, deletedAt: null }, select: { id: true, lineKey: true, committedOpen: true, committedTotal: true } });
  const figures = await committedByLineKey(tx, organizationId, locked.versions.map((v) => v.id));
  for (const l of lines) {
    const f = figures.get(l.lineKey) ?? NONE;
    if (storedString(l.committedOpen) === f.open && storedString(l.committedTotal) === f.total) continue;
    await tx.budgetLine.update({ where: { id: l.id }, data: { committedOpen: f.open, committedTotal: f.total } });
  }
}
