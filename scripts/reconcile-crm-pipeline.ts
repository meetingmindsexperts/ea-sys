/**
 * One-off: bring an org's CRM pipeline to the canonical seed
 * (DEFAULT_PIPELINE_STAGES) after the stage list changed.
 *
 * WHY: the pipeline is a per-org TABLE and `ensurePipelineStages` deliberately
 * never mutates an org that already has stages (resurrecting a deleted column on
 * every board load would be maddening). So changing DEFAULT_PIPELINE_STAGES only
 * affects brand-new orgs — an existing org needs this reconcile to actually see the
 * new columns.
 *
 * HOW: `planPipelineReconciliation` (pure, unit-tested) matches existing stages to
 * canonical by name, CREATES the missing ones, fixes name/order/terminal on the
 * matches, and treats the rest as ORPHANS. A deal never vanishes: an orphan
 * column's deals are moved to the fallback (the first canonical stage, "New")
 * BEFORE the column is deleted. Idempotent — a second run is a clean no-op.
 *
 * Usage:
 *   npx tsx scripts/reconcile-crm-pipeline.ts                 # dry run (all orgs)
 *   npx tsx scripts/reconcile-crm-pipeline.ts --write         # apply (all orgs)
 *   npx tsx scripts/reconcile-crm-pipeline.ts --org <orgId>   # scope to one org
 *   npx tsx scripts/reconcile-crm-pipeline.ts --write --org <orgId>
 */
import { db } from "../src/lib/db";
import { DEFAULT_PIPELINE_STAGES } from "../src/crm/services/pipeline-service";
import { planPipelineReconciliation } from "../src/crm/lib/pipeline-reconcile";

const write = process.argv.includes("--write");
const orgArgIdx = process.argv.indexOf("--org");
const orgFilter = orgArgIdx >= 0 ? process.argv[orgArgIdx + 1] : undefined;

async function main() {
  console.log(write ? "Mode: WRITE\n" : "Mode: DRY RUN (pass --write to apply)\n");
  console.log("Canonical pipeline:");
  console.log("  " + DEFAULT_PIPELINE_STAGES.map((s) => s.name + (s.isTerminal ? " (terminal)" : "")).join(" → "));
  console.log("");

  const orgs = await db.organization.findMany({
    where: orgFilter ? { id: orgFilter } : {},
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  let orgsChanged = 0;
  let orgsAlreadyCanonical = 0;
  let orgsWithoutPipeline = 0;
  let totalDealsMoved = 0;

  for (const org of orgs) {
    const existing = await db.crmPipelineStage.findMany({
      where: { organizationId: org.id },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, sortOrder: true, isTerminal: true, terminalOutcome: true },
    });

    // An org that never opened the CRM has no pipeline yet — nothing to reconcile
    // (it'll seed the canonical set on first board load).
    if (existing.length === 0) {
      orgsWithoutPipeline++;
      continue;
    }

    const plan = planPipelineReconciliation(existing, DEFAULT_PIPELINE_STAGES);
    const nothingToDo = plan.toCreate.length === 0 && plan.toUpdate.length === 0 && plan.toRemove.length === 0;
    if (nothingToDo) {
      orgsAlreadyCanonical++;
      continue;
    }

    orgsChanged++;
    console.log(`Org "${org.name}" (${org.id}):`);
    console.log("  current:  " + existing.map((s) => s.name).join(" → "));
    for (const c of plan.toCreate) console.log(`  + create  ${c.name} @${c.sortOrder}${c.isTerminal ? " (terminal)" : ""}`);
    for (const u of plan.toUpdate) console.log(`  ~ update  ${u.name} → order ${u.sortOrder}${u.isTerminal ? " (terminal)" : ""}`);

    // Count the deals each orphan holds so the report shows what would move.
    let orgDealsToMove = 0;
    for (const r of plan.toRemove) {
      const dealCount = await db.crmDeal.count({ where: { stageId: r.id } });
      orgDealsToMove += dealCount;
      // A terminal orphan's deals belong in the matching canonical terminal column,
      // not the open fallback — a WON deal landing in "New" would be the exact
      // stage/status divergence the runtime code prevents (CRM review L5).
      const dest = r.terminalOutcome
        ? DEFAULT_PIPELINE_STAGES.find((c) => c.terminalOutcome === r.terminalOutcome)?.name ?? plan.fallbackStageName
        : plan.fallbackStageName;
      console.log(
        `  - remove  ${r.name}${dealCount ? ` (moves ${dealCount} deal${dealCount === 1 ? "" : "s"} → ${dest})` : " (empty)"}`,
      );
    }

    if (write) {
      const moved = await db.$transaction(async (tx) => {
        if (plan.toCreate.length > 0) {
          await tx.crmPipelineStage.createMany({
            data: plan.toCreate.map((c) => ({
              organizationId: org.id,
              name: c.name,
              sortOrder: c.sortOrder,
              isTerminal: c.isTerminal,
              terminalOutcome: c.terminalOutcome,
            })),
            // @@unique([organizationId, name]) backstops a stage created
            // concurrently (live board use during --write) colliding by name.
            skipDuplicates: true,
          });
        }
        for (const u of plan.toUpdate) {
          await tx.crmPipelineStage.update({
            where: { id: u.id },
            data: { name: u.name, sortOrder: u.sortOrder, isTerminal: u.isTerminal, terminalOutcome: u.terminalOutcome },
          });
        }

        // The fallback ("New") is canonical[0] — never an orphan, so it exists now
        // (created above or matched). Deals from removed OPEN columns land here;
        // deals from a terminal orphan land in the canonical column with the SAME
        // outcome, so a WON deal never surfaces in an open column (CRM review L5).
        const fallback = await tx.crmPipelineStage.findFirst({
          where: { organizationId: org.id, name: plan.fallbackStageName },
          select: { id: true },
        });
        if (!fallback) throw new Error(`fallback stage "${plan.fallbackStageName}" missing after reconcile`);

        let dealsMoved = 0;
        for (const r of plan.toRemove) {
          let destId = fallback.id;
          if (r.terminalOutcome) {
            const terminalDest = await tx.crmPipelineStage.findFirst({
              where: { organizationId: org.id, terminalOutcome: r.terminalOutcome, id: { not: r.id } },
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              select: { id: true },
            });
            destId = terminalDest?.id ?? fallback.id;
          }
          const res = await tx.crmDeal.updateMany({ where: { stageId: r.id }, data: { stageId: destId } });
          dealsMoved += res.count;
          await tx.crmPipelineStage.delete({ where: { id: r.id } });
        }
        return dealsMoved;
      });
      totalDealsMoved += moved;
      console.log(`  ✓ applied${moved ? ` (${moved} deal${moved === 1 ? "" : "s"} moved)` : ""}`);
    } else {
      totalDealsMoved += orgDealsToMove;
    }
    console.log("");
  }

  console.log("─".repeat(60));
  console.log(`Orgs scanned:            ${orgs.length}`);
  console.log(`Orgs already canonical:  ${orgsAlreadyCanonical}`);
  console.log(`Orgs without a pipeline: ${orgsWithoutPipeline}`);
  console.log(
    write
      ? `Orgs reconciled:         ${orgsChanged} (${totalDealsMoved} deals moved)`
      : `Orgs needing reconcile:  ${orgsChanged} (would move ${totalDealsMoved} deals) — re-run with --write to apply`,
  );
}

main()
  .catch((err) => {
    console.error("reconcile-crm-pipeline failed:", err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
