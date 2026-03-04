"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
  currentEvent: number;
  totalEvents: number;
  totalCreated: number;
  totalSkipped: number;
  eventsImported: number;
  errors: string[];
}

const INITIAL_PROGRESS: ImportProgress = {
  step: "",
  currentEvent: 0,
  totalEvents: 0,
  totalCreated: 0,
  totalSkipped: 0,
  eventsImported: 0,
  errors: [],
};

export function EventsAirImportDialog({ open, onOpenChange }: EventsAirImportDialogProps) {
  const router = useRouter();
  const { data: config, isLoading: configLoading } = useEventsAirConfig();
  const { data: events, isLoading: eventsLoading, refetch: fetchEvents } = useEventsAirEvents();
  const importEvent = useImportEventsAirEvent();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [yearFilter, setYearFilter] = useState<string>("__latest__");
  const [step, setStep] = useState<ImportStep>("browse");
  const [progress, setProgress] = useState<ImportProgress>(INITIAL_PROGRESS);

  const typedEvents = useMemo(() => (events ?? []) as EventsAirEvent[], [events]);

  // Extract unique years from events, sorted descending
  const years = useMemo(() => {
    const yearSet = new Set<number>();
    for (const evt of typedEvents) {
      yearSet.add(new Date(evt.startDate).getFullYear());
    }
    return Array.from(yearSet).sort((a, b) => b - a);
  }, [typedEvents]);

  // Auto-select most recent year once events load
  useEffect(() => {
    if (years.length > 0 && yearFilter === "__latest__") {
      setYearFilter(String(years[0]));
    }
  }, [years, yearFilter]);

  // Filter events by selected year
  const filteredEvents = useMemo(() => {
    if (yearFilter === "all") return typedEvents;
    const year = parseInt(yearFilter, 10);
    if (isNaN(year)) return typedEvents;
    return typedEvents.filter(
      (evt) => new Date(evt.startDate).getFullYear() === year
    );
  }, [typedEvents, yearFilter]);

  // Available (non-imported) filtered events for select-all logic
  const availableFiltered = useMemo(
    () => filteredEvents.filter((e) => !e.alreadyImported),
    [filteredEvents]
  );

  const allFilteredSelected =
    availableFiltered.length > 0 &&
    availableFiltered.every((e) => selectedIds.has(e.id));

  // Fetch events when dialog opens and config is ready
  useEffect(() => {
    if (open && config?.configured) {
      fetchEvents();
    }
  }, [open, config?.configured, fetchEvents]);

  const toggleEvent = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllFiltered = () => {
    if (allFilteredSelected) {
      // Deselect all filtered
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const e of availableFiltered) next.delete(e.id);
        return next;
      });
    } else {
      // Select all filtered
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const e of availableFiltered) next.add(e.id);
        return next;
      });
    }
  };

  const handleImport = async () => {
    if (selectedIds.size === 0) return;

    const eventsToImport = typedEvents.filter((e) => selectedIds.has(e.id));
    setStep("importing");
    setProgress({ ...INITIAL_PROGRESS, totalEvents: eventsToImport.length });

    let totalCreated = 0;
    let totalSkipped = 0;
    let eventsImported = 0;
    const allErrors: string[] = [];

    for (let i = 0; i < eventsToImport.length; i++) {
      const evt = eventsToImport[i];
      setProgress((p) => ({
        ...p,
        currentEvent: i + 1,
        step: `Creating event: ${evt.name}...`,
      }));

      try {
        // Step 1: Create event
        const result = await importEvent.mutateAsync({ eventsAirEventId: evt.id });
        const eventId = result.eventId;

        if (result.alreadyImported) {
          allErrors.push(`${evt.name}: already imported, skipped`);
          continue;
        }

        // Step 2: Import contacts in batches
        let offset = 0;
        let hasMore = true;
        let batchNum = 0;

        while (hasMore) {
          batchNum++;
          setProgress((p) => ({
            ...p,
            step: `${evt.name} — importing contacts (batch ${batchNum})...`,
          }));

          const res = await fetch(`/api/events/${eventId}/import/eventsair`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              eventsAirEventId: evt.id,
              offset,
              limit: 500,
            }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: "Request failed" }));
            allErrors.push(`${evt.name}: ${err.error || "Failed to import contacts"}`);
            break;
          }

          const data = await res.json();
          totalCreated += data.created;
          totalSkipped += data.skipped;
          if (data.errors?.length) {
            allErrors.push(...data.errors.map((e: string) => `${evt.name}: ${e}`));
          }
          hasMore = data.hasMore;
          offset = data.nextOffset;

          setProgress((p) => ({
            ...p,
            totalCreated,
            totalSkipped,
            errors: allErrors,
          }));
        }

        eventsImported++;
        setProgress((p) => ({ ...p, eventsImported }));
      } catch (err) {
        allErrors.push(`${evt.name}: ${err instanceof Error ? err.message : "Import failed"}`);
      }
    }

    setProgress({
      step: "Complete",
      currentEvent: eventsToImport.length,
      totalEvents: eventsToImport.length,
      totalCreated,
      totalSkipped,
      eventsImported,
      errors: allErrors,
    });
    setStep("done");
    toast.success(`Imported ${eventsImported} event${eventsImported !== 1 ? "s" : ""} with ${totalCreated} contacts`);
  };

  const handleClose = () => {
    setSelectedIds(new Set());
    setYearFilter("__latest__");
    setStep("browse");
    setProgress(INITIAL_PROGRESS);
    onOpenChange(false);
  };

  const handleGoToEvents = () => {
    handleClose();
    router.push("/events");
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
            Filter by year, select events, and import with all contacts and registrations.
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
            <div className="space-y-3">
              {/* Year filter + count */}
              <div className="flex items-center justify-between gap-3">
                <Select value={yearFilter} onValueChange={setYearFilter}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue placeholder="Year" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Years</SelectItem>
                    {years.map((y) => (
                      <SelectItem key={y} value={String(y)}>
                        {y}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="text-xs text-muted-foreground">
                  {filteredEvents.length} event{filteredEvents.length !== 1 ? "s" : ""}
                  {selectedIds.size > 0 && (
                    <span className="ml-1 font-medium text-foreground">
                      · {selectedIds.size} selected
                    </span>
                  )}
                </div>
              </div>

              {/* Events table */}
              <div className="border rounded-md overflow-auto max-h-[350px]">
                {filteredEvents.length === 0 ? (
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    No events found for this year
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 w-8">
                          <Checkbox
                            checked={allFilteredSelected}
                            onCheckedChange={toggleAllFiltered}
                            aria-label="Select all"
                          />
                        </th>
                        <th className="px-3 py-2 text-left font-medium">Event</th>
                        <th className="px-3 py-2 text-left font-medium">Dates</th>
                        <th className="px-3 py-2 text-left font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {filteredEvents.map((evt) => (
                        <tr
                          key={evt.id}
                          className={`cursor-pointer transition-colors ${
                            selectedIds.has(evt.id)
                              ? "bg-primary/5"
                              : "hover:bg-muted/30"
                          } ${evt.alreadyImported ? "opacity-60" : ""}`}
                          onClick={() => !evt.alreadyImported && toggleEvent(evt.id)}
                        >
                          <td className="px-3 py-2">
                            <Checkbox
                              checked={selectedIds.has(evt.id)}
                              disabled={evt.alreadyImported}
                              onCheckedChange={() => toggleEvent(evt.id)}
                              onClick={(e) => e.stopPropagation()}
                              aria-label={`Select ${evt.name}`}
                            />
                          </td>
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
            </div>
          )}

          {/* Importing progress */}
          {step === "importing" && (
            <div className="py-8 text-center space-y-4">
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
              <div className="text-sm font-medium">{progress.step}</div>
              <div className="text-xs text-muted-foreground space-y-0.5">
                <div>
                  Event {progress.currentEvent} of {progress.totalEvents}
                </div>
                <div>
                  {progress.totalCreated} contacts created, {progress.totalSkipped} skipped
                </div>
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
              <div className="text-center text-sm text-muted-foreground space-y-1">
                <div>
                  <strong>{progress.eventsImported}</strong> event{progress.eventsImported !== 1 ? "s" : ""} imported
                </div>
                <div>
                  <strong>{progress.totalCreated}</strong> contacts created, <strong>{progress.totalSkipped}</strong> skipped
                </div>
              </div>
              {progress.errors.length > 0 && (
                <div className="border rounded-md p-3 bg-destructive/5 max-h-32 overflow-auto">
                  <div className="flex items-center gap-1 text-sm text-destructive mb-1">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {progress.errors.length} issue{progress.errors.length !== 1 ? "s" : ""}
                  </div>
                  <ul className="text-xs text-muted-foreground space-y-0.5">
                    {progress.errors.slice(0, 20).map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                    {progress.errors.length > 20 && (
                      <li className="text-muted-foreground/60">
                        ...and {progress.errors.length - 20} more
                      </li>
                    )}
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
              disabled={selectedIds.size === 0 || importEvent.isPending}
            >
              <Download className="h-4 w-4 mr-2" />
              Import {selectedIds.size > 0 ? `${selectedIds.size} Event${selectedIds.size !== 1 ? "s" : ""}` : "Events"}
            </Button>
          )}
          {step === "done" && (
            <Button className="btn-gradient" onClick={handleGoToEvents}>
              Go to Events
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
