/**
 * THE RULES THAT MUST SURVIVE COMBINING ROLES (plan §4).
 *
 * A person's capability is the UNION of the roles tagged on them (D2), so a
 * pair of permissions that must never be held together cannot be prevented by
 * checking one role at a time: two individually-sensible roles combine into a
 * person who approves their own purchase. The check therefore runs on the
 * RESULTING picture, at all three doors that can create it — assigning roles to
 * a person, editing a role that people already hold, and changing the AED
 * authority on a person.
 *
 * PURE AND CLIENT-SAFE, so the role editor can warn while the admin is ticking
 * boxes and the routes can refuse with the same words. One implementation: a
 * second copy is how the UI and the boundary end up disagreeing about what is
 * allowed, and the boundary is the one that matters.
 *
 * IT READS THE LEGACY COLUMNS TOO. Until §10a's flip, `procurementRequest` and
 * `procurementSettle` still grant access on their own, so a person holding the
 * old switch and a new role is exactly as conflicted as one holding two roles.
 * When those columns are retired (build order step 5) the two fields go with
 * them and the rules stay as they are.
 */

export interface SeparationSubject {
  /** The union of permission keys across the roles in question. */
  permissions: readonly string[];
  /**
   * Does this person decide without a ceiling? A ROLE carries no authority of
   * its own (D3 keeps the amount on the person), so the role editor leaves this
   * undefined and only the person-level rules apply where it is known.
   */
  approvalUnlimited?: boolean | null;
  /** Legacy `User.procurementRequest`, still load-bearing before the flip. */
  legacyRequest?: boolean | null;
  /** Legacy `User.procurementSettle`, likewise. */
  legacySettle?: boolean | null;
}

export interface SeparationConflict {
  code: "FINAL_APPROVER_CANNOT_REQUEST" | "SETTLE_CANNOT_DECIDE";
  /** Shown verbatim to the administrator, so it says what to do about it. */
  message: string;
}

const REQUESTS_CREATE = "procurement.requests.create";
const APPROVALS_DECIDE = "procurement.approvals.decide";
const BUDGETS_SIGNOFF = "procurement.budgets.signoff";

/**
 * Every rule this combination breaks, empty when it breaks none.
 *
 * Returns a LIST rather than the first failure so the administrator fixes one
 * thing and sees the rest, instead of discovering them one save at a time.
 */
export function separationConflicts(subject: SeparationSubject): SeparationConflict[] {
  const has = (key: string) => subject.permissions.includes(key);
  const conflicts: SeparationConflict[] = [];

  // Rule 1 (spec §8.8): the final approver never raises requests, or a request
  // would arrive in its own author's inbox with nobody above them to take it.
  if (subject.approvalUnlimited === true && (has(REQUESTS_CREATE) || subject.legacyRequest === true)) {
    conflicts.push({
      code: "FINAL_APPROVER_CANNOT_REQUEST",
      message:
        "The final approver cannot also raise purchase requests: their own request would have no approver. Remove the raising permission, or lower their approval authority to a ceiling.",
    });
  }

  // Rule 2 (spec §4): settle checks and signs off what others decided. One
  // person doing both is the approval and the sign-off in the same pair of
  // hands, which is the separation the module exists to keep.
  if ((has(BUDGETS_SIGNOFF) || subject.legacySettle === true) && has(APPROVALS_DECIDE)) {
    conflicts.push({
      code: "SETTLE_CANNOT_DECIDE",
      message:
        "Signing off a closed budget and approving cannot be held by the same person. Split them across two people, or across two roles held by different people.",
    });
  }

  return conflicts;
}

/** The union of permission keys across several roles, deduplicated. */
export function unionPermissions(sets: readonly { permissions: readonly { permission: string }[] }[]): string[] {
  const keys = new Set<string>();
  for (const set of sets) for (const { permission } of set.permissions) keys.add(permission);
  return [...keys];
}
