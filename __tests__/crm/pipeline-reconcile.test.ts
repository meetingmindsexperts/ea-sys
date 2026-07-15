/**
 * Pipeline reconcile planner.
 *
 * The correctness that matters: bringing an old pipeline to the new canonical set
 * must CREATE the new columns, re-order/keep the matches, and treat everything else
 * as an orphan whose deals move to the first column — never lose a deal, and be a
 * clean no-op on a second run.
 */
import { describe, it, expect } from "vitest";
import { planPipelineReconciliation } from "@/crm/lib/pipeline-reconcile";
import { DEFAULT_PIPELINE_STAGES } from "@/crm/services/pipeline-service";

function stage(name: string, sortOrder: number, isTerminal = false) {
  return { id: `id-${name.toLowerCase().replace(/\s+/g, "-")}`, name, sortOrder, isTerminal };
}

// The old seed this feature replaces.
const OLD_SEED = [
  stage("Prospect", 0),
  stage("Contacted", 1),
  stage("Proposal", 2),
  stage("Negotiation", 3),
  stage("Won", 4, true),
  stage("Lost", 5, true),
];

describe("planPipelineReconciliation — old seed → canonical", () => {
  const plan = planPipelineReconciliation(OLD_SEED, DEFAULT_PIPELINE_STAGES);

  it("creates the new columns at their canonical positions", () => {
    expect(plan.toCreate.map((c) => c.name)).toEqual([
      "New",
      "Contract Signed",
      "Purchase Order",
      "Invoice Sent",
    ]);
    expect(plan.toCreate.find((c) => c.name === "New")?.sortOrder).toBe(0);
    expect(plan.toCreate.find((c) => c.name === "Invoice Sent")?.sortOrder).toBe(5);
  });

  it("keeps and re-orders the surviving columns (Proposal/Negotiation/Won/Lost)", () => {
    const byName = Object.fromEntries(plan.toUpdate.map((u) => [u.name, u]));
    expect(byName["Proposal"].sortOrder).toBe(1);
    expect(byName["Negotiation"].sortOrder).toBe(2);
    expect(byName["Won"]).toMatchObject({ sortOrder: 6, isTerminal: true });
    expect(byName["Lost"]).toMatchObject({ sortOrder: 7, isTerminal: true });
    // Nothing that isn't in the canonical set is "updated" — those are removed.
    expect(plan.toUpdate.map((u) => u.name).sort()).toEqual(["Lost", "Negotiation", "Proposal", "Won"]);
  });

  it("removes the dropped columns and points their deals at New", () => {
    expect(plan.toRemove.map((r) => r.name).sort()).toEqual(["Contacted", "Prospect"]);
    expect(plan.fallbackStageName).toBe("New");
  });
});

describe("planPipelineReconciliation — idempotency & edges", () => {
  it("is a clean no-op against an already-canonical pipeline", () => {
    const canonical = DEFAULT_PIPELINE_STAGES.map((s, i) => stage(s.name, i, s.isTerminal));
    const plan = planPipelineReconciliation(canonical, DEFAULT_PIPELINE_STAGES);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toRemove).toEqual([]);
  });

  it("matches case-insensitively and normalizes to the canonical casing", () => {
    const existing = [stage("new", 0), stage("won", 1, true)];
    const plan = planPipelineReconciliation(existing, DEFAULT_PIPELINE_STAGES);
    const renamed = plan.toUpdate.find((u) => u.id === "id-new");
    expect(renamed?.name).toBe("New");
    // "won" wasn't terminal in this fixture → the plan fixes both name and flag.
    expect(plan.toUpdate.find((u) => u.id === "id-won")).toMatchObject({ name: "Won", isTerminal: true });
  });

  it("treats a duplicate column as an orphan (only the first match wins)", () => {
    const existing = [stage("Proposal", 0), { ...stage("Proposal", 1), id: "dup" }];
    const plan = planPipelineReconciliation(existing, DEFAULT_PIPELINE_STAGES);
    expect(plan.toRemove.map((r) => r.id)).toContain("dup");
    // exactly one Proposal survives (as a matched/updated stage)
    expect(plan.toUpdate.filter((u) => u.name === "Proposal")).toHaveLength(1);
  });
});
