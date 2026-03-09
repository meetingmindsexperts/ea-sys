"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Edit, Copy, Loader2 } from "lucide-react";
import { useCloneEvent } from "@/hooks/use-api";
import { toast } from "sonner";

interface EventActionsProps {
  eventId: string;
  eventName: string;
}

export function EventActions({ eventId, eventName }: EventActionsProps) {
  const router = useRouter();
  const cloneEvent = useCloneEvent();
  const [open, setOpen] = useState(false);

  const handleClone = async () => {
    try {
      const result = await cloneEvent.mutateAsync(eventId);
      setOpen(false);
      toast.success(`Event cloned as "${result.name}"`);
      router.push(`/events/${result.id}`);
    } catch {
      toast.error("Failed to clone event");
    }
  };

  return (
    <div className="flex gap-2 shrink-0">
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="bg-white/10 border-white/30 text-white hover:bg-white/20 hover:text-white hover:border-white/40"
          >
            <Copy className="mr-2 h-4 w-4" />
            Clone
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clone Event</AlertDialogTitle>
            <AlertDialogDescription>
              This will create a copy of &quot;{eventName}&quot; including all
              ticket types, speakers, tracks, sessions, and hotels. The cloned
              event will start as a Draft.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cloneEvent.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClone}
              disabled={cloneEvent.isPending}
            >
              {cloneEvent.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Cloning...
                </>
              ) : (
                "Clone Event"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Button
        variant="outline"
        size="sm"
        className="bg-white/10 border-white/30 text-white hover:bg-white/20 hover:text-white hover:border-white/40"
        asChild
      >
        <Link href={`/events/${eventId}/settings`}>
          <Edit className="mr-2 h-4 w-4" />
          Edit Event
        </Link>
      </Button>
    </div>
  );
}
