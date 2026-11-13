import { z } from "zod";
import { OTHER_ANSWER, type PersonFieldRules } from "@/lib/person-fields";

/**
 * The check of Title, Role and Specialty against an organisation's rules
 * (Nov 13, 2026; step 2 of docs/ORG_FIELDS_PLAN.md). Pure and client-safe: the
 * forms build their schema with it and the server doors do the same, so a
 * form can never demand what its route does not, or the other way round.
 *
 * Until now every door wrote its own: `role: attendeeRoleEnum` and
 * `specialty: z.string().min(1)` in eight route schemas and nine forms, and
 * the rule that the answer "Others" needs the typed specialty beside it in
 * about fifteen places.
 */

interface PersonFieldValues {
  title?: unknown;
  role?: unknown;
  specialty?: unknown;
  customSpecialty?: unknown;
}

const blank = (value: unknown) => typeof value !== "string" || value.trim().length === 0;

export type PersonFieldPath = "title" | "role" | "specialty" | "customSpecialty";

export interface PersonFieldProblem {
  path: PersonFieldPath;
  message: string;
}

/** What a refusal says, per field. One wording for every form and every door. */
export const PERSON_FIELD_MESSAGES: Record<PersonFieldPath, string> = {
  title: "Title is required",
  role: "Role is required",
  specialty: "Specialty is required",
  customSpecialty: "Please specify your specialty",
};

/** Each field's own test: true when the rules are not met. */
const UNMET: Record<PersonFieldPath, (values: PersonFieldValues, rules: PersonFieldRules, opts: { demandTitle?: boolean }) => boolean> = {
  // Title is demanded only where a door says so: the public doors have always
  // left it to the form, and the desk's walk-in demands it.
  title: (values, rules, opts) => opts.demandTitle === true && rules.title.required && blank(values.title),
  role: (values, rules) => rules.role.required && blank(values.role),
  specialty: (values, rules) => rules.specialty.required && blank(values.specialty),
  // "Others" asks for the typed specialty beside it, wherever Specialty is asked.
  customSpecialty: (values, rules) => rules.specialty.shown && values.specialty === OTHER_ANSWER && blank(values.customSpecialty),
};

const PATHS = Object.keys(UNMET) as PersonFieldPath[];

/** What is missing, by the rules. Pure, so the forms that check by hand ask it too. */
export function personFieldProblems(values: PersonFieldValues, rules: PersonFieldRules, opts: { demandTitle?: boolean } = {}): PersonFieldProblem[] {
  return PATHS.filter((path) => UNMET[path](values, rules, opts)).map((path) => ({ path, message: PERSON_FIELD_MESSAGES[path] }));
}

/**
 * What a form SENDS for these fields: a field the organisation does not ask
 * goes as blank, whatever the form's state holds. A draft saved before the
 * field was switched off, or details filled in from the person's last
 * registration before the rules arrived, would otherwise be submitted and
 * stored without the person ever seeing them (review of f0899baf). For a form
 * that CREATES a record; a form that edits one re-posts what the record holds.
 */
export function blankUnaskedFields<T extends PersonFieldValues>(values: T, rules: PersonFieldRules): T {
  return {
    ...values,
    ...(!rules.title.shown && { title: "" }),
    ...(!rules.role.shown && { role: "" }),
    ...(!rules.specialty.shown && { specialty: "", customSpecialty: "" }),
  } as T;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * A door's schema with its organisation's demands added: the refusals come
 * back as the schema's own field errors.
 *
 * One refinement per field, each told to run WHATEVER ELSE FAILED (`when`).
 * Zod skips an object's refinements while any of its fields has an error, so a
 * single refinement here showed "Specialty is required" only on the second
 * press, once the terms box was ticked and every other field was valid
 * (review of f0899baf). A field that already has its own error (an answer
 * that is not on the list) keeps that one and gets no second message.
 */
export function withPersonFieldRules<T extends z.ZodTypeAny>(schema: T, rules: PersonFieldRules, opts: { demandTitle?: boolean } = {}): T {
  let refined = schema;
  for (const path of PATHS) {
    refined = refined.refine((data) => !UNMET[path]((data ?? {}) as PersonFieldValues, rules, opts), {
      path: [path],
      message: PERSON_FIELD_MESSAGES[path],
      when: (payload) => isRecord(payload.value) && !payload.issues.some((issue) => issue.path?.[0] === path),
    }) as T;
  }
  return refined;
}
