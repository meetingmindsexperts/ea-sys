/**
 * What a card that works from one fetched list should show (Nov 23, 2026).
 *
 * A list that is not there reads as an empty array, and an empty array reads
 * as 0. On the Communications page that 0 stood for four different things:
 * none, still loading, failed to load, and not allowed. Two of them matter: a
 * card that said "0 registrations" after a failed load still offered its
 * saved-template tiles, and the send they open goes to everyone, because the
 * server works the audience out itself.
 *
 * Client-safe: pure, no React.
 */
import { httpStatusOf } from "@/lib/session-expiry";

export type ListState = "loading" | "failed" | "denied" | "ready";

/** The parts of a React Query result this reads. */
export interface ListQuery {
  data: unknown;
  isError: boolean;
  error: unknown;
}

/**
 * `access` is the answer to "may this person read the list at all", where the
 * page asks that before it asks for the list (reviewers). A list that is not
 * asked for is never "loading", so the answer has to be read here.
 *
 *  - data in hand: ready, even if a later refresh failed (what was loaded is
 *    still true enough to show, and the page refreshes it again on focus)
 *  - refused with a 403, or `access` is "denied": denied
 *  - any other error: failed
 *  - otherwise: loading. That covers fetching, waiting for a connection, and
 *    waiting to be asked for. None of them is a 0.
 */
export function listStateOf(query: ListQuery, access?: "loading" | "allowed" | "denied"): ListState {
  if (access === "denied") return "denied";
  if (query.data !== undefined) return "ready";
  if (!query.isError) return "loading";
  return httpStatusOf(query.error) === 403 ? "denied" : "failed";
}
