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

/**
 * Longest value each co-author field may hold. ONE list for the Zod schema
 * below and the inputs' maxLength in co-author-fields.tsx, so the form cannot
 * accept what the server then refuses with "Invalid input".
 */
export const CO_AUTHOR_MAX_LENGTH = {
  firstName: 100,
  lastName: 100,
  jobTitle: 200,
  organization: 255,
  country: 100,
} as const;

export const coAuthorSchema = z.object({
  firstName: z.string().trim().min(1).max(CO_AUTHOR_MAX_LENGTH.firstName),
  lastName: z.string().trim().min(1).max(CO_AUTHOR_MAX_LENGTH.lastName),
  jobTitle: z.string().trim().max(CO_AUTHOR_MAX_LENGTH.jobTitle).optional().or(z.literal("")),
  organization: z.string().trim().max(CO_AUTHOR_MAX_LENGTH.organization).optional().or(z.literal("")),
  country: z.string().trim().max(CO_AUTHOR_MAX_LENGTH.country).optional().or(z.literal("")),
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

export type CoAuthorSubmitCheck =
  | { ok: true; coAuthors: CoAuthor[] }
  | { ok: false; message: string };

/**
 * The form's check before it sends co-authors (Nov 10, 2026). A row left
 * fully blank is dropped; a row with anything typed but not BOTH names stops
 * the submit with a message naming the row as the form numbers it. Without
 * this the server's schema refused the whole abstract with "Invalid input"
 * and the author could not tell which row was at fault.
 */
export function prepareCoAuthorsForSubmit(rows: readonly CoAuthor[]): CoAuthorSubmitCheck {
  const filled = (v: unknown) => typeof v === "string" && v.trim() !== "";
  const kept: CoAuthor[] = [];
  for (const [i, row] of rows.entries()) {
    const hasFirst = filled(row.firstName);
    const hasLast = filled(row.lastName);
    const blank = !hasFirst && !hasLast && !filled(row.jobTitle) && !filled(row.organization) && !filled(row.country);
    if (blank) continue;
    if (!hasFirst || !hasLast) {
      return { ok: false, message: `Co-author ${i + 1} needs both a first name and a last name` };
    }
    kept.push(row);
  }
  return { ok: true, coAuthors: normalizeCoAuthors(kept) };
}

/** Form field names as an author reads them, for abstractErrorMessage. */
const ABSTRACT_FIELD_LABELS: Record<string, string> = {
  coAuthors: "Co-authors",
  title: "Title",
  content: "Abstract content",
  speakerId: "Speaker",
  presentationType: "Presentation type",
  trackId: "Track",
  themeId: "Theme",
  subThemeId: "Sub-theme",
  specialty: "Specialty",
};

/**
 * The message to show for a refused abstract save. A validation 400 carries
 * `details.fieldErrors` (Zod's flatten) beside the generic "Invalid input":
 * show the first of those with its field, so the author knows what to fix.
 * Anything else keeps the server's own `error`, then the fallback.
 */
export function abstractErrorMessage(body: unknown, fallback: string): string {
  const b = (body && typeof body === "object" ? body : {}) as { error?: unknown; details?: { fieldErrors?: unknown } };
  const serverMessage = typeof b.error === "string" && b.error ? b.error : fallback;
  const fieldErrors = b.details?.fieldErrors;
  if (!fieldErrors || typeof fieldErrors !== "object") return serverMessage;
  for (const [field, messages] of Object.entries(fieldErrors as Record<string, unknown>)) {
    const first = Array.isArray(messages) ? messages.find((m) => typeof m === "string" && m) : undefined;
    if (first) return `${ABSTRACT_FIELD_LABELS[field] ?? field}: ${first}`;
  }
  return serverMessage;
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
