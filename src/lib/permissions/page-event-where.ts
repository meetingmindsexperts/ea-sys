import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { requirePermission } from "./require-permission";

/**
 * Event filters for the dashboard's own server pages (custom roles Phase 6,
 * Oct 6, 2026), replacing `buildEventAccessWhere` for staff. Never a refusal:
 * a person who holds the key nowhere gets no events, and the page 404s or
 * lists nothing, as before. Reviewers, submitters and registrants keep their
 * own scoping (`linkedRoles`), which permissions do not model.
 */
function pageWhere(session: Session, key: "events.read" | "analytics.read", route: string, eventId?: string): Prisma.EventWhereInput {
  const gate = requirePermission(session, key, { route, eventId, onMissing: "hide", linkedRoles: "linked" });
  return gate.ok ? gate.eventWhere : { id: { in: [] } };
}

/**
 * The event hub (overview, setup) and the organisation's traffic analytics:
 * `analytics.read`, whose scopes are the old "manage" scoping exactly: every
 * event for staff, assigned events for Onsite, webinars for Webinars.
 */
export function hubEventWhere(session: Session, eventId: string | undefined, route: string): Prisma.EventWhereInput {
  return pageWhere(session, "analytics.read", route, eventId);
}

/** The events list: `events.read`, the old "desk" scoping (Webinars sees every event). */
export function eventListWhere(session: Session, route: string): Prisma.EventWhereInput {
  return pageWhere(session, "events.read", route);
}
