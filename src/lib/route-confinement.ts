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

function staffRedirect(areas: readonly AreaGrant[], pathname: string): string | null {
  if (PERSONAL.some((p) => under(pathname, p))) return null;
  const has = (area: Area) => areas.some((a) => a.area === area);
  const home = homeOf(areas);
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
export function confinementRedirect(role: string | null | undefined, pathname: string): string | null {
  if (pathname.startsWith("/api/")) return null;

  // REGISTRANT: everything goes to the registration portal.
  if (role === "REGISTRANT") return pathname.startsWith("/my-registration") ? null : "/my-registration";

  // Staff: the AREAS their role works in (custom roles Phase 3, Oct 5, 2026).
  // A path outside them goes to the role's home area. Reviewers and
  // submitters are not catalogue roles and keep their own rule below.
  if (role && role !== "REVIEWER" && role !== "SUBMITTER") return staffRedirect(systemRoleFor(role)?.areas ?? [], pathname);

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
