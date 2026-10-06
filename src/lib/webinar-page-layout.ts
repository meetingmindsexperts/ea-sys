/**
 * The webinar attendee page's video tab: panelists on the left (272 px), video
 * in the middle, Q&A on the right (340 px; 292 px on a laptop) (owner,
 * Oct 6, 2026). Pure and client-safe, so the
 * four column cases are pinned by a test instead of read off the JSX.
 *
 * - Q&A + panelists: three columns from xl; at lg the video and Q&A share a
 *   row and the panelists drop under the video; on a phone video, Q&A,
 *   panelists.
 * - Q&A only (Custom stream, no speakers): video beside Q&A from lg.
 * - Panelists only (Zoom mode): the side column starts at xl, so the Zoom
 *   embed keeps the full width on a laptop (it sizes itself and is fragile
 *   about fit).
 * - Neither: no grid.
 */
export interface WebinarVideoLayout {
  grid: string | undefined;
  videoCol: string;
  panelistsCol: string;
  qaCol: string;
}

const GRID = "grid items-start gap-4";

export function webinarVideoLayout({
  showQa,
  showPanelists,
}: {
  showQa: boolean;
  showPanelists: boolean;
}): WebinarVideoLayout {
  if (showQa && showPanelists) {
    return {
      grid: `${GRID} lg:grid-cols-[minmax(0,1fr)_292px] xl:grid-cols-[272px_minmax(0,1fr)_340px]`,
      videoCol: "order-1 xl:order-2",
      panelistsCol: "order-3 xl:order-1",
      qaCol: "order-2 xl:order-3",
    };
  }
  if (showQa) {
    return {
      grid: `${GRID} lg:grid-cols-[minmax(0,1fr)_292px] xl:grid-cols-[minmax(0,1fr)_340px]`,
      videoCol: "",
      panelistsCol: "",
      qaCol: "",
    };
  }
  if (showPanelists) {
    return {
      grid: `${GRID} xl:grid-cols-[272px_minmax(0,1fr)]`,
      videoCol: "order-1 xl:order-2",
      panelistsCol: "order-2 xl:order-1",
      qaCol: "",
    };
  }
  return { grid: undefined, videoCol: "", panelistsCol: "", qaCol: "" };
}

/**
 * The page background as an inline style. The URL is already restricted to an
 * upload or https address by readWebinarPageBranding; JSON.stringify gives a
 * quoted, escaped CSS string without re-encoding an already-encoded URL.
 */
export function webinarBackgroundStyle(url: string | null): { backgroundImage: string } | undefined {
  return url ? { backgroundImage: `url(${JSON.stringify(url)})` } : undefined;
}

/**
 * Whether the webinar is over for this viewer, which is when the end-of-webinar
 * survey appears (step 4 of several surveys, Oct 6, 2026): the host ended it in
 * Zoom, or the room is closed and the scheduled end has passed. A room closed
 * BEFORE the scheduled end is a pause, not the end (review of step 4: the room
 * route marks the session COMPLETED on close, so `lobbyEnded` turns true during
 * a pause too). Never while the room is open: an overrun past the scheduled end
 * keeps it hidden.
 */
export function isWebinarOver(s: {
  hostEnded: boolean;
  roomOpen: boolean;
  /** The scheduled end time has passed. */
  pastScheduledEnd: boolean;
}): boolean {
  return s.hostEnded || (!s.roomOpen && s.pastScheduledEnd);
}

