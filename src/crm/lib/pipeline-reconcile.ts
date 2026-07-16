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
 * ORPHAN — its deals are moved out before it is removed, because the FK is Restrict
 * and a column's deals must never vanish. An orphan that carried a terminalOutcome
 * reports it (`terminalOutcome` on the toRemove entry) so the applier can land its
 * closed deals in the matching canonical terminal column instead of the open
 * fallback — otherwise a WON deal would sit in "New" (CRM review L5).
 */
export interface ExistingStage {
  id: string;
  name: string;
  sortOrder: number;
  isTerminal: boolean;
  /** WON/LOST for mapped terminal stages. Optional so pre-column snapshots still plan. */
  terminalOutcome?: "WON" | "LOST" | null;
}

export interface CanonicalStage {
  name: string;
  isTerminal: boolean;
  terminalOutcome?: "WON" | "LOST" | null;
}

export interface PipelinePlan {
  /** Canonical stages with no existing match — create at the given sortOrder. */
  toCreate: Array<{ name: string; isTerminal: boolean; terminalOutcome: "WON" | "LOST" | null; sortOrder: number }>;
  /** Existing stages that matched a canonical one but need name/order/terminal/outcome fixed. */
  toUpdate: Array<{ id: string; name: string; sortOrder: number; isTerminal: boolean; terminalOutcome: "WON" | "LOST" | null }>;
  /**
   * Existing stages not in the canonical set — move their deals out, then delete.
   * `terminalOutcome` tells the applier where the deals belong: a WON-mapped
   * orphan's deals go to the canonical WON column, not the open fallback.
   */
  toRemove: Array<{ id: string; name: string; terminalOutcome: "WON" | "LOST" | null }>;
  /** The canonical stage a removed OPEN column's deals are moved into (canonical[0]). */
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
    const cOutcome = c.terminalOutcome ?? null;
    const match = existing.find((e) => !consumed.has(e.id) && key(e.name) === key(c.name));
    if (!match) {
      toCreate.push({ name: c.name, isTerminal: c.isTerminal, terminalOutcome: cOutcome, sortOrder: i });
      return;
    }
    consumed.add(match.id);
    // Only record a real change — a re-run against an already-canonical pipeline
    // produces an empty plan. Casing is normalized to the canonical exact string.
    if (
      match.name !== c.name ||
      match.sortOrder !== i ||
      match.isTerminal !== c.isTerminal ||
      (match.terminalOutcome ?? null) !== cOutcome
    ) {
      toUpdate.push({ id: match.id, name: c.name, sortOrder: i, isTerminal: c.isTerminal, terminalOutcome: cOutcome });
    }
  });

  const toRemove = existing
    .filter((e) => !consumed.has(e.id))
    .map((e) => ({ id: e.id, name: e.name, terminalOutcome: e.terminalOutcome ?? null }));

  return { toCreate, toUpdate, toRemove, fallbackStageName: canonical[0]?.name ?? "" };
}
