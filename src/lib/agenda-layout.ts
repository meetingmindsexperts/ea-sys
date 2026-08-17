import { isBreakSessionType } from "@/lib/session-enums";

/**
 * Agenda layout — group one day's sessions into the rows a programme renders.
 *
 * A track IS a room on every event that has real sessions (Plenary Hall,
 * Workshop Hall I, Workshop Room …), confirmed with the owner on 2026-08-17.
 * So "parallel" means the same clock in a different room, and the right shape
 * is the printed-programme grid: rooms as columns, sessions as cells.
 *
 * Two decisions here are load-bearing:
 *
 * 1. Sessions cluster on OVERLAP, not on an equal start time. On BHS2026 a
 *    workshop runs 11:40–13:00 across two plenary sessions (11:25–12:20 and
 *    12:20–13:15); an equality check finds nothing and the attendee never
 *    learns there was a choice.
 *
 * 2. Columns are keyed by ROOM, not by session. That same BHS cluster is three
 *    sessions but only two rooms, so it renders as Plenary Hall (two sessions
 *    stacked in time order) beside Workshop Room. Keying by session would have
 *    put two consecutive talks in the same hall into separate columns, which
 *    reads as a choice between them when it is not one.
 *
 * Break items (registration / coffee / lunch / networking) are laid out apart
 * from the programme and merged back by start time, so a coffee break that
 * happens to sit inside a long workshop cannot split the block around it.
 */

export interface LayoutSession {
  id: string;
  startTime: string;
  endTime: string;
  type?: string | null;
  track?: { name: string; color?: string } | null;
  location?: string | null;
}

export interface AgendaColumn<T> {
  /** The room. Null when a session carries neither a track nor a location. */
  room: string | null;
  color: string | null;
  sessions: T[];
}

export type AgendaRow<T> =
  | { kind: "break"; key: string; start: number; session: T }
  | { kind: "single"; key: string; start: number; session: T }
  | {
      kind: "parallel";
      key: string;
      start: number;
      end: number;
      columns: AgendaColumn<T>[];
    };

const ms = (iso: string) => new Date(iso).getTime();

/**
 * Where a session happens. Track first because that is where every real event
 * puts the room; `location` is the fallback for the sessions where an organizer
 * typed the hall into the other field instead.
 */
export function roomOf(session: LayoutSession): string | null {
  return session.track?.name ?? session.location ?? null;
}

function toColumns<T extends LayoutSession>(cluster: T[]): AgendaColumn<T>[] {
  // Keyed on the room itself, null included. A Map takes null as a key, so
  // there is no need for a sentinel string, and a room name typed by an
  // organizer can never collide with one.
  const byRoom = new Map<string | null, AgendaColumn<T>>();

  for (const session of cluster) {
    const room = roomOf(session);
    let column = byRoom.get(room);
    if (!column) {
      column = { room, color: session.track?.color ?? null, sessions: [] };
      byRoom.set(room, column);
    }
    column.sessions.push(session);
  }

  const columns = [...byRoom.values()];
  for (const column of columns) {
    column.sessions.sort((a, b) => ms(a.startTime) - ms(b.startTime));
  }

  columns.sort((a, b) => {
    // A session with no room goes last: it cannot be labelled, so it must not
    // sit at the head of a row of named halls.
    if ((a.room === null) !== (b.room === null)) return a.room === null ? 1 : -1;
    const byStart = ms(a.sessions[0].startTime) - ms(b.sessions[0].startTime);
    if (byStart !== 0) return byStart;
    return (a.room ?? "").localeCompare(b.room ?? "");
  });

  return columns;
}

export function buildAgendaRows<T extends LayoutSession>(
  sessions: readonly T[],
): AgendaRow<T>[] {
  const breaks: T[] = [];
  const programme: T[] = [];
  for (const session of sessions) {
    (isBreakSessionType(session.type ?? null) ? breaks : programme).push(session);
  }

  programme.sort((a, b) => ms(a.startTime) - ms(b.startTime));

  const rows: AgendaRow<T>[] = [];
  let cluster: T[] = [];
  let clusterEnd = -Infinity;

  const single = (session: T) =>
    rows.push({
      kind: "single" as const,
      key: session.id,
      start: ms(session.startTime),
      session,
    });

  function flush() {
    if (cluster.length === 0) return;

    const columns = toColumns(cluster);

    // One room means no choice to present, whatever the overlap says. This is
    // also the track-filtered case: filtering to one hall must give back the
    // ordinary list, not a one-column grid.
    if (columns.length <= 1) {
      for (const session of cluster) single(session);
    } else {
      rows.push({
        kind: "parallel",
        key: `block-${cluster[0].id}`,
        start: Math.min(...cluster.map((s) => ms(s.startTime))),
        end: Math.max(...cluster.map((s) => ms(s.endTime))),
        columns,
      });
    }

    cluster = [];
    clusterEnd = -Infinity;
  }

  for (const session of programme) {
    if (cluster.length > 0 && ms(session.startTime) < clusterEnd) {
      cluster.push(session);
      clusterEnd = Math.max(clusterEnd, ms(session.endTime));
    } else {
      flush();
      cluster = [session];
      clusterEnd = ms(session.endTime);
    }
  }
  flush();

  for (const session of breaks) {
    rows.push({
      kind: "break",
      key: session.id,
      start: ms(session.startTime),
      session,
    });
  }

  rows.sort((a, b) => a.start - b.start);
  return rows;
}
