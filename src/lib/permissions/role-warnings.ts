import { describePermission } from "./catalogue";
import type { GrantScope } from "./system-roles";

/**
 * What the role editor flags before save (custom roles plan §8.3). Pure and
 * client-safe: these are warnings, not refusals, so a deliberate role can
 * still be saved; the refusals live in the service (escalation.ts,
 * separation.ts).
 *
 * Two of the plan's warnings need the database (an ASSIGNED grant on a role
 * nobody with event assignments holds; a person-grant key on a role whose
 * holders lack the person grant) and are not raised here.
 */

export interface DraftGrant {
  permission: string;
  scope: GrantScope | null;
}

export interface RoleWarning {
  code: "SENSITIVE" | "EXPORT_WITH_FIELDS" | "REFUND_WITHOUT_CREDIT_NOTE" | "DESK_WITHOUT_READ";
  message: string;
}

/** The registration desk's actions: each is useless without seeing the list. */
const DESK_KEYS = ["registrations.create", "registrations.update", "registrations.checkin", "registrations.badges.print", "payments.record"];

export function roleWarnings(grants: readonly DraftGrant[]): RoleWarning[] {
  const warnings: RoleWarning[] = [];
  const has = (key: string) => grants.some((g) => g.permission === key);
  const scopeOf = (key: string) => grants.find((g) => g.permission === key)?.scope ?? null;

  const sensitive = grants.filter((g) => describePermission(g.permission)?.sensitive);
  if (sensitive.length > 0) {
    const names = sensitive.map((g) => describePermission(g.permission)?.label ?? g.permission);
    warnings.push({
      code: "SENSITIVE",
      message: `This role can ${names.length === 1 ? "do something" : "do things"} that cannot easily be undone: ${names.join(", ")}.`,
    });
  }

  const exportsEverywhere = grants.some((g) => g.permission.endsWith(".export") && (g.scope === "ALL" || g.scope === null));
  if (exportsEverywhere && (has("finance.view") || has("barcode.view"))) {
    warnings.push({
      code: "EXPORT_WITH_FIELDS",
      message: "This role can export data and also sees money or entry barcodes, so those can leave in a file.",
    });
  }

  if (has("payments.refund") && !has("creditNotes.issue")) {
    warnings.push({
      code: "REFUND_WITHOUT_CREDIT_NOTE",
      message: `Refunding needs a credit note first, so without "${describePermission("creditNotes.issue")?.label}" this role can never finish a refund.`,
    });
  }

  const readScope = scopeOf("registrations.read");
  const deskBeyondRead = grants.find(
    (g) => DESK_KEYS.includes(g.permission) && (!has("registrations.read") || (readScope !== "ALL" && readScope !== g.scope)),
  );
  if (deskBeyondRead) {
    warnings.push({
      code: "DESK_WITHOUT_READ",
      message: `"${describePermission(deskBeyondRead.permission)?.label ?? deskBeyondRead.permission}" needs "${describePermission("registrations.read")?.label}" on the same events, or the desk has nothing to act on.`,
    });
  }

  return warnings;
}
