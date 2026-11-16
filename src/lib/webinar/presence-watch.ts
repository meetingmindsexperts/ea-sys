/**
 * What one presence heartbeat adds to the attendance record (Nov 16, 2026;
 * external streams step 6, docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md §4.8).
 *
 * The webinar page beats every 30 to 40 seconds while it is open and visible
 * (src/app/e/[slug]/session/[sessionId]/page.tsx), and once more when the tab
 * becomes visible again. From two beats in a row:
 *
 *   watched time   the gap between them, when this beat is from the live view,
 *                  the person had already reached it (the row's phase, which
 *                  never goes back to the lobby), and the room is open. A gap
 *                  longer than COUNTED_GAP_MAX_MS means the page was closed,
 *                  hidden or asleep in between, so
 *                  nothing is added for it: under-counting a background tab is
 *                  the price of never counting a laptop left closed overnight.
 *                  (The beat sent when a tab becomes visible again can count up
 *                  to a minute of hidden time, so the total is close, not exact.)
 *   a return       ANY beat, lobby or live view, more than REJOIN_GAP_MS after
 *                  the last one, from someone who had reached the live view,
 *                  while the room is open: the person left and came back. It
 *                  counts as one more join. Any beat, because a page that is
 *                  reopened sends its first beat before it knows the room is
 *                  open, so that beat says "lobby" and moves lastSeenAt: waiting
 *                  for a live-view beat counted a hidden tab as a return and
 *                  missed nearly every real one (review of d2200512). Ten
 *                  minutes, not two: a hidden tab sends no beats, and a person
 *                  answering email beside the webinar is not leaving and
 *                  returning every few minutes. With the room closed it is a
 *                  visit to the closing screen or the replay, not a join.
 *
 * Two tabs beat into the same row; each beat measures from the last write, so
 * the total stays close to wall time rather than doubling. A beat read and
 * written by two requests at the same instant can add one gap twice; at most
 * one beat's worth, accepted rather than a transaction per heartbeat at 5,000
 * viewers.
 */

/** Longest gap between beats that still counts as watched (the beat is 30 to 40 seconds, jittered). */
export const COUNTED_GAP_MAX_MS = 60_000;

/** A beat this long after the previous one, with the room open, is a return, counted as another join. */
export const REJOIN_GAP_MS = 10 * 60_000;

export interface PresenceBeatEffect {
  /** Seconds to add to watchedSeconds. */
  watchedSeconds: number;
  /** Whether this beat is a return after an absence (one more join). */
  rejoined: boolean;
}

type PreviousBeat = { phase: string; lastSeenAt: Date } | null;

/**
 * Whether this beat could add anything, so the caller asks "is the room open"
 * only then: the heartbeat is the busiest write in the app, and most lobby
 * beats (the waiting room, the closing screen) need no answer.
 */
export function beatCouldCount(input: { beatPhase: "lobby" | "joined"; previous: PreviousBeat; now: Date }): boolean {
  if (input.previous?.phase !== "joined") return false;
  return input.beatPhase === "joined" || input.now.getTime() - input.previous.lastSeenAt.getTime() > REJOIN_GAP_MS;
}

export function presenceBeatEffect(input: {
  beatPhase: "lobby" | "joined";
  previous: PreviousBeat;
  /** The webinar room is open (isViewerRoomOpen). Only read when beatCouldCount says so. */
  roomOpen: boolean;
  now: Date;
}): PresenceBeatEffect {
  const none = { watchedSeconds: 0, rejoined: false };
  const { beatPhase, previous, roomOpen, now } = input;
  // Until the person has reached the live view nothing counts: admission itself is their first join.
  if (previous?.phase !== "joined" || !roomOpen) return none;
  const gapMs = now.getTime() - previous.lastSeenAt.getTime();
  if (gapMs <= 0) return none;
  if (gapMs > REJOIN_GAP_MS) return { watchedSeconds: 0, rejoined: true };
  if (beatPhase !== "joined" || gapMs > COUNTED_GAP_MAX_MS) return none;
  return { watchedSeconds: Math.round(gapMs / 1000), rejoined: false };
}
