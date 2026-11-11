/**
 * Does this caller hold a permission ON THIS EVENT? For the route or tool that
 * has already been admitted by one key and must ask a SECOND one before it
 * goes further (Nov 11, 2026):
 *
 *   - sending certificates now, on top of assigning them
 *     (certificates.issue, src/lib/certificates/release-permission.ts);
 *   - listing everyone at an event on the certificate Recipients tab, on top
 *     of reading certificates (registrations.read / speakers.read).
 *
 * `requirePermission` answers the first key and builds the event filter; this
 * answers a further key against the same event's facts (its type, its
 * assigned staff), so a grant scoped to assigned events or to webinars is
 * judged the way the route's own lookup would judge it.
 *
 * No principal (a door that cannot say who is calling) is a no, and so is an
 * event the organisation does not have: fail closed.
 */

import { loadEventFacts } from "@/lib/agent/event-facts-loader";
import { can, type Principal } from "./can";
import type { PermissionKey } from "./catalogue";

export async function holdsOnEvent(
  principal: Principal | null | undefined,
  permission: PermissionKey,
  eventId: string,
  organizationId: string,
): Promise<boolean> {
  if (!principal || !can(principal, permission)) return false;
  const facts = await loadEventFacts(eventId, organizationId);
  return facts !== null && can(principal, permission, { event: facts });
}
