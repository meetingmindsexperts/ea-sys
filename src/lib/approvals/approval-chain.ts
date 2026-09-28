/**
 * The spend-request approval chain (owner, 28 September 2026): a request
 * passes named people in order, level 1, level 2, optionally level 3, then
 * the final approver, whatever the amount and whether or not it is over
 * budget. One chain per organisation, set by the super admin on Settings,
 * Roles. Budgets and reallocations do not use it; they keep the ceiling
 * routing in approvals-service.ts.
 *
 * The final level has an optional STAND-IN, who may decide any request
 * waiting on the final approver at any time (owner: "when Medhat is busy,
 * Muthu approves"). The stand-in may hold the settle grant, which elsewhere
 * never decides; the separation the settle rule protects is kept per
 * purchase instead: nobody signs off (confirms a receipt, signs off a
 * budget) a purchase they approved. See `approvedSpendRequestBy` callers.
 *
 * A request carries a SNAPSHOT of the chain taken at submit, so editing the
 * chain never reroutes a request already in flight. Pure: no database here.
 */

export const APPROVAL_CHAIN_KEY = "approvalChain";
export const CHAIN_MIN_LEVELS = 2;
export const CHAIN_MAX_LEVELS = 4;

/** What the super admin saves: the people in order, the last one the final approver. */
export interface ApprovalChainConfig {
  levels: string[];
  standInUserId: string | null;
}

/** What a request carries: the chain as it applies to this requester. */
export interface ChainSnapshot {
  levels: string[];
  /** Stands in for the LAST level only; null when there is none, or the requester is the stand-in. */
  standInUserId: string | null;
}

export function readChainSnapshot(payload: unknown): ChainSnapshot | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>)[APPROVAL_CHAIN_KEY] as Partial<ChainSnapshot> | undefined;
  if (!raw || !Array.isArray(raw.levels) || raw.levels.length === 0 || !raw.levels.every((l) => typeof l === "string")) return null;
  return { levels: raw.levels, standInUserId: typeof raw.standInUserId === "string" ? raw.standInUserId : null };
}

/**
 * The chain for one requester. Their own level is dropped, because nobody
 * approves their own request. The stand-in is kept only while the final
 * level is still the configured final approver: if the requester IS the
 * final approver, the stand-in takes that level outright. Null when nobody
 * is left to decide.
 */
export function snapshotForRequester(config: ApprovalChainConfig, requesterUserId: string): ChainSnapshot | null {
  const finalId = config.levels[config.levels.length - 1];
  const levels = config.levels.filter((id) => id !== requesterUserId);
  const standIn = config.standInUserId && config.standInUserId !== requesterUserId && !levels.includes(config.standInUserId) ? config.standInUserId : null;
  if (finalId === requesterUserId) {
    // Nobody else may decide the last level, so there is no chain to walk.
    if (!standIn) return null;
    // The stand-in holds the final level as its assignee AND its stand-in, so
    // they decide it on the stand-in's authority, not an unlimited grant.
    return { levels: [...levels, standIn], standInUserId: standIn };
  }
  return levels.length > 0 ? { levels, standInUserId: standIn } : null;
}

/** The stand-in who may decide at this level, or null (only the final level has one). */
export function standInAt(snapshot: ChainSnapshot, levelIndex: number): string | null {
  return levelIndex === snapshot.levels.length - 1 ? snapshot.standInUserId : null;
}

export type ChainRefusal =
  | "NOT_ASSIGNEE"
  | "SETTLE_CANNOT_DECIDE"
  | "INSUFFICIENT_AUTHORITY"
  | "ALREADY_APPROVED_EARLIER";

/**
 * May this person decide this level? The chain is the authority for WHO,
 * so the AED ceiling does not limit the amount; what is still required:
 * a level is decided by its person (or the delegate the reminder job named),
 * that person still holds approval access, the final level still needs the
 * unlimited approver, the settle grant never decides except as the named
 * stand-in, and nobody approves the same request at two levels.
 */
