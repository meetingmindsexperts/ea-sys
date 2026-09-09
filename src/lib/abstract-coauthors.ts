import { z } from "zod";

/**
 * Co-authors on an abstract — contact info only (not user accounts). Stored as
 * a JSON array on `Abstract.coAuthors`. Shared by the submit/edit forms
 * (the `CoAuthor` type) and the abstract create/update API routes (the Zod
 * schema). `name` is required; everything else is optional.
 *
 * How many co-authors are ALLOWED is a per-event setting, not a constant here.
 */

/**
 * Absolute ceiling on the stored array, independent of the per-event cap in
 * src/lib/abstract-limits.ts. The Zod schema is shared and static so it cannot
 * see event settings; it guards the SHAPE, and the route enforces the event's
 * own (lower) limit with a message naming the number. Keep in step with
 * CO_AUTHORS_CEILING.
 */
export const CO_AUTHORS_HARD_CEILING = 50;

export const coAuthorSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  jobTitle: z.string().trim().max(200).optional().or(z.literal("")),
  organization: z.string().trim().max(255).optional().or(z.literal("")),
  country: z.string().trim().max(100).optional().or(z.literal("")),
});

export const coAuthorsSchema = z.array(coAuthorSchema).max(CO_AUTHORS_HARD_CEILING);

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
  return out.slice(0, CO_AUTHORS_HARD_CEILING);
}

/**
 * What `{{coAuthorNames}}` prints when an abstract has no co-authors
 * (Sep 9, 2026, owner decision). "None" states the fact beside a label
 * ("Co-Author: None"); "N/A" would say the field did not apply, and it did.
 */
export const NO_CO_AUTHORS_LABEL = "None";

/**
 * The `{{coAuthorNames}}` email variable: "First Last, First Last", or
 * NO_CO_AUTHORS_LABEL when there are none. ONE implementation for the
 * automatic confirmation, the decision email, the bulk resends and the
 * preview, so they cannot disagree.
 *
 * Why not an empty string: the template renderer is plain substitution with
 * no conditionals, so an organiser who adds a "Co-Author:" row cannot hide it
 * for a sole author. Three live events had done exactly that, and about a
 * third of their confirmations showed a labelled row beside an empty cell,
 * which reads as a rendering fault. Emails only: the CSV export keeps its
 * blank cell, which is what a spreadsheet wants.
 */
export function formatCoAuthorNames(input: unknown): string {
  const names = normalizeCoAuthors(input).map((c) => `${c.firstName} ${c.lastName}`);
  return names.length > 0 ? names.join(", ") : NO_CO_AUTHORS_LABEL;
}
