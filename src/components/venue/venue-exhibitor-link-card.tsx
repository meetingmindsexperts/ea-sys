"use client";

/**
 * The exhibitor floor plan link on the Venue tab (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md section 10, G1 and G6): one
 * secret link for every sponsor and exhibitor to find their stand. Created here, copied and sent by the team,
 * switched off or replaced at any time; it does not expire on its own.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Copy, ExternalLink, Link2, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ApiError } from "@/lib/api-fetch";
import { useChangeVenueShareLink, useVenueShareLink } from "@/hooks/use-api";

const say = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function VenueExhibitorLinkCard({ eventId, canEdit }: { eventId: string; canEdit: boolean }) {
  const { data, isLoading, isError } = useVenueShareLink(eventId);
  const change = useChangeVenueShareLink(eventId);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const link = data?.link ?? null;
  const url = link && typeof window !== "undefined" ? `${window.location.origin}${link.path}` : "";

  const act = (action: "create" | "replace" | "enable" | "disable", done: string) =>
    change.mutate(action, {
      onSuccess: () => toast.success(done),
      onError: (err) => toast.error(say(err, "The exhibitor link could not be changed. Please try again.")),
    });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch (err) {
      console.warn("[venue] copy exhibitor link failed", err);
      toast.error("Could not copy. Select the link and copy it yourself.");
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-base font-semibold">
            <Link2 className="h-4 w-4 text-primary" aria-hidden />
            Exhibitor floor plan link
          </p>
          <p className="text-sm text-muted-foreground">
            One link for every sponsor and exhibitor to find their stand, on a phone or a computer, with no sign-in. Staff-only items and notes are never shown;
            the venue&apos;s drawing shows only where you ticked it for exhibitors in the floor plan editor.
          </p>
        </div>
        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />}
        {isError && <p className="text-sm text-destructive">The exhibitor link could not be loaded. Reload the page to try again.</p>}
        {!isLoading && !isError && !link && (
          canEdit ? (
            <Button onClick={() => act("create", "Exhibitor link created")} disabled={change.isPending}>
              {change.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Create the exhibitor link
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">No exhibitor link yet.</p>
          )
        )}
        {link && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input id="venue-exhibitor-link" name="venue-exhibitor-link" readOnly value={url} aria-label="Exhibitor floor plan link" className="min-w-0 flex-1 font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button variant="outline" size="sm" onClick={copy} disabled={!link.enabled}>
                <Copy className="h-4 w-4" aria-hidden />
                Copy
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a href={link.path} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  Open
                </a>
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Switch
                  id="venue-exhibitor-link-on"
                  checked={link.enabled}
                  disabled={!canEdit || change.isPending}
                  onCheckedChange={(on) => act(on ? "enable" : "disable", on ? "Exhibitor link switched on" : "Exhibitor link switched off")}
                  aria-label="Exhibitor link on"
                />
                {link.enabled ? "On: anyone with the link can see the plan" : "Off: the link shows a message to ask for a new one"}
              </label>
              {canEdit && (
                <Button variant="ghost" size="sm" onClick={() => setConfirmReplace(true)} disabled={change.isPending}>
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Replace the link
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Last changed {new Date(link.updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
              {link.updatedBy ? ` by ${link.updatedBy}` : ""}.
            </p>
          </div>
        )}
      </CardContent>
      <AlertDialog open={confirmReplace} onOpenChange={setConfirmReplace}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the exhibitor link?</AlertDialogTitle>
            <AlertDialogDescription>The current link stops working at once. Send the new link to every sponsor and exhibitor who should still see the plan.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the current link</AlertDialogCancel>
            <AlertDialogAction onClick={() => act("replace", "The exhibitor link was replaced. The old one no longer works.")}>Replace the link</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
