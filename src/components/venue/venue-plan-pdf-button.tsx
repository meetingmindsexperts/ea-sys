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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

type Paper = "A3" | "A4";

async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "The floor plan PDF could not be made. Please try again.";
}

export function VenuePlanPdfButton({ eventId }: { eventId: string }) {
  const [busy, setBusy] = useState<Paper | null>(null);

  const download = async (paper: Paper) => {
    setBusy(paper);
    try {
      const res = await fetch(`/api/events/${eventId}/venue/plan-pdf?paper=${paper}`);
      if (!res.ok) {
        toast.error(await refusal(res));
        return;
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `floor-plan-${paper}.pdf`;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded the floor plan (${paper}).`);
    } catch (err) {
      console.error("[venue] plan PDF download failed", err);
      toast.error("The floor plan could not be downloaded. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={busy !== null}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <FileDown className="mr-1.5 h-4 w-4" aria-hidden />}
          {busy ? `Making the ${busy} PDF…` : "Download PDF"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => download("A3")}>A3 (best for printing the plan)</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => download("A4")}>A4</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
