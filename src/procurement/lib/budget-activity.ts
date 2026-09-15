/**
 * RE-EXPORT ONLY. The describer moved to `src/lib/procurement-activity.ts` on
 * Sep 15, 2026, because the org Activity page's Budget tab (core) needed the
 * same words the per-budget card (module) uses, and the eslint boundary
 * forbids core importing the module. The rationale for the move is in the
 * file's own header.
 *
 * This shim exists so nothing inside `src/procurement/` had to change its
 * import. Import from here inside the module; import from
 * `@/lib/procurement-activity` in core.
 */
export { describeProcurementActivity as describeBudgetActivity, EMPTY_DESCRIBE_CONTEXT } from "@/lib/procurement-activity";
export type {
  ProcurementActivityRow as BudgetActivityRow,
  ProcurementActivityItem as BudgetActivityItem,
  DescribeContext,
} from "@/lib/procurement-activity";
