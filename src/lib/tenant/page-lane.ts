/**
 * The tenant lane for a dashboard PAGE (Event RLS step 2, Nov 17 2026).
 *
 * A route handler enters its lane by hand, after its permission gate. A server
 * page had no such line: the dashboard home, the events list, an event's
 * overview and its setup page each read Event, and the tables beside it,
 * outside any lane. With row security on, the lists came back empty and the
 * event pages answered "not found", with nothing in the logs.
 *
 * WHICH LANE. The signed-in person's own organisation's when their reach is
 * that organisation (a team role). For a reviewer, submitter or registrant,
 * the organisation the request's host names: the same rule, for the same
 * reason, as `inOwnLane` in event-tenant.ts, which this calls.
 *
 * Call it once, around everything the page loads. It needs `next/headers`, so
 * it lives apart from event-tenant.ts, which the worker imports too.
 */
import { headers } from "next/headers";
import type { Session } from "next-auth";
import { principalFromSession } from "@/lib/permissions/require-permission";
import { inOwnLane } from "@/lib/tenant/event-tenant";

export async function inSessionLane<T>(session: Session, fn: () => Promise<T>): Promise<T> {
  const host = (await headers()).get("host");
  return inOwnLane({ principal: principalFromSession(session) }, host, fn);
}
