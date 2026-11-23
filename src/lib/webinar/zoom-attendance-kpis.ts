/**
 * The figures of Zoom's attendance report (moved out of the attendance route on Nov 23, 2026, so the
 * console's Attendance card and the post-event report count the same way): people who attended
 * (one per address, a row without one counts on its own), their share of the confirmed registrations,
 * the average and total time in Zoom, and the most people in Zoom at once.
 */

export interface ZoomAttendanceRowLike {
  id: string;
  email: string | null;
  joinTime: Date;
  leaveTime: Date | null;
  durationSeconds: number;
}

export interface ZoomAttendanceFigures {
  registered: number;
  attended: number;
  attendanceRate: number;
  avgWatchSeconds: number;
  totalWatchSeconds: number;
  peakConcurrent: number;
}

/**
 * Peak concurrent attendees, by walking a sorted list of join/leave events. O(n log n): fine for
 * thousands of rows.
 */
export function computePeakConcurrent(rows: ReadonlyArray<{ joinTime: Date; leaveTime: Date | null }>): number {
  if (rows.length === 0) return 0;
  type Edge = { time: number; delta: number };
  const edges: Edge[] = [];
  for (const r of rows) {
    edges.push({ time: r.joinTime.getTime(), delta: 1 });
    if (r.leaveTime) {
      edges.push({ time: r.leaveTime.getTime(), delta: -1 });
    }
  }
  // Sort by time, with -1 (leave) before +1 (join) at the same instant so
  // back-to-back leave/rejoin doesn't double-count.
  edges.sort((a, b) => a.time - b.time || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const e of edges) {
    current += e.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

/** `registered`: the confirmed delegate registrations (CONFIRMED or CHECKED_IN, faculty excluded). */
export function zoomAttendanceFigures(rows: readonly ZoomAttendanceRowLike[], registered: number): ZoomAttendanceFigures {
  const totalWatchSeconds = rows.reduce((sum, a) => sum + a.durationSeconds, 0);
  const uniqueAttendees = new Set<string>();
  for (const a of rows) {
    uniqueAttendees.add(a.email?.toLowerCase() || `id:${a.id}`);
  }
  const attended = uniqueAttendees.size;
  return {
    registered,
    attended,
    attendanceRate: registered > 0 ? Math.round((attended / registered) * 100) : 0,
    avgWatchSeconds: rows.length > 0 ? Math.round(totalWatchSeconds / rows.length) : 0,
    totalWatchSeconds,
    peakConcurrent: computePeakConcurrent(rows),
  };
}
