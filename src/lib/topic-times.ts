import { formatTimeInTz } from "@/lib/event-time";

/**
 * Per-topic start–end times computed by stacking topic durations from the
 * session start (SessionTopic stores no start time). SAME convention as the
 * {{moderatorDetails}} run-sheet in speaker-agreement.ts: a topic with no
 * duration shows no time range and does NOT advance the clock.
 *
 * Shared by the public agenda and the session (streaming) page so the two
 * always show the same times (Oct 7, 2026).
 */
export function computeTopicTimes(
  sessionStart: string,
  topics: ReadonlyArray<{ id: string; duration: number | null }>,
  timezone: string,
): Map<string, string | null> {
  const times = new Map<string, string | null>();
  let clock = new Date(sessionStart).getTime();
  for (const topic of topics) {
    if (topic.duration && topic.duration > 0) {
      const start = new Date(clock);
      const end = new Date(clock + topic.duration * 60_000);
      times.set(topic.id, `${formatTimeInTz(start, timezone)} – ${formatTimeInTz(end, timezone)}`);
      clock = end.getTime();
    } else {
      times.set(topic.id, null);
    }
  }
  return times;
}
