// Where the floating AI Agent button goes, and when it stays off the page.
// Client-safe leaf: the launcher component reads it on every route change,
// and the test pins the rule so a new door surface cannot grow the button
// by accident.
//
// The rule (owner, Sep 21, 2026: "a floating icon on the right that opens
// the AI Agent page"):
//   - only the roles the agent admits see it (canUseAgent, the one list);
//   - on an event's pages it opens that event's agent, so the conversation
//     starts with the event already selected;
//   - it is absent on the agent pages themselves, on the door surfaces
//     (the check-in scanner and the attendee-facing kiosk, where a floating
//     control is in the way of a scan and the kiosk runs under a staff
//     session), and on the log viewer, which owns that corner already.

import { canUseAgent } from "./agent-roles";

const EVENT_PATH = /^\/events\/([^/]+)(?:\/(.*))?$/;

/** Path prefixes, relative to the event, where the button never renders. */
const HIDDEN_EVENT_SUBPATHS = ["agent", "check-in"] as const;

/** Top-level paths where the button never renders. */
const HIDDEN_PATHS = ["/agent", "/logs"] as const;

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The href the floating button should open for this person on this page,
 * or null when the button should not render at all.
 */
export function agentLauncherHref(pathname: string, role: string | null | undefined): string | null {
  if (!canUseAgent(role)) return null;

  const path = pathname.split("?")[0];
  if (HIDDEN_PATHS.some((p) => underPrefix(path, p))) return null;

  const match = path.match(EVENT_PATH);
  if (!match) return "/agent";

  const [, eventId, rest = ""] = match;
  if (eventId === "new") return "/agent";
  if (HIDDEN_EVENT_SUBPATHS.some((p) => underPrefix(rest, p))) return null;
  return `/events/${encodeURIComponent(eventId)}/agent`;
}
