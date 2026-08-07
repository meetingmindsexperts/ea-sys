import { Prisma } from "@prisma/client";

type SessionUser = {
  id: string;
  role: string;
  organizationId?: string | null;
};

export function buildEventAccessWhere(
  user: SessionUser,
  eventId?: string,
  opts?: {
    /**
     * "desk" widens the WEBINARS role's resolution to ALSO include
     * conferences it's been assigned to via Event.settings.onsiteUserIds
     * (its ONSITE-equivalent surface). Pass it ONLY from the registration-
     * desk routes (list/create/detail/check-in/badges/payments/activity).
     * The default ("manage") resolves ONLY WEBINAR-type events for that
     * role, so full-control routes fail closed on conferences. Other roles
     * ignore this flag entirely.
     */
    surface?: "manage" | "desk";
  }
): Prisma.EventWhereInput {
  if (user.role === "REVIEWER") {
    // Reviewers are org-independent — scoped only by event assignment
    return {
      ...(eventId && { id: eventId }),
      settings: {
        path: ["reviewerUserIds"],
        array_contains: user.id,
      },
    };
  }

  if (user.role === "SUBMITTER") {
    // Submitters are org-independent — scoped by Speaker.userId linkage
    return {
      ...(eventId && { id: eventId }),
      speakers: { some: { userId: user.id } },
    };
  }

  if (user.role === "REGISTRANT") {
    // Registrants are org-independent — scoped by Registration.userId linkage
    return {
      ...(eventId && { id: eventId }),
      registrations: { some: { userId: user.id } },
    };
  }

  // MEMBER: org-bound read-only viewer — same event scope as ORGANIZER
  if (user.role === "MEMBER") {
    return {
      ...(eventId && { id: eventId }),
      organizationId: user.organizationId!,
    };
  }

  // ONSITE: registration-desk staff, org-bound BUT scoped per-event via
  // Event.settings.onsiteUserIds (mirrors the REVIEWER per-event model). Sees
  // ONLY events it's been assigned to — a temp desk worker for one conference
  // no longer sees every org event. This narrows *event visibility* only; the
  // write guard (denyReviewer), finance hiding (canViewFinance), and nav
  // (proxy.ts) are unchanged. The org filter stops a leaked id from another org
  // from matching; the settings check is the per-event assignment.
  if (user.role === "ONSITE") {
    return {
      ...(eventId && { id: eventId }),
      organizationId: user.organizationId!,
      settings: { path: ["onsiteUserIds"], array_contains: user.id },
    };
  }

  // WEBINARS: the webinar team (Aug 3, 2026). Org-bound, TWO-TIER:
  //  - manage surface (default): ALL of the org's WEBINAR-type events —
  //    full-control routes pair this with `denyReviewer(..., { allow:
  //    WEBINAR_STAFF_ALLOW })`, so conferences are unreachable there.
  //  - desk surface (opt-in flag): webinars PLUS conferences assigned via the
  //    SAME Event.settings.onsiteUserIds list ONSITE uses — the registration-
  //    desk routes pass { surface: "desk" }.
  if (user.role === "WEBINARS") {
    return {
      ...(eventId && { id: eventId }),
      organizationId: user.organizationId!,
      ...(opts?.surface === "desk"
        ? {
            OR: [
              { eventType: "WEBINAR" },
              { settings: { path: ["onsiteUserIds"], array_contains: user.id } },
            ],
          }
        : { eventType: "WEBINAR" as const }),
    };
  }

  // CRM_USER: confined to the CRM. It never accesses the real event APIs — the
  // deal/report event picker uses the name-only /api/crm/events-lite instead. So
  // any event query scoped by this returns NOTHING (an impossible predicate). If a
  // CRM_USER ever reaches an event route, it gets an empty result / 404, not a leak.
  if (user.role === "CRM_USER") {
    return { id: { in: [] } };
  }

  // SUPER_ADMIN: if no org is set (or explicitly cleared), see all events
  if (user.role === "SUPER_ADMIN" && !user.organizationId) {
    return { ...(eventId && { id: eventId }) };
  }

  // Default (ADMIN / ORGANIZER): org-bound, all events in the org. (ONSITE was
  // here historically but is now scoped per-event above.)
  return {
    ...(eventId && { id: eventId }),
    organizationId: user.organizationId!,
  };
}
