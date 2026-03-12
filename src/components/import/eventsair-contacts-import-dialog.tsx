"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
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
} from "@/hooks/use-api";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";

interface EventsAirEvent {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  venue?: { name: string };
  alreadyImported: boolean;
}

interface EventsAirContactsImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ImportStep = "browse" | "importing" | "done";

interface ImportProgress {
  step: string;
  currentEvent: number;
  totalEvents: number;
  totalCreated: number;
  totalUpdated: number;
  totalSkipped: number;
  errors: string[];
}

const INITIAL_PROGRESS: ImportProgress = {
  step: "",
  currentEvent: 0,
  totalEvents: 0,
  totalCreated: 0,
  totalUpdated: 0,
  totalSkipped: 0,
  errors: [],
};

export function EventsAirContactsImportDialog({ open, onOpenChange }: EventsAirContactsImportDialogProps) {
  const { data: config, isLoading: configLoading } = useEventsAirConfig();
  const { data: events, isLoading: eventsLoading, refetch: fetchEvents, isError: eventsError, error: eventsErrorDetail } = useEventsAirEvents();
  const queryClient = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [yearFilter, setYearFilter] = useState<string>("__latest__");
  const [step, setStep] = useState<ImportStep>("browse");
  const [progress, setProgress] = useState<ImportProgress>(INITIAL_PROGRESS);
  const importAbortRef = useRef(false);

  const typedEvents = useMemo(() => (events ?? []) as EventsAirEvent[], [events]);

  const years = useMemo(() => {
    const yearSet = new Set<number>();
    for (const evt of typedEvents) {
      yearSet.add(new Date(evt.startDate).getFullYear());
    }
    return Array.from(yearSet).sort((a, b) => b - a);
  }, [typedEvents]);

  useEffect(() => {
    if (years.length > 0 && yearFilter === "__latest__") {
      setYearFilter(String(years[0]));
    }
  }, [years, yearFilter]);

  const filteredEvents = useMemo(() => {
    if (yearFilter === "all") return typedEvents;
    const year = parseInt(yearFilter, 10);
    if (isNaN(year)) return typedEvents;
    return typedEvents.filter(
      (evt) => new Date(evt.startDate).getFullYear() === year
    );
  }, [typedEvents, yearFilter]);

  useEffect(() => {
    if (open && config?.configured) {
      fetchEvents();
    }
  }, [open, config?.configured, fetchEvents]);

  const runImportInBackground = useCallback(async (evtId: string, evtName: string) => {
    const toastId = toast.loading(`Importing contacts from "${evtName}"…`, { duration: Infinity });

    let totalCreated = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    const allErrors: string[] = [];
    let offset = 0;
    let hasMore = true;
    let batchNum = 0;

    try {
      while (hasMore && !importAbortRef.current) {
        batchNum++;
        toast.loading(`Importing "${evtName}" (batch ${batchNum})…`, { id: toastId, duration: Infinity });

        const res = await fetch("/api/contacts/import-eventsair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            eventsAirEventId: evtId,
            offset,
            limit: 50,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
          allErrors.push(err.error || `Failed to import contacts (${res.status})`);
          break;
        }

        const data = await res.json();
        totalCreated += data.created;
        totalUpdated += data.updated;
        totalSkipped += data.skipped;
        if (data.errors?.length) {
          allErrors.push(...data.errors);
        }
        hasMore = data.hasMore;
        offset = data.nextOffset;
      }
    } catch (err) {
      allErrors.push(err instanceof Error ? err.message : "Import failed");
    }

    toast.dismiss(toastId);
    if (allErrors.length > 0) {
      toast.warning(
        `Imported ${totalCreated} contacts, updated ${totalUpdated}` +
        (allErrors.length > 0 ? ` (${allErrors.length} issues)` : "")
      );
    } else {
      toast.success(`Imported ${totalCreated} contacts, updated ${totalUpdated}`);
    }

    // Refresh contacts data
    queryClient.invalidateQueries({ queryKey: ["contacts"] });

    return { totalCreated, totalUpdated, totalSkipped, errors: allErrors };
  }, [queryClient]);

  const handleImport = async () => {
    if (!selectedId) return;

    const evt = typedEvents.find((e) => e.id === selectedId);
    if (!evt) return;

    importAbortRef.current = false;
    setStep("importing");
    setProgress({ ...INITIAL_PROGRESS, totalEvents: 1 });

    let totalCreated = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    const allErrors: string[] = [];

    let offset = 0;
    let hasMore = true;
    let batchNum = 0;

    try {
      while (hasMore) {
        batchNum++;
        setProgress((p) => ({
          ...p,
          currentEvent: 1,
          step: `Importing contacts from "${evt.name}" (batch ${batchNum})...`,
        }));

        const res = await fetch("/api/contacts/import-eventsair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            eventsAirEventId: evt.id,
            offset,
            limit: 50,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
          allErrors.push(err.error || `Failed to import contacts (${res.status})`);
          break;
        }

        const data = await res.json();
        totalCreated += data.created;
        totalUpdated += data.updated;
        totalSkipped += data.skipped;
        if (data.errors?.length) {
          allErrors.push(...data.errors);
        }
        hasMore = data.hasMore;
        offset = data.nextOffset;

        setProgress((p) => ({
          ...p,
          totalCreated,
          totalUpdated,
          totalSkipped,
          errors: allErrors,
        }));
      }
    } catch (err) {
      allErrors.push(err instanceof Error ? err.message : "Import failed");
    }

    setProgress({
      step: "Complete",
      currentEvent: 1,
      totalEvents: 1,
      totalCreated,
      totalUpdated,
      totalSkipped,
      errors: allErrors,
    });
    setStep("done");
    toast.success(`Imported ${totalCreated} contacts, updated ${totalUpdated}`);
    queryClient.invalidateQueries({ queryKey: ["contacts"] });
  };

  const handleRunInBackground = () => {
    if (!selectedId) return;
    const evt = typedEvents.find((e) => e.id === selectedId);
    if (!evt) return;

    // Close dialog and run import via toast notifications
    handleClose();
    runImportInBackground(evt.id, evt.name);
  };

  const handleClose = () => {
    setSelectedId(null);
    setYearFilter("__latest__");
    setStep("browse");
    setProgress(INITIAL_PROGRESS);
    onOpenChange(false);
  };

  const isConfigured = config?.configured;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="h-5 w-5" />
            Import Contacts from EventsAir
          </DialogTitle>
          <DialogDescription>
            Select an EventsAir event to import its contacts into your organization&apos;s contact store.
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
          {(configLoading || eventsLoading) && isConfigured && !eventsError && (
            <div className="flex items-center justify-center py-8 gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading events...
            </div>
          )}

          {/* Error loading events */}
          {eventsError && isConfigured && !eventsLoading && (
            <div className="text-center py-8 space-y-3">
              <AlertCircle className="h-8 w-8 mx-auto text-destructive" />
              <p className="text-sm text-destructive">
                Failed to load events from EventsAir
              </p>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                {eventsErrorDetail instanceof Error ? eventsErrorDetail.message : "Check your EventsAir credentials in Settings."}
              </p>
              <div className="flex items-center justify-center gap-2">
                <Button onClick={() => fetchEvents()} variant="outline" size="sm">
                  Retry
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href="/settings">Check Settings</Link>
                </Button>
              </div>
            </div>
          )}

          {/* Browse events — single-select */}
          {step === "browse" && isConfigured && events && !eventsLoading && !eventsError && (
            <div className="space-y-3">
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
                  {selectedId && (
                    <span className="ml-1 font-medium text-foreground">
                      · 1 selected
                    </span>
                  )}
                </div>
              </div>

              <div className="border rounded-md overflow-auto max-h-[350px]">
                {filteredEvents.length === 0 ? (
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    No events found for this year
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
                      {filteredEvents.map((evt) => (
                        <tr
                          key={evt.id}
                          className={`cursor-pointer transition-colors ${
                            selectedId === evt.id
                              ? "bg-primary/5"
                              : "hover:bg-muted/30"
                          }`}
                          onClick={() => setSelectedId(selectedId === evt.id ? null : evt.id)}
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
                              <Badge variant="secondary" className="text-xs">Event Imported</Badge>
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
                  {progress.totalCreated} created, {progress.totalUpdated} updated, {progress.totalSkipped} skipped
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
                  <strong>{progress.totalCreated}</strong> created, <strong>{progress.totalUpdated}</strong> updated, <strong>{progress.totalSkipped}</strong> skipped
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
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={handleRunInBackground}
                disabled={!selectedId}
              >
                <Download className="h-4 w-4 mr-2" />
                Import in Background
              </Button>
              <Button
                className="btn-gradient"
                onClick={handleImport}
                disabled={!selectedId}
              >
                <Download className="h-4 w-4 mr-2" />
                Import Contacts
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
