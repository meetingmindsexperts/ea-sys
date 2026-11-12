/**
 * The event's reviewer pool as the bulk reviewer dialogs need it: who can be
 * picked, by what name, and how many abstracts each already holds. Reads the
 * answer of GET /api/events/[id]/reviewers (the `useReviewers` hook).
 */

export interface PoolPerson {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  /** "Aisha Rahman", or the email when the account has no name. */
  name: string;
  /** Abstracts they hold on this event. */
  assigned: number;
}

interface PoolRow {
  userId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  assignments?: { assigned?: number } | null;
  assigned?: number;
}

function personFrom(row: PoolRow): PoolPerson | null {
  if (!row.userId) return null;
  const firstName = row.firstName ?? "";
  const lastName = row.lastName ?? "";
  const email = row.email ?? "";
  return {
    userId: row.userId,
    firstName,
    lastName,
    email,
    name: `${firstName} ${lastName}`.trim() || email,
    assigned: row.assignments?.assigned ?? row.assigned ?? 0,
  };
}

function peopleFrom(rows: unknown): PoolPerson[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const people: PoolPerson[] = [];
  for (const row of rows as PoolRow[]) {
    const person = personFrom(row);
    if (!person || seen.has(person.userId)) continue;
    seen.add(person.userId);
    people.push(person);
  }
  return people.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `pool`: the people a bulk assign may pick. `offPool`: people who hold
 * assignments here without being on the pool (removed from it, or assigned
 * through the agent); a bulk REMOVE may still name them.
 */
export function poolPeopleFrom(data: unknown): { pool: PoolPerson[]; offPool: PoolPerson[] } {
  const body = (data ?? {}) as { reviewers?: unknown; assignedOffPool?: unknown };
  return { pool: peopleFrom(body.reviewers), offPool: peopleFrom(body.assignedOffPool) };
}