export function judgeChainDecider(input: {
  snapshot: ChainSnapshot;
  levelIndex: number;
  step: { assigneeUserId: string; delegateUserId: string | null };
  deciderId: string;
  /** From the ROW at decision time: null ceiling = no approval access; Infinity = unlimited. */
  deciderCeilingAed: number | null;
  deciderSettles: boolean;
  earlierApproverIds: string[];
}): { ok: true; asStandIn: boolean } | { ok: false; code: ChainRefusal; message: string } {
  if (input.earlierApproverIds.includes(input.deciderId)) {
    return { ok: false, code: "ALREADY_APPROVED_EARLIER", message: "You approved this request at an earlier level; the next level must be someone else." };
  }
  const isFinal = input.levelIndex === input.snapshot.levels.length - 1;
  const standIn = standInAt(input.snapshot, input.levelIndex);
  if (standIn && input.deciderId === standIn && input.step.delegateUserId === standIn) return { ok: true, asStandIn: true };
  if (input.deciderId !== input.step.assigneeUserId && input.deciderId !== input.step.delegateUserId) {
    return { ok: false, code: "NOT_ASSIGNEE", message: "This level is assigned to someone else." };
  }
  // A delegate who holds another level of this chain approves at that level, not this one.
  if (input.deciderId !== input.step.assigneeUserId && input.snapshot.levels.includes(input.deciderId)) {
    return { ok: false, code: "NOT_ASSIGNEE", message: "You approve this request at your own level of the chain, not in someone else's place." };
  }
  if (input.deciderSettles) return { ok: false, code: "SETTLE_CANNOT_DECIDE", message: "The settle grant checks and signs off; it decides only as the final approver's stand-in." };
  if (input.deciderCeilingAed === null) return { ok: false, code: "INSUFFICIENT_AUTHORITY", message: "You no longer hold approval access." };
  if (isFinal && input.deciderCeilingAed !== Number.POSITIVE_INFINITY) {
    return { ok: false, code: "INSUFFICIENT_AUTHORITY", message: "The last level is decided by the final approver or their stand-in." };
  }
  return { ok: true, asStandIn: false };
}

export interface ChainPerson {
  id: string;
  name: string;
  role: string;
  active: boolean;
  /** null = no approval access; Infinity = unlimited. */
  ceilingAed: number | null;
  settles: boolean;
}

export type ChainConfigError =
  | "TOO_FEW_LEVELS"
  | "TOO_MANY_LEVELS"
  | "DUPLICATE_PERSON"
  | "UNKNOWN_PERSON"
  | "SUPER_ADMIN_IN_CHAIN"
  | "LEVEL_NOT_APPROVER"
  | "LEVEL_HOLDS_SETTLE"
  | "FINAL_NOT_UNLIMITED"
  | "STAND_IN_IS_LEVEL";

/** The save rules, shared by the settings card (to explain) and the API (to refuse). */
export function validateChainConfig(config: ApprovalChainConfig, people: ChainPerson[]): { ok: true } | { ok: false; code: ChainConfigError; message: string } {
  const byId = new Map(people.map((p) => [p.id, p]));
  const n = config.levels.length;
  if (n < CHAIN_MIN_LEVELS) return { ok: false, code: "TOO_FEW_LEVELS", message: `The chain needs at least ${CHAIN_MIN_LEVELS} levels, the last being the final approver.` };
  if (n > CHAIN_MAX_LEVELS) return { ok: false, code: "TOO_MANY_LEVELS", message: `The chain has at most ${CHAIN_MAX_LEVELS} levels.` };
  if (new Set(config.levels).size !== n) return { ok: false, code: "DUPLICATE_PERSON", message: "Each level must be a different person." };
  const everyone = [...config.levels, ...(config.standInUserId ? [config.standInUserId] : [])];
  for (const id of everyone) {
    const p = byId.get(id);
    if (!p || !p.active) return { ok: false, code: "UNKNOWN_PERSON", message: "Someone in the chain is not an active member of the organisation." };
    // The super admin sets grants and the chain, so they never approve (standing rule).
    if (p.role === "SUPER_ADMIN") return { ok: false, code: "SUPER_ADMIN_IN_CHAIN", message: `${p.name} is a super admin, who sets approvals and never approves.` };
  }
  for (const [i, id] of config.levels.entries()) {
    const p = byId.get(id)!;
    if (p.settles) return { ok: false, code: "LEVEL_HOLDS_SETTLE", message: `${p.name} holds finance sign-off, so they can only be the final approver's stand-in, not a level.` };
    if (p.ceilingAed === null) return { ok: false, code: "LEVEL_NOT_APPROVER", message: `${p.name} has no approval access. Give them an approval limit first.` };
    if (i === n - 1 && p.ceilingAed !== Number.POSITIVE_INFINITY) return { ok: false, code: "FINAL_NOT_UNLIMITED", message: `The last level is the final approver, and ${p.name} does not hold unlimited approval.` };
  }
  if (config.standInUserId && config.levels.includes(config.standInUserId)) {
    return { ok: false, code: "STAND_IN_IS_LEVEL", message: "The stand-in cannot also be a level, or one person would approve the same request twice." };
  }
  return { ok: true };
}
