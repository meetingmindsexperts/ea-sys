/**
 * Escape Postgres LIKE/ILIKE metacharacters so a `%` or `_` typed into a
 * search box matches literally instead of silently widening the result set.
 * Prisma's `contains` does NOT escape them (the registration-export lesson).
 * One copy, shared by every operator search route (help-chat queries, agent
 * messages), so the two cannot drift.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * "Is exactly this value, whatever its case", for a Prisma string filter.
 *
 * Prisma compiles `{ equals, mode: "insensitive" }` to ILIKE, so an underscore
 * in the value matched ANY character: an account on john_smith@x.com matched
 * john.smith@x.com, and the rule for which registrations are yours then linked
 * the other person's to it for good (review of ed074639, Nov 10, 2026; proven
 * on Postgres in tests/integration-db/email-equals-wildcard.db.test.ts).
 * Use this wherever an address or a name decides whose a record is.
 */
export function equalsIgnoringCase(value: string): { equals: string; mode: "insensitive" } {
  return { equals: escapeLike(value), mode: "insensitive" };
}
