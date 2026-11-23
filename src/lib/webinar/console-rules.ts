/**
 * Webinar Console rules that decide what the producer sees (Nov 16, 2026).
 * Pure and client-safe, so they are pinned by behaviour rather than by the
 * page's source text (review of c1b4ae83: a broken tab rule passed a test that
 * only read the source).
 */

export type ConsoleStatus = "scheduled" | "live" | "ended";

export type ConsoleTab = "setup" | "panelists" | "recording" | "qa" | "polls" | "chat" | "branding" | "settings";

/**
 * The tabs the console shows, in order. Panelists are Zoom's, so a partner's
 * webinar has none; Q&A, Polls and Chat belong to our own player (Custom
 * stream mode, or while viewer questions exist). The reports that were the
 * Analytics tab are on the event's Analytics page since Nov 23, 2026 (owner:
 * "move all analytics to one place"); the recording they sat beside is its own
 * tab, because a replay link is a setting, not a report.
 */
export function consoleTabs(a: { partner: boolean; viewerTabs: boolean }): ConsoleTab[] {
  const tabs: ConsoleTab[] = ["setup"];
  if (!a.partner) tabs.push("panelists");
  tabs.push("recording");
  if (a.viewerTabs) tabs.push("qa", "polls", "chat");
  tabs.push("branding", "settings");
  return tabs;
}

/**
 * The tab the console opens on: Recording for an ended webinar (the replay is
 * what a producer sets after the event), Setup for anything else. Asked ONCE, when the console's data first arrives. It used to
 * follow the status until the producer clicked a tab, and most never click
 * one, so closing the room (which ends the webinar) moved them to Analytics (now Recording),
 * away from "Re-open the room" (review of c1b4ae83).
 */
export function consoleOpeningTab(status: ConsoleStatus): ConsoleTab {
  return status === "ended" ? "recording" : "setup";
}

/**
 * The tab shown: the one picked, while the console still has it. A tab that
 * disappears while selected (Q&A, Polls and Chat when the viewing mode
 * changes) falls back to Setup instead of leaving an empty panel.
 */
export function consoleActiveTab(picked: string | null, visible: readonly string[]): string {
  return picked && visible.includes(picked) ? picked : "setup";
}

/**
 * Whether the closed room's button RE-opens it, which is confirmed and quiet:
 * once the room was opened and then closed after the start, which marks the
 * session COMPLETED. A room never opened by the end of its slot is a late
 * start, and keeps the ordinary "Open the room / Go live" that the overdue
 * alert tells the producer to press (review of c1b4ae83), but only while that
 * alert shows: past it (`pastLateStart`, 30 minutes after the end) the slot
 * is over, and the one-click red button is what the confirmation exists to
 * prevent (review of fbaf43f2).
 */
export function roomReopens(a: {
  roomOpen: boolean;
  ended: boolean;
  anchorStatus: string | undefined;
  pastLateStart: boolean;
}): boolean {
  if (a.roomOpen || !a.ended) return false;
  return a.anchorStatus === "COMPLETED" || a.pastLateStart;
}

/**
 * The console's status. The room decides first (Nov 5, 2026): an open room is
 * live however far past its scheduled end, so an overrun no longer flips the
 * console to "Ended" (and its header from Start as Host to Watch Replay) while
 * the webinar is on air; a room closed after the start has ended. Otherwise
 * the clock, as before.
 */
export function webinarStatusFromTimes(
  startTime: string | undefined,
  endTime: string | undefined,
  anchorStatus?: string,
): "scheduled" | "live" | "ended" {
  if (!startTime || !endTime) return "scheduled";
  const now = Date.now();
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  if (anchorStatus === "LIVE") return "live";
  if (anchorStatus === "COMPLETED" && now >= start) return "ended";
  if (now < start) return "scheduled";
  if (now >= start && now <= end) return "live";
  return "ended";
}
