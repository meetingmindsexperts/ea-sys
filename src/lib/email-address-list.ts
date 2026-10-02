/**
 * A typed list of email addresses ("a@x.com, b@y.com; c@z.com"), split on
 * commas, semicolons or spaces. Shared by the CC fields on the speaker email
 * screens and the bulk email dialog (Oct 2, 2026). Client-safe.
 */
import { z } from "zod";

// The same check the routes apply (`z.string().email()`), so the form never
// passes an address the server then refuses with a vague 400.
const emailSchema = z.string().email();

export function parseEmailList(input: string): { valid: string[]; invalid: string[] } {
  const tokens = input.split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!emailSchema.safeParse(token).success) {
      invalid.push(token);
      continue;
    }
    const lower = token.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    valid.push(lower);
  }
  return { valid, invalid };
}

/** The largest number of manual CC addresses one send accepts (form and routes). */
export const MAX_MANUAL_CC = 10;
