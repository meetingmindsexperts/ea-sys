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

export interface PersonFieldProblem {
  path: "title" | "role" | "specialty" | "customSpecialty";
  message: string;
}

/**
 * What is missing, by the rules. Pure, so the forms' own schemas can ask it
 * too. Title is demanded only where a door says so: the public doors have
 * always left it to the form, and the desk's walk-in demands it.
 */
export function personFieldProblems(values: PersonFieldValues, rules: PersonFieldRules, opts: { demandTitle?: boolean } = {}): PersonFieldProblem[] {
  const problems: PersonFieldProblem[] = [];
  if (opts.demandTitle && rules.title.required && blank(values.title)) problems.push({ path: "title", message: "Title is required" });
  if (rules.role.required && blank(values.role)) problems.push({ path: "role", message: "Role is required" });
  if (rules.specialty.required && blank(values.specialty)) problems.push({ path: "specialty", message: "Specialty is required" });
  // "Others" asks for the typed specialty beside it, wherever Specialty is asked.
  if (rules.specialty.shown && values.specialty === OTHER_ANSWER && blank(values.customSpecialty)) {
    problems.push({ path: "customSpecialty", message: "Please specify your specialty" });
  }
  return problems;
}

/** A door's schema with its organisation's demands added: the refusals come back as the schema's own field errors. */
export function withPersonFieldRules<T extends z.ZodTypeAny>(schema: T, rules: PersonFieldRules, opts: { demandTitle?: boolean } = {}) {
  return schema.superRefine((data, ctx) => {
    for (const problem of personFieldProblems((data ?? {}) as PersonFieldValues, rules, opts)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [problem.path], message: problem.message });
    }
  });
}
