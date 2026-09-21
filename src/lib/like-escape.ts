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
