/**
 * Stream delay measurement (Oct 2, 2026): pure helpers shared by the console's
 * stream preview and the /stream-clock page. Client-safe (no Node imports).
 *
 * Three delays, all in milliseconds and all on the SERVER clock:
 *  - ours:  MediaMTX received the video -> it plays in the preview. From the
 *           arrival time MediaMTX stamps on each chunk (EXT-X-PROGRAM-DATE-TIME),
 *           read by the player as the "playing date".
 *  - zoom:  the room -> MediaMTX received it. Needs the clock page: the host
 *           shares a QR code of the time in Zoom, and the preview reads it.
 *  - total: the room -> the screen (zoom + ours).
 * Both browsers' clocks are corrected to the server's with `pickClockOffset`,
 * so a laptop clock that is a few seconds off does not skew the numbers.
 */

export const CLOCK_QR_PREFIX = "EASYS-CLOCK:";

export function encodeClockQr(serverMs: number): string {
  return `${CLOCK_QR_PREFIX}${Math.round(serverMs)}`;
}

/** The server time in a clock QR code, or null for any other QR code. */
export function parseClockQr(text: string): number | null {
  if (!text.startsWith(CLOCK_QR_PREFIX)) return null;
  const value = Number(text.slice(CLOCK_QR_PREFIX.length));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface ClockSample {
  /** Local time just before the request (ms). */
  sentAt: number;
  /** Local time when the answer arrived (ms). */
  receivedAt: number;
  /** The server's time in the answer (ms). */
  serverNow: number;
}

/**
 * Server time minus local time, from the sample with the shortest round trip
 * (the one whose midpoint is the most trustworthy). Null with no samples.
 */
export function pickClockOffset(samples: ClockSample[]): number | null {
  if (samples.length === 0) return null;
  const best = samples.reduce((a, b) =>
    b.receivedAt - b.sentAt < a.receivedAt - a.sentAt ? b : a,
  );
  return best.serverNow - (best.sentAt + best.receivedAt) / 2;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface DelayReading {
  totalMs: number;
  /** Null when the stream carries no arrival stamps. */
  zoomMs: number | null;
  oursMs: number | null;
}

/**
 * One reading from a decoded clock QR. `playingDateMs` is the arrival time of
 * the frame on screen (server clock), or null when the stream has no stamps.
 */
export function readingFromClock(
  qrServerMs: number,
  serverNowMs: number,
  playingDateMs: number | null,
): DelayReading {
  return {
    totalMs: serverNowMs - qrServerMs,
    zoomMs: playingDateMs === null ? null : playingDateMs - qrServerMs,
    oursMs: playingDateMs === null ? null : serverNowMs - playingDateMs,
  };
}

/** "7.2 s" */
export function formatDelay(ms: number | null): string {
  if (ms === null) return "n/a";
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}
