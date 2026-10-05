/**
 * Which screen manages a custom role (owner, Oct 5, 2026: Budgets roles and
 * custom roles in two separate dialogs). Pure and client-safe.
 *
 *  - "procurement": every key is a Budgets key. Managed under Budgets roles
 *    and assigned from a person's Procurement access.
 *  - "custom": no Budgets key. Managed under Custom roles and assigned from a
 *    person's Roles.
 *  - "mixed": both (only possible from before the split). Shown with the
 *    custom roles, and its editor lists every key so saving drops nothing.
 */
export type RoleKind = "procurement" | "custom" | "mixed";

export function isProcurementKey(key: string): boolean {
  return key.startsWith("procurement.");
}

export function roleKind(keys: readonly string[]): RoleKind {
  const procurement = keys.filter(isProcurementKey).length;
  if (procurement === 0) return "custom";
  return procurement === keys.length ? "procurement" : "mixed";
}
