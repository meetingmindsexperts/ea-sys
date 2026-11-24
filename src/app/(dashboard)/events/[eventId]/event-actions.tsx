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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Edit, Copy, Loader2 } from "lucide-react";
import { useCloneEvent, usePartnerStreamAvailability } from "@/hooks/use-api";
import { useCan } from "@/hooks/use-can";
import { toast } from "sonner";

type VideoSource = "zoom" | "external";

interface EventActionsProps {
  eventId: string;
  eventName: string;
  /** A webinar's video source, which the Clone dialog starts the copy on; null for any other event. */
  webinarSource: VideoSource | null;
}

export function EventActions({ eventId, eventName, webinarSource }: EventActionsProps) {
  const router = useRouter();
  const cloneEvent = useCloneEvent();
  const canClone = useCan("events.clone", eventId) === "allowed";
  const canEdit = useCan("events.update", eventId) === "allowed";
  const [open, setOpen] = useState(false);
  const [includeSpeakers, setIncludeSpeakers] = useState(true);
  const [includeAgenda, setIncludeAgenda] = useState(true);
  const [includeCertificates, setIncludeCertificates] = useState(true);
  // A webinar's copy can take the other video source (Nov 24, 2026), as a new webinar can. "A partner
  // streams" is offered only where the server can issue a partner's key (usePartnerStreamAvailability,
  // as the new-event form asks); the copy of a partner's webinar can always switch to Zoom.
  const partnerStreams = usePartnerStreamAvailability();
  const [copySource, setCopySource] = useState<VideoSource>(webinarSource ?? "zoom");
  const partnerOffered = partnerStreams.data?.offered === true;
  const showSourceChoice = webinarSource !== null && (partnerOffered || webinarSource === "external");

  // Every open starts from "copy everything", so a choice made for one clone
  // is never silently reused for the next.
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setIncludeSpeakers(true);
      setIncludeAgenda(true);
      setIncludeCertificates(true);
      setCopySource(webinarSource ?? "zoom");
    }
    setOpen(next);
  };

  const copiedParts = [
    "ticket types",
    ...(includeSpeakers ? ["speakers"] : []),
    ...(includeAgenda ? ["tracks", "sessions"] : []),
    ...(includeCertificates ? ["certificate templates"] : []),
    "hotels",
  ];
  const copiedSummary = `${copiedParts.slice(0, -1).join(", ")}, and ${copiedParts[copiedParts.length - 1]}`;

  const handleClone = async () => {
    try {
      const result = await cloneEvent.mutateAsync({
        eventId,
        includeSpeakers,
        includeAgenda,
        includeCertificates,
        ...(webinarSource !== null ? { webinarSource: copySource } : {}),
      });
      setOpen(false);
      toast.success(`Event cloned as "${result.name}"`);
      router.push(`/events/${result.id}`);
    } catch (error) {
      console.error("[event-actions] clone failed", error);
      toast.error(error instanceof Error ? error.message : "Failed to clone event");
    }
  };

  return (
    <div className="flex gap-2 shrink-0">
      {canClone && (
        <AlertDialog open={open} onOpenChange={cloneEvent.isPending ? undefined : handleOpenChange}>
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
          <AlertDialogContent onEscapeKeyDown={cloneEvent.isPending ? (e) => e.preventDefault() : undefined}>
            {cloneEvent.isPending ? (
              <div className="flex flex-col items-center justify-center py-8 gap-4">
                <Loader2 className="h-10 w-10 animate-spin text-primary" />
                <div className="text-center space-y-1">
                  <p className="font-semibold text-base">Cloning Event...</p>
                  <p className="text-sm text-muted-foreground">
                    Copying {copiedSummary}. This may take a moment.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clone Event</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will create a copy of &quot;{eventName}&quot; with its{" "}
                    {copiedSummary}. The cloned event will start as a Draft.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="space-y-3 rounded-md border p-3">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="clone-include-speakers"
                      checked={includeSpeakers}
                      onCheckedChange={(v) => setIncludeSpeakers(v === true)}
                      className="mt-0.5"
                    />
                    <div className="space-y-0.5">
                      <Label htmlFor="clone-include-speakers" className="cursor-pointer">
                        Speakers
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        Copied as Invited, with no registration or badge on the new
                        event until you grant one.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="clone-include-agenda"
                      checked={includeAgenda}
                      onCheckedChange={(v) => setIncludeAgenda(v === true)}
                      className="mt-0.5"
                    />
                    <div className="space-y-0.5">
                      <Label htmlFor="clone-include-agenda" className="cursor-pointer">
                        Agenda
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        Tracks, sessions, breaks and topics, at the same dates and
                        times.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="clone-include-certificates"
                      checked={includeCertificates}
                      onCheckedChange={(v) => setIncludeCertificates(v === true)}
                      className="mt-0.5"
                    />
                    <div className="space-y-0.5">
                      <Label htmlFor="clone-include-certificates" className="cursor-pointer">
                        Certificate templates
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        Designs, CME hours and roles. Auto-issue starts off, so
                        check the dates on each design before turning it back on.
                      </p>
                    </div>
                  </div>
                  {showSourceChoice && (
                    <div className="space-y-1.5 border-t pt-4">
                      <Label htmlFor="clone-webinar-source">Video source</Label>
                      <Select value={copySource} onValueChange={(v) => setCopySource(v as VideoSource)}>
                        <SelectTrigger id="clone-webinar-source" data-testid="clone-webinar-source">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="zoom">Our Zoom webinar</SelectItem>
                          {partnerOffered && (
                            <SelectItem value="external">A partner streams from their own platform</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                      <p className="text-sm text-muted-foreground">
                        {copySource === "external"
                          ? "No Zoom webinar is created for the copy. Issue the partner a stream key from its Webinar Console. This cannot be changed after the copy is made."
                          : "A Zoom webinar is created for the copy when you run the provisioner from its Webinar Console."}
                      </p>
                    </div>
                  )}
                  {includeAgenda && !includeSpeakers && (
                    <p className="text-sm text-amber-700 dark:text-amber-400">
                      Sessions will be copied with no speakers assigned.
                    </p>
                  )}
                </div>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleClone}>
                    Clone Event
                  </AlertDialogAction>
                </AlertDialogFooter>
              </>
            )}
          </AlertDialogContent>
        </AlertDialog>
      )}
      {canEdit && (
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
      )}
    </div>
  );
}
