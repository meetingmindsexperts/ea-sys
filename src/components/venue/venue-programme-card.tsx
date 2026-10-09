"use client";

/**
 * What the venue will show of the event's programme (phase 6 step 4): which
 * room each session lands in, the sessions that name no room (so the team can
 * rename a track, a room or a location), and the sponsors against the stands.
 * Recomputed as the rooms are edited, with the same matching the venue uses.
 */
import { useMemo } from "react";
import { AlertCircle, CalendarDays } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeading } from "@/components/ui/typography";
import { generateLayout } from "@/lib/venue/layout";
import { roomOfSession } from "@/lib/venue/programme";
import type { VenueRoom } from "@/lib/venue/rooms";
import type { VenueRoomsData } from "@/hooks/use-api";

const SHOWN_UNPLACED = 8;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function sponsorLine(sponsors: number, stands: number): string {
  if (!sponsors) return stands ? `No sponsors on this event yet, so the ${plural(stands, "stand")} show plain stand numbers.` : "No sponsors on this event yet.";
  if (!stands) return `${plural(sponsors, "sponsor")}, but these rooms have no exhibition hall, so none of them gets a stand.`;
  if (sponsors > stands) return `${plural(sponsors, "sponsor")} for ${plural(stands, "stand")}: the first ${stands} by tier get one. Raise the exhibition hall's people to add stands.`;
  return `${plural(sponsors, "sponsor")} on ${plural(stands, "stand")}, platinum first; the rest show plain stand numbers.`;
}

export function VenueProgrammeCard({ rooms, programme }: { rooms: VenueRoom[]; programme: VenueRoomsData["programme"] }) {
  const placed = useMemo(() => {
    if (!programme) return null;
    const refs = rooms.map((r) => ({ id: r.id, name: r.name }));
    const counts = new Map<string, number>();
    const unplaced: { title: string; names: string | null }[] = [];
    for (const s of programme.sessions) {
      const room = roomOfSession(refs, s);
      if (room) counts.set(room, (counts.get(room) ?? 0) + 1);
      else unplaced.push({ title: s.title, names: s.location?.trim() || s.track?.trim() || null });
    }
    const stands = generateLayout(rooms, { eventName: "" }).items.filter((it) => it.t === "stand").length;
    return { counts, unplaced, stands };
  }, [rooms, programme]);

  return (
    <section className="space-y-3">
      <SectionHeading
        title="Programme in the venue"
        description="Each room's screen shows its session on now or next, and the agenda lists them. A session goes in the room its location or track is named after."
      />
      <Card>
        <CardContent className="space-y-4 p-5 text-sm">
          {!programme || !placed ? (
            <p className="text-destructive">Couldn&apos;t load the event&apos;s sessions. Reload the page to try again.</p>
          ) : (
            <>
              {programme.sessions.length === 0 ? (
                <p className="text-muted-foreground">No sessions on the agenda yet. The screens show what each room is for until there are.</p>
              ) : (
                <div className="space-y-2">
                  <p>
                    <span className="font-medium tabular-nums">{programme.sessions.length - placed.unplaced.length}</span> of{" "}
                    {plural(programme.sessions.length, "session")} are in a room.
                  </p>
                  <ul className="flex flex-wrap gap-2">
                    {rooms
                      .filter((r) => placed.counts.get(r.id))
                      .map((r) => (
                        <li key={r.id} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
                          <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                          {r.name}
                          <span className="tabular-nums text-muted-foreground">{placed.counts.get(r.id)}</span>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
              {placed.unplaced.length > 0 && (
                <div className="flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <div className="space-y-1">
                    <p className="font-medium">{placed.unplaced.length === 1 ? "1 session names" : `${placed.unplaced.length} sessions name`} no room here</p>
                    <ul className="list-disc space-y-0.5 pl-4">
                      {placed.unplaced.slice(0, SHOWN_UNPLACED).map((s, i) => (
                        <li key={`${s.title}-${i}`}>
                          {s.title}
                          <span className="text-amber-800/80 dark:text-amber-200/70">{s.names ? ` (says "${s.names}")` : " (no location or track)"}</span>
                        </li>
                      ))}
                    </ul>
                    {placed.unplaced.length > SHOWN_UNPLACED && <p>and {placed.unplaced.length - SHOWN_UNPLACED} more.</p>}
                    <p>They still appear in the venue&apos;s agenda. To place one, give it a track or location with a room&apos;s exact name, or rename the room.</p>
                  </div>
                </div>
              )}
              <p className="text-muted-foreground">{sponsorLine(programme.sponsors, placed.stands)}</p>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
