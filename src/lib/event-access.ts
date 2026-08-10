import { Prisma } from "@prisma/client";

export type SessionUser = {
  id: string;
  role: string;
  organizationId?: string | null;
};

/**
 * Structural shape of `getOrgContext()`'s result — declared, not imported, so
 * this module keeps no dependency on the auth layer.
 */
type OrgContextLike = {
  organizationId: string;
  userId?: string | null;
  role?: string | null;
};

/**
 * The user to scope by on a route that accepts BOTH an org API key and a
 * signed-in session.
 *
 * Use this instead of branching. The obvious shape —
 *
 *     const where = orgCtx
 *       ? { id: eventId, organizationId: orgCtx.organizationId }   // "API key"
 *       : buildEventAccessWhere(session.user, eventId);            // "a person"
 *
 * reads as "an API key, otherwise a person", which is what it was meant to say
 * and is not what it does. `getOrgContext()` returns a context for ANY caller
 * that belongs to an organisation, a signed-in person included, so the first
 * branch swallowed everyone and the role rules in the second branch never ran.
 *
 * Neither branch was wrong on its own, which is why reading them found nothing:
 * org-scoping IS correct for a key, and the role predicate IS correct for a
 * person. The defect was in the one line that chose between them. Live effect
 * (found Aug 10, 2026): an ONSITE desk temp assigned to a single conference
 * could read every other event's agenda and full speaker roster, emails and
 * phone numbers included, while the registrations route beside it correctly
 * 404'd.
 *
 * So: no branch. One predicate, always. An API key carries no userId and no
 * role, so it lands on `buildEventAccessWhere`'s org-scoped default exactly as
 * it did before; a person carries both and is scoped by their role.
 *
 * Callers must already have rejected the "neither" case. If one slips through
 * the fallback is org-less, which matches no event — closed, not open.
 */
export function accessUserFrom(
  orgCtx: OrgContextLike | null | undefined,
  sessionUser?: SessionUser | null,
): SessionUser {
  if (orgCtx) {
    return {
      id: orgCtx.userId ?? "",
      role: orgCtx.role ?? "",
      organizationId: orgCtx.organizationId,
    };
  }
  return sessionUser ?? { id: "", role: "", organizationId: null };
}

export function buildEventAccessWhere(
  user: SessionUser,
  eventId?: string,
  opts?: {
    /**
     * "desk" widens the WEBINARS role's resolution to EVERY event in its org
     * (MEMBER parity — it is internal staff). Pass it ONLY from the events
     * list/detail and the registration-desk routes (list/create/detail/
     * check-in/badges/payments/activity), which are the routes MEMBER can
     * also reach. The default ("manage") resolves ONLY WEBINAR-type events
     * for that role, so the ~55 full-control routes that opt it in via
     * WEBINAR_STAFF_ALLOW fail closed on conferences. Other roles ignore
     * this flag entirely.
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
  //  - desk surface (opt-in flag): EVERY event in the org — MEMBER parity.
  //
  // The desk surface was org-wide-ified on Aug 10, 2026 (owner: "webinar role
  // can see all events ... as they are internal users but they see limited
  // data"). The model is now "MEMBER + full control on webinars", and it costs
  // almost nothing to express because the two roles' write guards are ALREADY
  // identical: both sit in RESTRICTED_WRITE_ROLES (writes blocked by default),
  // both in REGISTRATION_DESK_ALLOW (add registration / check-in / badge /
  // record payment), both in FINANCE_ROLES. Event scope was the only thing
  // separating them, so widening it here is the whole change.
  //
  // What did NOT change, and must not: the MANAGE surface stays WEBINAR-only.
  // ~55 route files opt this role into full control via WEBINAR_STAFF_ALLOW and
  // rely on the manage `where` to keep that control off conferences. Widening
  // the default would make every one of them fail OPEN on a conference in a
  // single edit — the exact invariant documented on WEBINAR_STAFF_ALLOW.
  //
  // Consequence worth knowing: Event.settings.onsiteUserIds no longer affects
  // this role (every org event matches regardless). The Onsite Staff tab still
  // accepts WEBINARS accounts — harmless, now redundant. ONSITE still needs it.
  if (user.role === "WEBINARS") {
    return {
      ...(eventId && { id: eventId }),
      organizationId: user.organizationId!,
      ...(opts?.surface === "desk" ? {} : { eventType: "WEBINAR" as const }),
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
