"use client";

/**
 * A draft event says so on every event page until someone publishes it
 * (owner, Oct 8, 2026). Nothing is blocked while it is a draft: registration
 * links, the agenda and the emails all work, which is exactly why a forgotten
 * draft goes unnoticed. Anyone whose access includes editing the event
 * (events.update: built-in organisers and admins, and Members whose custom
 * role adds it) gets a Publish button. Not dismissable, on purpose.
 */
import { useState } from "react";
import { useParams, usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Rocket } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { queryKeys, useEvent } from "@/hooks/use-api";
import { useCan } from "@/hooks/use-can";
import { principalFromUser } from "@/lib/permissions/can";

export function DraftEventBanner() {
  const params = useParams();
  const pathname = usePathname();
  const eventId = typeof params.eventId === "string" ? params.eventId : "";
  const { data: session } = useSession();
  const { data: event } = useEvent(eventId);
  const canPublish = useCan("events.update", eventId) === "allowed";
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);

  if (!event || event.status !== "DRAFT" || !session?.user) return null;
  // Staff only: reviewers and submitters hold no staff area and never change status.
  if (principalFromUser(session.user).areas.length === 0) return null;
  // The full-screen kiosk is attendee-facing.
  if (pathname.includes("/check-in/kiosk")) return null;

  const kind = event.eventType === "WEBINAR" ? "webinar" : "event";

  const publish = async () => {
    setPublishing(true);
    try {
      const res = await fetch(`/api/events/${eventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "PUBLISHED" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.warn("draft-banner:publish-failed", res.status, data);
        toast.error(data.error ?? `Could not publish the ${kind}.`);
        return;
      }
      toast.success(`The ${kind} is published.`);
      setConfirmOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.event(eventId), exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.events, exact: true }),
      ]);
    } catch (err) {
      console.error("draft-banner:publish-failed", err);
      toast.error(`Could not publish the ${kind}.`);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <>
      <div
        role="status"
        className="mb-4 flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 sm:flex-row sm:items-center"
      >
        <AlertTriangle className="hidden h-5 w-5 shrink-0 text-amber-600 sm:block" aria-hidden />
        <div className="flex-1 text-sm">
          <p className="font-semibold">This {kind} is still a draft.</p>
          <p className="text-amber-900/80">
            Registration, the agenda and emails already work, but it is not published.{" "}
            {canPublish
              ? "Publish it once it is ready."
              : "Anyone who can edit this event's details can publish it."}
          </p>
        </div>
        {canPublish && (
          <Button
            size="sm"
            onClick={() => setConfirmOpen(true)}
            className="shrink-0 gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
          >
            <Rocket className="h-4 w-4" />
            Publish {kind}
          </Button>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !publishing && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish &ldquo;{event.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Its status changes from Draft to Published. You can change it back in Settings.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={publishing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void publish();
              }}
              disabled={publishing}
            >
              {publishing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Publish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
