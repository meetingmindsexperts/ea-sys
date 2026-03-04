"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Cloud,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Download,
  Settings,
} from "lucide-react";
import { toast } from "sonner";
import {
  useEventsAirConfig,
  useEventsAirEvents,
  useImportEventsAirEvent,
} from "@/hooks/use-api";
import Link from "next/link";

interface EventsAirEvent {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  venue?: { name: string };
  alreadyImported: boolean;
}

interface EventsAirImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ImportStep = "browse" | "importing" | "done";

interface ImportProgress {
  step: string;
  totalCreated: number;
  totalSkipped: number;
  errors: string[];
}

export function EventsAirImportDialog({ open, onOpenChange }: EventsAirImportDialogProps) {
  const router = useRouter();
  const { data: config, isLoading: configLoading } = useEventsAirConfig();
  const { data: events, isLoading: eventsLoading, refetch: fetchEvents } = useEventsAirEvents();
  const importEvent = useImportEventsAirEvent();

  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [step, setStep] = useState<ImportStep>("browse");
  const [newEventId, setNewEventId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress>({ step: "", totalCreated: 0, totalSkipped: 0, errors: [] });

  // Fetch events when dialog opens and config is ready
  useEffect(() => {
    if (open && config?.configured) {
      fetchEvents();
    }
  }, [open, config?.configured, fetchEvents]);

  const handleImport = async () => {
    if (!selectedEventId) return;

    setStep("importing");
    setProgress({ step: "Creating event...", totalCreated: 0, totalSkipped: 0, errors: [] });

    try {
      // Step 1: Create event
      const result = await importEvent.mutateAsync({ eventsAirEventId: selectedEventId });
      const eventId = result.eventId;
      setNewEventId(eventId);

      if (result.alreadyImported) {
        setProgress((p) => ({ ...p, step: "Event already imported" }));
        setStep("done");
        return;
      }

      // Step 2: Import contacts in batches
      let offset = 0;
      let hasMore = true;
      let totalCreated = 0;
      let totalSkipped = 0;
      const allErrors: string[] = [];
      let batchNum = 0;

      while (hasMore) {
        batchNum++;
        setProgress((p) => ({
          ...p,
          step: `Importing contacts (batch ${batchNum})...`,
        }));

        const res = await fetch(`/api/events/${eventId}/import/eventsair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            eventsAirEventId: selectedEventId,
            offset,
            limit: 500,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Request failed" }));
          throw new Error(err.error || "Failed to import contacts");
        }

        const data = await res.json();
        totalCreated += data.created;
        totalSkipped += data.skipped;
        if (data.errors?.length) allErrors.push(...data.errors);
        hasMore = data.hasMore;
        offset = data.nextOffset;

        setProgress({
          step: `Imported batch ${batchNum}`,
          totalCreated,
          totalSkipped,
          errors: allErrors,
        });
      }

      setProgress({
        step: "Complete",
        totalCreated,
        totalSkipped,
        errors: allErrors,
      });
      setStep("done");
      toast.success(`Imported ${totalCreated} contacts`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
      setStep("done");
    }
  };

  const handleClose = () => {
    setSelectedEventId(null);
    setStep("browse");
    setProgress({ step: "", totalCreated: 0, totalSkipped: 0, errors: [] });
    setNewEventId(null);
    onOpenChange(false);
  };

  const handleGoToEvent = () => {
    if (newEventId) {
      handleClose();
      router.push(`/events/${newEventId}`);
    }
  };

  const isConfigured = config?.configured;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="h-5 w-5" />
            Import from EventsAir
          </DialogTitle>
          <DialogDescription>
            Select an event from EventsAir to import with all contacts and registrations.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto">
          {/* Not configured */}
          {!configLoading && !isConfigured && (
            <div className="text-center py-8 space-y-3">
              <Settings className="h-8 w-8 mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                EventsAir integration is not configured.
              </p>
              <Button asChild variant="outline" size="sm">
                <Link href="/settings">Configure in Settings</Link>
              </Button>
            </div>
          )}

          {/* Loading */}
          {(configLoading || eventsLoading) && isConfigured && (
            <div className="flex items-center justify-center py-8 gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading events...
            </div>
          )}

          {/* Browse events */}
          {step === "browse" && isConfigured && events && !eventsLoading && (
            <div className="border rounded-md overflow-auto max-h-[400px]">
              {events.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  No events found in EventsAir
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Event</th>
                      <th className="px-3 py-2 text-left font-medium">Dates</th>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(events as EventsAirEvent[]).map((evt) => (
                      <tr
                        key={evt.id}
                        className={`cursor-pointer transition-colors ${
                          selectedEventId === evt.id
                            ? "bg-primary/5 border-l-2 border-l-primary"
                            : "hover:bg-muted/30"
                        } ${evt.alreadyImported ? "opacity-60" : ""}`}
                        onClick={() => !evt.alreadyImported && setSelectedEventId(evt.id)}
                      >
                        <td className="px-3 py-2">
                          <div className="font-medium">{evt.name}</div>
                          {evt.venue?.name && (
                            <div className="text-xs text-muted-foreground">{evt.venue.name}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs whitespace-nowrap">
                          {new Date(evt.startDate).toLocaleDateString()} – {new Date(evt.endDate).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-2">
                          {evt.alreadyImported ? (
                            <Badge variant="secondary" className="text-xs">Imported</Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs">Available</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Importing progress */}
          {step === "importing" && (
            <div className="py-8 text-center space-y-4">
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
              <div className="text-sm font-medium">{progress.step}</div>
              <div className="text-xs text-muted-foreground">
                {progress.totalCreated} created, {progress.totalSkipped} skipped
              </div>
            </div>
          )}

          {/* Done */}
          {step === "done" && (
            <div className="py-6 space-y-4">
              <div className="flex items-center justify-center gap-2">
                <CheckCircle2 className="h-6 w-6 text-green-600" />
                <span className="font-medium">Import Complete</span>
              </div>
              <div className="text-center text-sm text-muted-foreground">
                <strong>{progress.totalCreated}</strong> registrations created, <strong>{progress.totalSkipped}</strong> skipped
              </div>
              {progress.errors.length > 0 && (
                <div className="border rounded-md p-3 bg-destructive/5 max-h-32 overflow-auto">
                  <div className="flex items-center gap-1 text-sm text-destructive mb-1">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {progress.errors.length} error{progress.errors.length !== 1 ? "s" : ""}
                  </div>
                  <ul className="text-xs text-muted-foreground space-y-0.5">
                    {progress.errors.slice(0, 10).map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {step === "done" ? "Close" : "Cancel"}
          </Button>
          {step === "browse" && (
            <Button
              className="btn-gradient"
              onClick={handleImport}
              disabled={!selectedEventId || importEvent.isPending}
            >
              <Download className="h-4 w-4 mr-2" />
              Import Event
            </Button>
          )}
          {step === "done" && newEventId && (
            <Button className="btn-gradient" onClick={handleGoToEvent}>
              Go to Event
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
