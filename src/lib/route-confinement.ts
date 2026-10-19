/**
 * Where a signed-in person may go in the dashboard UI: the middleware's
 * confinement as one pure function, so it can be pinned by a role-by-path
 * matrix (__tests__/lib/route-confinement.test.ts). Returns the pathname to
 * redirect to, or null to let the request through. API routes always pass:
 * each carries its own permission check, which stays the authority.
 *
 * EDGE-SAFE: imported by src/proxy.ts. No Node modules.
 */
import { systemRoleFor, type Area, type AreaGrant } from "@/lib/permissions/system-roles";

/** The paths everyone signed in keeps: their own profile and registrations. */
const PERSONAL = ["/profile", "/my-registration"];

/** A dashboard path's area. Event paths are judged in `staffRedirect`. */
const AREA_PREFIXES: [string, Area][] = [
  ["/dashboard", "dashboard"],
  ["/settings", "org"],
  ["/contacts", "org"],
  ["/agent", "org"],
  ["/invoices", "org"],
  ["/analytics", "org"],
  ["/activity", "org"],
  ["/media", "org"],
  ["/crm", "crm"],
  ["/hr", "hr"],
  ["/procurement", "procurement"],
  ["/logs", "operator"],
];

const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Where a role lands when a path is outside its areas. */
function homeOf(areas: readonly AreaGrant[]): string {
  const has = (area: Area) => areas.some((a) => a.area === area);
  if (has("dashboard")) return "/dashboard";
  if (has("events") || has("desk")) return "/events";
  if (has("crm")) return "/crm";
  if (has("hr")) return "/hr";
  if (has("procurement")) return "/procurement";
  return "/events";
}

function staffRedirect(areas: readonly AreaGrant[], pathname: string, homeAreas: readonly AreaGrant[] = areas): string | null {
  if (PERSONAL.some((p) => under(pathname, p))) return null;
  const has = (area: Area) => areas.some((a) => a.area === area);
  // Home follows the BASE role, so a salesperson whose role adds events still
  // starts in the CRM.
  const home = homeOf(homeAreas);
  // A role with no areas (an unrecognised role, CUSTOM before Phase 5) keeps
  // the events list only, which resolves to the events it may see: none.
  if (areas.length === 0) return pathname === "/events" ? null : "/events";

  const area = AREA_PREFIXES.find(([prefix]) => under(pathname, prefix))?.[1];
  if (area) return has(area) ? null : home;
  if (!under(pathname, "/events")) return null;

  // The events area: the list for anyone working events or the desk; a new
  // event and the whole workspace for the events area (its scope, such as
  // webinars only, is judged by the API: the Edge cannot read the event type);
  // the desk keeps an event's Registrations and Check-In.
  if (has("events")) return null;
  if (!has("desk")) return home;
  if (pathname === "/events") return null;
  const eventPath = pathname.match(/^\/events\/([^/]+)(?:\/(.*))?$/);
  if (!eventPath || eventPath[1] === "new") return "/events";
  const sub = eventPath[2] ?? "";
  if (under(sub, "registrations") || under(sub, "check-in")) return null;
  return `/events/${eventPath[1]}/registrations`;
}
/**
 * The per-person grants that open a module whatever the base role, exactly as
 * the module's own API does: the HR tick (`hrAccess`) opens HR, and any of the
 * legacy procurement columns or a custom procurement key opens Budgets. Without
 * them the middleware sent, say, a CRM user with a budget grant away from
 * /procurement although its API admitted them (review of 0875035c, Oct 7,
 * 2026). The other addition is `extraAreas`: the areas a held custom role
 * adds where the base role allows it (CRM User, Oct 19, 2026; key-areas.ts
 * `customGrantAreas`), filtered again here against the base role.
 */
export interface ConfinementGrants {
  hrAccess?: boolean | null;
  procurementRequest?: boolean | null;
  procurementSettle?: boolean | null;
  procurementApproveUnlimited?: boolean | null;
  procurementApproveCeilingAed?: number | null;
  procurementPermissions?: readonly string[] | null;
  /** Areas a held custom role adds beyond the base role (the session's `extraAreas`). */
  extraAreas?: readonly string[] | null;
}

function personAreas(g: ConfinementGrants | null | undefined): AreaGrant[] {
  if (!g) return [];
  const out: AreaGrant[] = [];
  if (g.hrAccess === true) out.push({ area: "hr" });
  const budgets =
    g.procurementRequest === true ||
    g.procurementSettle === true ||
    g.procurementApproveUnlimited === true ||
    (typeof g.procurementApproveCeilingAed === "number" && g.procurementApproveCeilingAed > 0) ||
    (g.procurementPermissions ?? []).some((k) => k.startsWith("procurement."));
  if (budgets) out.push({ area: "procurement" });
  return out;
}

export function confinementRedirect(role: string | null | undefined, pathname: string, grants?: ConfinementGrants | null): string | null {
  if (pathname.startsWith("/api/")) return null;

  // REGISTRANT: everything goes to the registration portal.
  if (role === "REGISTRANT") return pathname.startsWith("/my-registration") ? null : "/my-registration";

  // Staff: the AREAS their role works in (custom roles Phase 3, Oct 5, 2026).
  // A path outside them goes to the role's home area. Reviewers and
  // submitters are not catalogue roles and keep their own rule below.
  if (role && role !== "REVIEWER" && role !== "SUBMITTER") {
    const system = systemRoleFor(role);
    const base = system?.areas ?? [];
    // Person grants add a module only to a role that works somewhere already.
    // A custom role's extra areas count only where the base role lets a role
    // extend into them (a CRM User with a sponsors role opens Events).
    const extraNames = grants?.extraAreas ?? [];
    const extra = (system?.extendableAreas ?? []).filter((a) => a.area !== "org" && extraNames.includes(a.area));
    // Organisation pages open one by one ("org:/contacts"), and only where the
    // base role may be extended into the organisation area (review L4).
    if (system?.extendableAreas?.some((a) => a.area === "org")) {
      const pages = extraNames.filter((n) => n.startsWith("org:")).map((n) => n.slice(4));
      if (pages.some((page) => under(pathname, page))) return null;
    }
    return staffRedirect(base.length > 0 ? [...base, ...personAreas(grants), ...extra] : base, pathname, base);
  }

  if (!role) return null;

  // Reviewers and submitters: no dashboard, settings, logs, agent, staff
  // profile or analytics, and no new event.
  if (
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/logs") ||
    pathname.startsWith("/agent") ||
    pathname.startsWith("/profile") ||
    pathname.startsWith("/analytics")
  ) {
    return "/events";
  }
  if (pathname === "/events/new") return "/events";

  const eventPath = pathname.match(/^\/events\/[^/]+(?:\/(.*))?$/);
  if (!eventPath) return null;
  const eventSubPath = eventPath[1] ?? "";
  // Abstracts, session proposals and the neutral My Details page.
  const isSubmitterAllowedPath =
    eventSubPath === "abstracts" ||
    eventSubPath.startsWith("abstracts/") ||
    eventSubPath === "session-proposals" ||
    eventSubPath.startsWith("session-proposals/") ||
    eventSubPath === "my-details";
  if (isSubmitterAllowedPath) return null;
  return `${pathname.split("/").slice(0, 3).join("/")}/abstracts`;
}
