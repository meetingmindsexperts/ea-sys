"use client";

/**
 * The Venue tab's way in from the event's approved Blueprint (phase 6 step 5):
 * its spaces as rooms, offered like a template. Picking it only fills the
 * editor; nothing is saved until the organiser presses Save. What was changed
 * to fit the venue's rules is listed while that draft is open.
 */
import { ClipboardList, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { VenueRoomsData } from "@/hooks/use-api";

type Blueprint = NonNullable<VenueRoomsData["blueprint"]>;

const named = (bp: Blueprint) => (bp.ref ? `${bp.title} (${bp.ref})` : bp.title);

/** Shown above the templates when no rooms are set up yet. */
export function BlueprintStartCard({ blueprint, onUse }: { blueprint: Blueprint; onUse: () => void }) {
  if (!blueprint.rooms.length) {
    return (
      <p className="text-sm text-muted-foreground">
        The approved Blueprint, {named(blueprint)}, lists no spaces, so start from a template below.
      </p>
    );
  }
  return (
    <Card className="border-primary/40">
      <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start">
        <ClipboardList className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-base font-semibold">Start from the Blueprint</p>
          <p className="text-sm text-muted-foreground">
            {named(blueprint)} plans {blueprint.spaces} space{blueprint.spaces === 1 ? "" : "s"}. As rooms: {blueprint.rooms.map((r) => r.name).join(", ")}.
          </p>
        </div>
        <Button className="self-start" onClick={onUse}>
          Use the Blueprint&apos;s rooms
        </Button>
      </CardContent>
    </Card>
  );
}

/** A quiet offer once rooms exist: replace them with the Blueprint's (as a draft, so Discard undoes it). */
export function BlueprintReplaceRow({ blueprint, onUse }: { blueprint: Blueprint; onUse: () => void }) {
  if (!blueprint.rooms.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <span>This event has an approved Blueprint, {named(blueprint)}.</span>
      <Button variant="link" className="h-auto p-0" onClick={onUse}>
        Use its rooms instead
      </Button>
    </div>
  );
}

/** What changed to fit the venue, shown while the Blueprint's rooms are an unsaved draft. */
export function BlueprintNotes({ notes }: { notes: string[] }) {
  return (
    <div role="status" className="flex gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="space-y-1">
        <p className="font-medium">{notes.length ? "Filled in from the Blueprint, with these changes" : "Filled in from the Blueprint, unchanged"}</p>
        {notes.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground">Check the names and sizes, then save. Discard changes to go back.</p>
      </div>
    </div>
  );
}
