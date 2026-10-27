/**
 * Plan owner assignments for CRM accounts and contacts from Freshsales'
 * "Sales owner" (Oct 27, 2026). Rows come from
 * scripts/data/freshsales-owners-*.csv (Type, Freshsales id, Sales owner).
 *
 * Owner rulings (Oct 27, 2026): Freshsales wins, so an existing different owner
 * is replaced and reported; an owner name that matches no CRM-capable user
 * (Lina Alaa Eldin has no EA-SYS account yet) is skipped and counted, never
 * guessed, so a later re-run picks those up once the user exists.
 *
 * Pure: the caller resolves ids and names and applies the plan.
 */

export type OwnerRecordType = "account" | "contact";

export interface OwnerRow {
  type: OwnerRecordType;
  externalId: string;
  ownerName: string;
}

export interface OwnerPlan {
  writes: Array<{ id: string; ownerId: string; previousOwnerId: string | null }>;
  alreadyOwned: number;
  /** Owner name → how many rows named an owner with no matching user. */
  unmatchedOwners: Map<string, number>;
  missingRecords: number;
}

export function readOwnerRows(headers: string[], rows: string[][]): OwnerRow[] | { error: string } {
  const key = (h: string) => h.toLowerCase().replace(/[^a-z]/g, "");
  const idx = (name: string) => headers.findIndex((h) => key(h) === name);
  const type = idx("type");
  const id = idx("freshsalesid");
  const owner = idx("salesowner");
  if (type < 0 || id < 0 || owner < 0) return { error: "Expected columns: Type, Freshsales id, Sales owner" };
  const out: OwnerRow[] = [];
  for (const r of rows) {
    const t = (r[type] ?? "").trim().toLowerCase();
    const externalId = (r[id] ?? "").trim();
    const ownerName = (r[owner] ?? "").trim();
    if ((t !== "account" && t !== "contact") || !externalId || !ownerName) continue;
    out.push({ type: t, externalId, ownerName });
  }
  return out;
}

export function planOwnerAssignments(
  rows: OwnerRow[],
  records: Map<string, { id: string; ownerId: string | null }>,
  resolveOwner: (name: string) => string | null,
): OwnerPlan {
  const plan: OwnerPlan = { writes: [], alreadyOwned: 0, unmatchedOwners: new Map(), missingRecords: 0 };
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.externalId)) continue; // a repeated row is not a second write
    seen.add(r.externalId);
    const record = records.get(r.externalId);
    if (!record) {
      plan.missingRecords++;
      continue;
    }
    const ownerId = resolveOwner(r.ownerName);
    if (!ownerId) {
      plan.unmatchedOwners.set(r.ownerName, (plan.unmatchedOwners.get(r.ownerName) ?? 0) + 1);
      continue;
    }
    if (record.ownerId === ownerId) {
      plan.alreadyOwned++;
      continue;
    }
    plan.writes.push({ id: record.id, ownerId, previousOwnerId: record.ownerId });
  }
  return plan;
}
