/**
 * Races the real budget services against the LOCAL database (adversarial test
 * plan, Oct 28, 2026: P0-2 and P0-3). Refuses any database but the local
 * container. Mutates one DRAFT budget you name and puts back every field it
 * touched; take `npm run db:snapshot` first anyway.
 *
 *   npx tsx scripts/budget-race-check.ts <budgetId> <actorEmail> [rounds]
 *
 * P0-2  two edits of the same line at once, many rounds. Holds when every
 *       successful save moved the version exactly once and the line ends at
 *       the quantity of a save that succeeded (no lost update), and the loser
 *       of a real race got STALE_WRITE.
 * P0-3  a line edit racing the submit. Holds when, whenever the budget ends
 *       UNDER_REVIEW, its pending approval is priced at the budget's planned
 *       total as it stands (no edit slipped in after the submit priced it).
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

type Outcome = { ok: boolean; code?: string };
const brief = (r: { ok: boolean; code?: string }): Outcome => ({ ok: r.ok, ...(r.ok ? {} : { code: r.code }) });

async function main() {
  const [budgetId, actorEmail, roundsArg] = process.argv.slice(2);
  if (!budgetId || !actorEmail) throw new Error("usage: budget-race-check.ts <budgetId> <actorEmail> [rounds]");
  if (!process.env.DATABASE_URL?.includes("localhost:54322")) throw new Error("Refused: this script runs against the local database only.");
  const rounds = Number(roundsArg ?? 15);

  const { db } = await import("@/lib/db");
  const { runWithTenant } = await import("@/lib/tenant-context");
  const { upsertBudgetLine, submitBudget } = await import("@/procurement/services/budget-service");
  const { cancelPendingApprovals } = await import("@/lib/approvals/approvals-service");

  const actor = await db.user.findFirst({ where: { email: actorEmail }, select: { id: true } });
  if (!actor) throw new Error(`No user ${actorEmail}.`);
  const start = await db.eventBudget.findUnique({ where: { id: budgetId }, select: { organizationId: true, status: true, naCategoryCodes: true } });
  if (!start || start.status !== "DRAFT") throw new Error("The budget must exist and be a DRAFT.");
  const orgId = start.organizationId;
  const line = await db.budgetLine.findFirst({ where: { budgetId, deletedAt: null, isContingency: false }, orderBy: { sortOrder: "asc" }, select: { id: true, qty: true, description: true } });
  if (!line) throw new Error("The budget has no line to edit.");
  const originalQty = line.qty.toString();
  const base = { organizationId: orgId, actorUserId: actor.id, source: "ui" as const, budgetId };
  const failures: string[] = [];

  await runWithTenant(orgId, async () => {
    // ── P0-2 ──
    const tally = { bothOk: 0, oneStale: 0, other: 0 };
    for (let i = 0; i < rounds; i++) {
      const v0 = (await db.eventBudget.findUnique({ where: { id: budgetId }, select: { version: true } }))!.version;
      const qa = String(1000 + i * 2);
      const qb = String(1001 + i * 2);
      const [a, b] = (await Promise.all([
        upsertBudgetLine({ ...base, lineId: line.id, qty: qa }),
        upsertBudgetLine({ ...base, lineId: line.id, qty: qb }),
      ])).map(brief);
      const after = await db.eventBudget.findUnique({ where: { id: budgetId }, select: { version: true } });
      const now = await db.budgetLine.findUnique({ where: { id: line.id }, select: { qty: true } });
      const oks = [a.ok ? qa : null, b.ok ? qb : null].filter(Boolean) as string[];
      const moved = after!.version - v0;
      if (moved !== oks.length) failures.push(`P0-2 round ${i}: ${oks.length} save(s) succeeded but the version moved ${moved}`);
      if (!oks.includes(Number(now!.qty).toString())) failures.push(`P0-2 round ${i}: the line ended at ${now!.qty}, which no successful save wrote`);
      const stale = [a, b].filter((x) => !x.ok && x.code === "STALE_WRITE").length;
      if (oks.length === 2) tally.bothOk++;
      else if (oks.length === 1 && stale === 1) tally.oneStale++;
      else {
        tally.other++;
        failures.push(`P0-2 round ${i}: unexpected outcomes ${JSON.stringify([a, b])}`);
      }
    }
    console.log("P0-2 two edits of one line:", { rounds, ...tally, note: "bothOk = the two saves did not overlap, so both were legitimately applied in turn" });

    // ── P0-3 ── submittable for the run: uncovered categories marked not applicable, put back after.
    const cats = await db.budgetCategory.findMany({ where: { organizationId: orgId, isActive: true, type: "EXPENSE", depth: 0 }, select: { code: true } });
    await db.eventBudget.update({ where: { id: budgetId }, data: { naCategoryCodes: cats.map((c) => c.code).filter((c) => c !== "CONTINGENCY") } });
    const tallyB: Record<string, number> = {};
    for (let i = 0; i < rounds; i++) {
      const [s, e] = (await Promise.all([
        submitBudget({ ...base }),
        // A random head start for the submit, so both orders happen: edit first, and edit during or after the submit.
        new Promise<void>((r) => setTimeout(r, Math.random() * 80)).then(() => upsertBudgetLine({ ...base, lineId: line.id, qty: String(2000 + i) })),
      ])).map(brief);
      const key = `submit:${s.ok ? "ok" : s.code} edit:${e.ok ? "ok" : e.code}`;
      tallyB[key] = (tallyB[key] ?? 0) + 1;
      const b = await db.eventBudget.findUnique({ where: { id: budgetId }, select: { status: true, plannedExpenseTotal: true } });
      if (b!.status === "UNDER_REVIEW") {
        const req = await db.approvalRequest.findFirst({ where: { subjectType: "BUDGET", subjectId: budgetId, status: "PENDING" }, select: { amount: true } });
        if (!req || req.amount?.toString() !== b!.plannedExpenseTotal.toString()) {
          failures.push(`P0-3 round ${i}: under review with planned ${b!.plannedExpenseTotal} but the approval is priced at ${req?.amount ?? "nothing"}`);
        }
        // Back to a draft for the next round: the pending approval is cancelled, as a withdraw would.
        await db.$transaction(async (tx) => {
          await cancelPendingApprovals(tx, { organizationId: orgId, subjectType: "BUDGET", subjectId: budgetId, actorUserId: actor.id, source: "ui" });
          await tx.eventBudget.update({ where: { id: budgetId }, data: { status: "DRAFT", submittedAt: null } });
        });
      }
      if (!s.ok && !["STALE_WRITE", "INVALID_STATUS"].includes(s.code ?? "")) failures.push(`P0-3 round ${i}: submit failed with ${s.code}`);
    }
    console.log("P0-3 an edit racing the submit:", { rounds, outcomes: tallyB });

    // Put back what the run touched.
    await db.eventBudget.update({ where: { id: budgetId }, data: { naCategoryCodes: start.naCategoryCodes } });
    await upsertBudgetLine({ ...base, lineId: line.id, qty: originalQty });
  });

  console.log(failures.length === 0 ? "PASS: no lost update, no mispriced approval." : `FAIL (${failures.length}):\n  ${failures.join("\n  ")}`);
  await db.$disconnect();
  process.exitCode = failures.length === 0 ? 0 : 1;
}

void main();
