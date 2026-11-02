"use client";

/**
 * Download the saved floor plan as a PDF (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md,
 * section 3.7). Fetched rather than navigated to, so a refusal (rooms not
 * saved, the hourly limit) is a toast in plain words, never a page of JSON.
 */
import { useState } from "react";
import { toast } from "sonner";
import { FileDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

type Paper = "A3" | "A4";

async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "The floor plan PDF could not be made. Please try again.";
}

/**
 * `rooms`: the seated rooms, each of which also has a one-page setup sheet (section 11, step 3): the room to scale
 * with its stage, screen, seats and headcount, the page a hotel's banqueting team works from.
 */
export function VenuePlanPdfButton({ eventId, rooms = [] }: { eventId: string; rooms?: { id: string; name: string }[] }) {
  const [busy, setBusy] = useState<string | null>(null);

  const fetchPdf = async (label: string, url: string, fallbackName: string, done: string) => {
    setBusy(label);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        toast.error(await refusal(res));
        return;
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName;
      const blobUrl = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = name;
      a.click();
      URL.revokeObjectURL(blobUrl);
      toast.success(done);
    } catch (err) {
      console.error("[venue] PDF download failed", err);
      toast.error("The PDF could not be downloaded. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  };
  const download = (paper: Paper) =>
    fetchPdf(`${paper} PDF`, `/api/events/${eventId}/venue/plan-pdf?paper=${paper}`, `floor-plan-${paper}.pdf`, `Downloaded the floor plan (${paper}).`);
  const sheet = (room: { id: string; name: string }) =>
    fetchPdf("room sheet", `/api/events/${eventId}/venue/room-sheet?room=${encodeURIComponent(room.id)}`, `${room.id}-setup.pdf`, `Downloaded the setup sheet for ${room.name}.`);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={busy !== null}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <FileDown className="mr-1.5 h-4 w-4" aria-hidden />}
          {busy ? `Making the ${busy}…` : "Download PDF"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => download("A3")}>A3 (best for printing the plan)</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => download("A4")}>A4</DropdownMenuItem>
        {rooms.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Room setup sheet (A4)</DropdownMenuLabel>
            {rooms.map((r) => (
              <DropdownMenuItem key={r.id} onSelect={() => sheet(r)}>
                {r.name}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
