import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { DEFAULT_PERSON_FIELD_RULES, personFieldRules, readPersonFields, type PersonFieldRules } from "@/lib/person-fields";
import { personFieldProblems } from "@/lib/person-field-check";

/**
 * The rules an organisation's forms follow, read on the server (Nov 13, 2026;
 * step 2 of docs/ORG_FIELDS_PLAN.md). One small read per door. With nothing
 * saved, or no organisation, the rules are today's: Role and Specialty
 * demanded, with the same messages.
 *
 * The check itself is in person-field-check.ts, which the forms share.
 */
export async function loadPersonFieldRules(organizationId: string | null | undefined): Promise<PersonFieldRules> {
  if (!organizationId) return DEFAULT_PERSON_FIELD_RULES;
  try {
    const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
    return personFieldRules(readPersonFields(org?.settings));
  } catch (err) {
    // A registration must not fail because this one read did: demand what was
    // always demanded. Logged, because for an organisation that switched a
    // field off this asks for something its form does not show.
    apiLogger.error({ err, organizationId, msg: "person-field-rules:read-failed" });
    return DEFAULT_PERSON_FIELD_RULES;
  }
}

/** A refusal in the shape Zod's `flatten()` gives, so a form shows it like any other field error. */
export interface PersonFieldRefusal {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
}

/**
 * What a door answers 400 with when the organisation's rules are not met, or
 * null when they are. Asked AFTER the door's own schema has passed: most
 * public doors only learn the organisation once they have read the event.
 */
export async function personFieldRefusal(
  organizationId: string | null | undefined,
  values: { title?: unknown; role?: unknown; specialty?: unknown; customSpecialty?: unknown },
  opts: { demandTitle?: boolean } = {},
): Promise<PersonFieldRefusal | null> {
  const problems = personFieldProblems(values, await loadPersonFieldRules(organizationId), opts);
  if (problems.length === 0) return null;
  const fieldErrors: Record<string, string[]> = {};
  for (const problem of problems) fieldErrors[problem.path] = [...(fieldErrors[problem.path] ?? []), problem.message];
  return { formErrors: [], fieldErrors };
}
