import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  DEFAULT_PERSON_FIELD_RULES,
  personFieldRules,
  readEventPersonFieldChoices,
  readPersonFields,
  withEventChoices,
  type PersonFieldRules,
} from "@/lib/person-fields";
import { personFieldProblems } from "@/lib/person-field-check";

/**
 * The rules a form follows for Title, Role and Specialty, read on the server
 * (Nov 13, 2026; step 2 of docs/ORG_FIELDS_PLAN.md). One small read per door.
 * With nothing saved, or no organisation, the rules are today's: Role and
 * Specialty demanded, with the same messages.
 *
 * TWO readers, and which one a door calls is not a matter of taste:
 *   - a door that belongs to an EVENT (registration, completion, group, the
 *     desk walk-in, abstract and proposal sign-up, the profile gate) asks
 *     `loadEventPersonFieldRules`, which lays the event's own choice over its
 *     organisation's. The organisation is the ceiling.
 *   - a door with no event (account sign-up, My account) asks
 *     `loadOrganizationPersonFieldRules`.
 * `person-field-doors.test.ts` names the only two doors that may use the
 * second: an event door that used it would ignore its event's choice.
 *
 * The check itself is in person-field-check.ts, which the forms share.
 */

/** The event a door acts on: its organisation, and its settings (which hold the event's own choice). */
export interface PersonFieldEvent {
  organizationId: string | null | undefined;
  settings: unknown;
}

async function readOrganizationFields(organizationId: string) {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  return readPersonFields(org?.settings);
}

/** For a door with NO event: the organisation's rules as they stand. */
export async function loadOrganizationPersonFieldRules(organizationId: string | null | undefined): Promise<PersonFieldRules> {
  if (!organizationId) return DEFAULT_PERSON_FIELD_RULES;
  try {
    return personFieldRules(await readOrganizationFields(organizationId));
  } catch (err) {
    // A sign-up must not fail because this one read did: demand what was
    // always demanded. Logged, because for an organisation that switched a
    // field off this asks for something its form does not show.
    apiLogger.error({ err, organizationId, msg: "person-field-rules:read-failed" });
    return DEFAULT_PERSON_FIELD_RULES;
  }
}

/** For a door that belongs to an event: the organisation's rules with the event's own choice laid over them. */
export async function loadEventPersonFieldRules(event: PersonFieldEvent): Promise<PersonFieldRules> {
  if (!event.organizationId) return DEFAULT_PERSON_FIELD_RULES;
  try {
    return personFieldRules(withEventChoices(await readOrganizationFields(event.organizationId), readEventPersonFieldChoices(event.settings)));
  } catch (err) {
    // As above: a registration must not fail because this one read did.
    apiLogger.error({ err, organizationId: event.organizationId, msg: "person-field-rules:read-failed" });
    return DEFAULT_PERSON_FIELD_RULES;
  }
}

/** A refusal in the shape Zod's `flatten()` gives, so a form shows it like any other field error. */
export interface PersonFieldRefusal {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
}

interface PersonFieldInput {
  title?: unknown;
  role?: unknown;
  specialty?: unknown;
  customSpecialty?: unknown;
}

/** What an event's door learns from the rules: a refusal, or the rules it passed (to drop what was not asked). */
export type PersonFieldCheck = { refusal: PersonFieldRefusal; rules: PersonFieldRules } | { refusal: null; rules: PersonFieldRules };

/**
 * An event door's whole question in one call: the rules for THIS event, and
 * the 400 to answer with when they are not met (null when they are). Asked
 * AFTER the door's own schema has passed: most public doors only learn the
 * event once they have read it.
 */
export async function checkEventPersonFields(event: PersonFieldEvent, values: PersonFieldInput, opts: { demandTitle?: boolean } = {}): Promise<PersonFieldCheck> {
  const rules = await loadEventPersonFieldRules(event);
  const problems = personFieldProblems(values, rules, opts);
  if (problems.length === 0) return { refusal: null, rules };
  const fieldErrors: Record<string, string[]> = {};
  for (const problem of problems) fieldErrors[problem.path] = [...(fieldErrors[problem.path] ?? []), problem.message];
  return { refusal: { formErrors: [], fieldErrors }, rules };
}

/** The refusal alone, for a door that only needs to know whether to answer 400. */
export async function personFieldRefusal(event: PersonFieldEvent, values: PersonFieldInput, opts: { demandTitle?: boolean } = {}): Promise<PersonFieldRefusal | null> {
  return (await checkEventPersonFields(event, values, opts)).refusal;
}
