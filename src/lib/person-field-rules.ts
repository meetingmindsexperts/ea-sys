import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  DEFAULT_PERSON_FIELD_RULES,
  defaultPersonFields,
  personFieldRules,
  readEventPersonFieldChoices,
  readPersonFields,
  withEventChoices,
  answerKeyFor,
  isOfferedAnswer,
  offeredAnswers,
  type PersonFieldRules,
  type PersonFieldsConfig,
} from "@/lib/person-fields";
import { isNewlyChosenRole, personFieldProblems, roleAnswerProblem, type PersonFieldProblem } from "@/lib/person-field-check";

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

/**
 * The organisation's fields themselves (labels, answers, switches) for a
 * READER: an export, the contacts feed, a label on a page (step 1c). On a
 * failed read the answers are today's, which on master are the organisation's:
 * a label read must never fail an export.
 */
export async function loadOrganizationPersonFields(organizationId: string | null | undefined): Promise<PersonFieldsConfig> {
  if (!organizationId) return defaultPersonFields();
  try {
    return await readOrganizationFields(organizationId);
  } catch (err) {
    apiLogger.error({ err, organizationId, msg: "person-fields:read-failed" });
    return defaultPersonFields();
  }
}

/**
 * The same, for a WRITER that stores answers for good (the CSV imports): no
 * fallback. A failed read throws, so the import fails and is run again, rather
 * than reading cells against today's nine and storing keys the organisation
 * does not have (review of 5c89e2b8). A download may fall back; a write may not.
 */
export async function loadOrganizationPersonFieldsStrict(organizationId: string): Promise<PersonFieldsConfig> {
  return readOrganizationFields(organizationId);
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

/** An event door's fields (for the answers) and rules (shown, demanded), from ONE read. */
/**
 * An event door's fields and rules, from ONE read. `fields` is null when the
 * read failed: the rules still fall back to today's (a registration must not
 * fail because the "shown, demanded" read did), but the ANSWERS do not, so a
 * newly chosen Role is then refused rather than checked against a list the
 * organisation may not have (review of f2c00da9).
 */
async function loadEventFields(event: PersonFieldEvent): Promise<{ fields: PersonFieldsConfig | null; rules: PersonFieldRules }> {
  if (!event.organizationId) return { fields: defaultPersonFields(), rules: DEFAULT_PERSON_FIELD_RULES };
  const choices = readEventPersonFieldChoices(event.settings);
  try {
    const fields = await readOrganizationFields(event.organizationId);
    return { fields, rules: personFieldRules(withEventChoices(fields, choices)) };
  } catch (err) {
    // As above: the event's own choice is already in hand, so it still
    // applies, over today's rules: otherwise the route would demand a field
    // this event's form hides.
    apiLogger.error({ err, organizationId: event.organizationId, msg: "person-field-rules:read-failed" });
    return { fields: null, rules: personFieldRules(withEventChoices(defaultPersonFields(), choices)) };
  }
}

/**
 * The organisation's Role field for a WRITER that judges answers (a door, a
 * service, the agent's tools): null when it cannot be read, and the caller
 * refuses a newly chosen Role then (`roleAnswerProblem(null, ...)`). No
 * organisation means today's list. Logged once here.
 */
export async function loadRoleFieldForWrite(organizationId: string | null | undefined): Promise<PersonFieldsConfig["role"] | null> {
  if (!organizationId) return defaultPersonFields().role;
  try {
    return (await readOrganizationFields(organizationId)).role;
  } catch (err) {
    apiLogger.error({ err, organizationId, msg: "person-fields:read-failed-for-write" });
    return null;
  }
}

/** For a door that belongs to an event: the organisation's rules with the event's own choice laid over them. */
export async function loadEventPersonFieldRules(event: PersonFieldEvent): Promise<PersonFieldRules> {
  return (await loadEventFields(event)).rules;
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
export interface PersonFieldCheckOptions {
  demandTitle?: boolean;
  /** The Role the record already holds, for a door that EDITS one: kept even if retired since. */
  storedRole?: string | null;
}

function refusalOf(problems: PersonFieldProblem[]): PersonFieldRefusal | null {
  if (problems.length === 0) return null;
  const fieldErrors: Record<string, string[]> = {};
  for (const problem of problems) fieldErrors[problem.path] = [...(fieldErrors[problem.path] ?? []), problem.message];
  return { formErrors: [], fieldErrors };
}

export async function checkEventPersonFields(event: PersonFieldEvent, values: PersonFieldInput, opts: PersonFieldCheckOptions = {}): Promise<PersonFieldCheck> {
  const { fields, rules } = await loadEventFields(event);
  const answer = roleAnswerProblem(fields?.role ?? null, values.role, opts.storedRole);
  const refusal = refusalOf([...personFieldProblems(values, rules, opts), ...(answer ? [answer] : [])]);
  return refusal ? { refusal, rules } : { refusal: null, rules };
}

/** The refusal alone, for a door that only needs to know whether to answer 400. */
export async function personFieldRefusal(event: PersonFieldEvent, values: PersonFieldInput, opts: PersonFieldCheckOptions = {}): Promise<PersonFieldRefusal | null> {
  return (await checkEventPersonFields(event, values, opts)).refusal;
}

/**
 * For a door with no event to ask (a staff edit of a contact, account sign-up,
 * My account, the agent's tools): whether this Role may be stored for the
 * organisation. Null when it may. A failed read falls back to today's nine, so
 * a new answer outside them is refused rather than stored unchecked.
 */
export async function roleAnswerRefusal(organizationId: string | null | undefined, chosen: unknown, stored?: string | null): Promise<PersonFieldRefusal | null> {
  // Nothing newly chosen: no read at all.
  if (!isNewlyChosenRole(chosen, stored)) return null;
  const problem = roleAnswerProblem(await loadRoleFieldForWrite(organizationId), chosen, stored);
  return problem ? refusalOf([problem]) : null;
}

/**
 * A Role WRITTEN by a caller that creates records (the agent's and MCP's
 * tools, which write labels as often as keys): the key of an answer the
 * organisation offers now, by key or label (`answerKeyFor`), or the list to
 * say back when nothing matches (step 1c). Nothing written is no role.
 */
export async function resolveWrittenRole(
  organizationId: string | null | undefined,
  written: unknown,
): Promise<{ ok: true; key: string | null } | { ok: false; offered: string[] }> {
  if (typeof written !== "string" || written.trim() === "") return { ok: true, key: null };
  const roleField = await loadRoleFieldForWrite(organizationId);
  // Unreadable list: refuse (offered is empty; the tool says to try again).
  if (!roleField) return { ok: false, offered: [] };
  return writtenRoleOnOffer(roleField, written);
}

/**
 * A written Role matched against the answers ON OFFER only (review of
 * f2c00da9: a retired answer whose label reads like an offered key must not
 * win the match). For a caller that creates records from what it is told.
 */
export function writtenRoleOnOffer(
  roleField: PersonFieldsConfig["role"],
  written: string,
): { ok: true; key: string } | { ok: false; offered: string[] } {
  const offered = offeredAnswers(roleField).filter((o) => isOfferedAnswer(roleField, o.key));
  const key = answerKeyFor({ options: offered }, written);
  if (key) return { ok: true, key };
  return { ok: false, offered: offered.map((o) => o.label) };
}
