/**
 * Budgets (the procurement module's registrar, in-app door): the category
 * read is on both doors, the writes only here with the signed-in user as
 * the owner. Needs PROCUREMENT_MODULE_ENABLED=true in the environment the
 * app server inherits; with the flag off both tasks are skipped, not failed.
 */
import { calledBefore, mentionsAny, neverCalled, onlyWrites, T } from "./_grade";
import { EV } from "./_seed-constants";
import { expect, test } from "./_harness";

const flagOn = /^(1|true|yes|on)$/i.test(process.env.PROCUREMENT_MODULE_ENABLED ?? "");

test.skip(!flagOn, "PROCUREMENT_MODULE_ENABLED is not set; the budget tools are not registered");

test("B1 list the budget categories", async ({ golden }) => {
  const r = await golden.ask({ eventId: null, message: "What budget categories can I file event costs under? List the codes." });
  expect(neverCalled(r.steps, [T.list_budget_categories])).toEqual([T.list_budget_categories]);
  expect(r.steps.some((s) => s.tool === T.list_budget_categories && s.outcome === "RAN")).toBe(true);
  expect(onlyWrites(r.steps, [])).toEqual([]);
  expect(mentionsAny(r.reply, ["510400", "Venue"]), r.reply).toBe(true);
});

test("B2 create a budget with one venue line", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.BUDGET.id,
    message: "Create a USD budget for this event with 10% contingency, then add one line: venue hire, 20000, under the venue category.",
  });
  const budget = await golden.db.eventBudget.findFirst({
    where: { eventId: EV.BUDGET.id },
    select: { id: true, reportingCurrency: true, status: true, contingencyPercent: true },
  });
  expect(budget).not.toBeNull();
  expect(budget?.reportingCurrency).toBe("USD");
  expect(budget?.status).toBe("DRAFT");
  expect(Number(budget?.contingencyPercent)).toBe(10);
  // The model may create the budget from the org's template, which seeds
  // one zero-value line per category (the first run did exactly that).
  // Only the venue line carries an amount.
  const lines = await golden.db.budgetLine.findMany({
    where: { budgetId: budget!.id, isContingency: false },
    select: { planned: true, description: true, category: { select: { code: true } } },
  });
  const funded = lines.filter((l) => Number(l.planned) > 0);
  expect(funded, `lines with an amount: ${JSON.stringify(funded)}`).toHaveLength(1);
  expect(Number(funded[0].planned)).toBe(20000);
  expect(funded[0].category.code).toBe("510400");
  expect(funded[0].description).toMatch(/venue/i);
  expect(calledBefore(r.steps, T.list_budget_categories, T.add_budget_lines), "categories read before the line is filed").toBe(true);
  expect(onlyWrites(r.steps, [T.create_budget, T.add_budget_lines])).toEqual([]);
});
