/**
 * One-off: move an organisation's budget categories from the planning buckets
 * of 14 September 2026 (VENUE, FNB, ...) to the chart-of-accounts groups
 * (500100 CME Management, ...; owner decision, 17 September 2026).
 *
 * WHY: categories are a per-organisation TABLE seeded once, so changing the
 * seed only reaches a brand-new organisation. An existing one needs this pass.
 *
 * WHAT: adds the chart groups, files every product under its account group,
 * replaces the blank lines of the seeded templates with one blank line per
 * group, and deletes the old categories. Refuses the whole organisation when
 * a budget, spend request, purchase order or not-applicable mark already uses
 * an old category (no money is ever moved by guesswork). One transaction per
 * organisation; idempotent, so a second run reports nothing to do.
 *
 * Usage (production runs inside the worker container):
 *   npx tsx scripts/realign-budget-categories.ts                 # dry run, all orgs
 *   npx tsx scripts/realign-budget-categories.ts --write         # apply
 *   npx tsx scripts/realign-budget-categories.ts --org <orgId>   # one org
 */
import { db } from "../src/lib/db";
import { runWithTenant } from "../src/lib/tenant-context";
import { realignBudgetCategories } from "../src/procurement/services/category-realignment-service";

const write = process.argv.includes("--write");
const orgArgIdx = process.argv.indexOf("--org");
const orgFilter = orgArgIdx >= 0 ? process.argv[orgArgIdx + 1] : undefined;

async function main() {
  console.log(write ? "Mode: WRITE\n" : "Mode: DRY RUN (pass --write to apply)\n");
  const orgs = await db.organization.findMany({ where: orgFilter ? { id: orgFilter } : {}, select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
  let refused = 0;
  for (const org of orgs) {
    const hasCategories = await runWithTenant(org.id, () => db.budgetCategory.count({ where: { organizationId: org.id } }));
    if (hasCategories === 0) {
      console.log(`Org "${org.name}": no categories yet (the chart seeds on first use).\n`);
      continue;
    }
    const { plan, applied, alreadyAligned } = await runWithTenant(org.id, () => realignBudgetCategories(org.id, { write }));
    console.log(`Org "${org.name}" (${org.id}):`);
    if (alreadyAligned) {
      console.log("  already on the chart of accounts.\n");
      continue;
    }
    for (const c of plan.createCategories) console.log(`  + category ${c.code} ${c.name}${c.isActive ? "" : " (archived)"}`);
    for (const u of plan.sortUpdates) console.log(`  ~ order    ${u.code} -> ${u.sortOrder}`);
    const moves = new Map<string, number>();
    for (const m of plan.productMoves) moves.set(`${m.fromCode} -> ${m.toCode}`, (moves.get(`${m.fromCode} -> ${m.toCode}`) ?? 0) + 1);
    for (const [k, n] of [...moves].sort()) console.log(`  ~ products ${k}: ${n}`);
    for (const t of plan.templateRebuilds) console.log(`  ~ template "${t.name}": ${t.removeLineIds.length} old blank lines out, ${t.addGroupCodes.length} group lines in`);
    for (const c of plan.deleteCategories) console.log(`  - category ${c.code}`);
    if (plan.blocked.length > 0) {
      refused += 1;
      console.log("  REFUSED, nothing changed:");
      for (const b of plan.blocked) console.log(`    ${b}`);
    } else if (applied) {
      console.log("  applied.");
    }
    console.log("");
  }
  if (refused > 0) process.exitCode = 2;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
