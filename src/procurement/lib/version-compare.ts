/**
 * Version compare (spec §6a): two versions of one event's budget side by
 * side. A line keeps its `lineKey` across versions (the clone preserves it),
 * so the pairing is by key: a key on one side only is an added or removed
 * line, and a key on both is compared on its planned amount. Pure and
 * client-safe; the compare page renders what this returns.
 */
import { money, storedString, type MoneyInput } from "./money";

export interface CompareLine {
  lineKey: string;
  categoryCode: string;
  description: string;
  planned: MoneyInput;
  isContingency: boolean;
  sortOrder: number;
}

export type CompareChange = "added" | "removed" | "changed" | "unchanged";

export interface CompareRow {
  lineKey: string;
  categoryCode: string;
  description: string;
  isContingency: boolean;
  basePlanned: string | null;
  targetPlanned: string | null;
  /** target minus base, 4 dp; a removed line's delta is minus its base amount. */
  delta: string;
  change: CompareChange;
  /** The wording moved even when the money did not. */
  descriptionChanged: boolean;
}

const order = (l: CompareLine) => (l.isContingency ? 1 : 0);
const byOrder = (a: CompareLine, b: CompareLine) => order(a) - order(b) || a.sortOrder - b.sortOrder;

/** Target lines first in their own order, then the lines the target dropped, contingency last on both sides. */
export function compareVersions(base: readonly CompareLine[], target: readonly CompareLine[]): CompareRow[] {
  const baseByKey = new Map(base.map((l) => [l.lineKey, l]));
  const targetKeys = new Set(target.map((l) => l.lineKey));
  const rows: CompareRow[] = [];
  for (const t of target.slice().sort(byOrder)) {
    const b = baseByKey.get(t.lineKey);
    const tp = money(t.planned);
    if (!b) {
      rows.push({ lineKey: t.lineKey, categoryCode: t.categoryCode, description: t.description, isContingency: t.isContingency, basePlanned: null, targetPlanned: storedString(tp), delta: storedString(tp), change: "added", descriptionChanged: false });
      continue;
    }
    const bp = money(b.planned);
    rows.push({
      lineKey: t.lineKey,
      categoryCode: t.categoryCode,
      description: t.description,
      isContingency: t.isContingency,
      basePlanned: storedString(bp),
      targetPlanned: storedString(tp),
      delta: storedString(tp.minus(bp)),
      change: tp.eq(bp) ? "unchanged" : "changed",
      descriptionChanged: b.description.trim() !== t.description.trim(),
    });
  }
  for (const b of base.filter((l) => !targetKeys.has(l.lineKey)).sort(byOrder)) {
    const bp = money(b.planned);
    rows.push({ lineKey: b.lineKey, categoryCode: b.categoryCode, description: b.description, isContingency: b.isContingency, basePlanned: storedString(bp), targetPlanned: null, delta: storedString(bp.neg()), change: "removed", descriptionChanged: false });
  }
  return rows;
}

export interface CompareSummary {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  /** Net planned movement over the non-contingency lines (the contingency line follows the percent, so it is not a decision of its own). */
  netDelta: string;
}

export function compareSummary(rows: readonly CompareRow[]): CompareSummary {
  const s: CompareSummary = { added: 0, removed: 0, changed: 0, unchanged: 0, netDelta: "0.0000" };
  let net = money(0);
  for (const r of rows) {
    s[r.change] += 1;
    if (!r.isContingency) net = net.plus(money(r.delta));
  }
  s.netDelta = storedString(net);
  return s;
}
