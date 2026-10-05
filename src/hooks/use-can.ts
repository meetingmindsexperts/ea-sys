"use client";

import { useSession } from "next-auth/react";
import { useEvent } from "@/hooks/use-api";
import { httpStatusOf } from "@/lib/session-expiry";
import { can, principalFromUser } from "@/lib/permissions/can";
import { eventFactsOf } from "@/lib/permissions/event-facts";
import type { PermissionKey } from "@/lib/permissions/catalogue";

export type CanStatus = "loading" | "allowed" | "denied";

/**
 * May the signed-in person do `permission`, on this event when one is given?
 * The screens ask the same `can()` the routes ask (custom roles Phase 3), from
 * the same principal (`principalFromUser`), so a page can refuse before it
 * fetches instead of rendering a 403 as an empty list or a spinner.
 *
 * Advisory only: the route stays the authority. With an event, the answer
 * waits for the event: an event the person cannot open (404 or 403) is
 * "denied", and its scope (webinar only, assigned only) is judged from the
 * event's own facts.
 */
export function useCan(permission: PermissionKey, eventId?: string): CanStatus {
  const { data: session, status } = useSession();
  const event = useEvent(eventId ?? "");

  if (status === "loading") return "loading";
  if (!session?.user) return "denied";
  const p = principalFromUser(session.user);

  if (!eventId) return can(p, permission) ? "allowed" : "denied";

  if (event.isLoading) return "loading";
  if (event.error) {
    const code = httpStatusOf(event.error);
    // A 5xx is not an answer about access: let the page show its own error.
    return code === 403 || code === 404 ? "denied" : "allowed";
  }
  return can(p, permission, { event: eventFactsOf(event.data) }) ? "allowed" : "denied";
}

export { eventFactsOf } from "@/lib/permissions/event-facts";
