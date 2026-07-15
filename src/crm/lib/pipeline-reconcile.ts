/**
 * Pure planner for bringing an org's pipeline to the canonical seed.
 *
 * No `db` — the reconcile script reads the org's stages, asks this for a plan, and
 * applies it in a transaction. Keeping the decision here makes it unit-testable and
 * keeps "what changes" auditable in one place (the same shape as planSeatTransition
 * / planRoomTransition).
 *
 * Matching is by case-insensitive name, each existing stage consumed at most once
 * (so a duplicate column becomes an orphan rather than two winners). A canonical
 * stage with no match is CREATED; an existing stage with no canonical match is an
 * ORPHAN — its deals are moved to the fallback (the first canonical stage) before it
 * is removed, because the FK is Restrict and a column's deals must never vanish.
 */
export interface ExistingStage {
  id: string;
  name: string;
  sortOrder: number;
  isTerminal: boolean;
}

export interface CanonicalStage {
  name: string;
  isTerminal: boolean;
}

export interface PipelinePlan {
  /** Canonical stages with no existing match — create at the given sortOrder. */
  toCreate: Array<{ name: string; isTerminal: boolean; sortOrder: number }>;
  /** Existing stages that matched a canonical one but need name/order/terminal fixed. */
  toUpdate: Array<{ id: string; name: string; sortOrder: number; isTerminal: boolean }>;
  /** Existing stages not in the canonical set — move their deals to the fallback, then delete. */
  toRemove: Array<{ id: string; name: string }>;
  /** The canonical stage a removed column's deals are moved into (canonical[0]). */
  fallbackStageName: string;
}

const key = (s: string) => s.trim().toLowerCase();

export function planPipelineReconciliation(
  existing: ExistingStage[],
  canonical: ReadonlyArray<CanonicalStage>,
): PipelinePlan {
  const consumed = new Set<string>();
  const toCreate: PipelinePlan["toCreate"] = [];
  const toUpdate: PipelinePlan["toUpdate"] = [];

  canonical.forEach((c, i) => {
    const match = existing.find((e) => !consumed.has(e.id) && key(e.name) === key(c.name));
    if (!match) {
      toCreate.push({ name: c.name, isTerminal: c.isTerminal, sortOrder: i });
      return;
    }
    consumed.add(match.id);
    // Only record a real change — a re-run against an already-canonical pipeline
    // produces an empty plan. Casing is normalized to the canonical exact string.
    if (match.name !== c.name || match.sortOrder !== i || match.isTerminal !== c.isTerminal) {
      toUpdate.push({ id: match.id, name: c.name, sortOrder: i, isTerminal: c.isTerminal });
    }
  });

  const toRemove = existing
    .filter((e) => !consumed.has(e.id))
    .map((e) => ({ id: e.id, name: e.name }));

  return { toCreate, toUpdate, toRemove, fallbackStageName: canonical[0]?.name ?? "" };
}
