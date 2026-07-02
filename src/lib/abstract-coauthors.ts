import { z } from "zod";

/**
 * Co-authors on an abstract — contact info only (not user accounts). Stored as
 * a JSON array on `Abstract.coAuthors`. Shared by the submit/edit forms
 * (the `CoAuthor` type) and the abstract create/update API routes (the Zod
 * schema). `name` is required; everything else is optional.
 */
export const MAX_CO_AUTHORS = 20;

export const coAuthorSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  jobTitle: z.string().trim().max(200).optional().or(z.literal("")),
  organization: z.string().trim().max(255).optional().or(z.literal("")),
  country: z.string().trim().max(100).optional().or(z.literal("")),
});

export const coAuthorsSchema = z.array(coAuthorSchema).max(MAX_CO_AUTHORS);

export type CoAuthor = z.infer<typeof coAuthorSchema>;

/** Blank co-author row for the "add" button. */
export const EMPTY_CO_AUTHOR: CoAuthor = {
  firstName: "",
  lastName: "",
  jobTitle: "",
  organization: "",
  country: "",
};

/**
 * Normalize a raw co-authors value (from a form or JSON column) into a clean
 * array: drops rows missing a first + last name, trims + empty-string→undefined
 * on optional fields. Safe on unknown input (returns [] when not an array).
 */
export function normalizeCoAuthors(input: unknown): CoAuthor[] {
  if (!Array.isArray(input)) return [];
  const out: CoAuthor[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const firstName = typeof r.firstName === "string" ? r.firstName.trim() : "";
    const lastName = typeof r.lastName === "string" ? r.lastName.trim() : "";
    if (!firstName || !lastName) continue; // both name parts required
    const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    out.push({
      firstName,
      lastName,
      jobTitle: clean(r.jobTitle),
      organization: clean(r.organization),
      country: clean(r.country),
    });
  }
  return out.slice(0, MAX_CO_AUTHORS);
}
