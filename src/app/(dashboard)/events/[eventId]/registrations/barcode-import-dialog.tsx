"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScanBarcode, Upload, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/use-api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface BarcodeImportDialogProps {
  eventId: string;
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
  /** Ownerless codes added to the spare pool for the desk. */
  pooled?: number;
  /** Codes already in this event's pool — a harmless re-import. */
  poolDuplicates?: number;
}

/**
 * DTCM issues a BLOCK of codes before a Dubai event. Most get mapped onto
 * people who already registered; the leftovers are what the desk hands to
 * walk-ups on the day. Those are two different files with two different
 * intents, so the operator says which one this is.
 *
 * The mode is DECLARED rather than sniffed from the headers on purpose: a
 * column called `attendee_email` looks exactly like no owner column at all, and
 * guessing "spares" there would quietly convert a whole file of assignments
 * into unclaimed codes.
 */
type ImportMode = "assign" | "spares";

const MODES: Array<{ value: ImportMode; label: string; hint: string }> = [
  {
    value: "assign",
    label: "Assign to people",
    hint: "Needs a registrationId or email column alongside barcode. Rows with a code but no owner are added to the spare pool.",
  },
  {
    value: "spares",
    label: "Spare codes for the desk",
    hint: "A barcode column is enough. Rows that do name someone are still assigned to them.",
  },
];

export function BarcodeImportDialog({ eventId }: BarcodeImportDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<ImportMode>("assign");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setFileName(file?.name || null);
    setResult(null);
  };

  const handleImport = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast.error("Please select a CSV file");
      return;
    }

    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("mode", mode);

      const res = await fetch(`/api/events/${eventId}/import/barcodes`, {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        // The missing-owner-column message names the columns we found and the
        // way out, so give it time to be read.
        toast.error(data.error || "Import failed", {
          duration: data.code === "MISSING_OWNER_COLUMN" ? 12000 : undefined,
        });
        return;
      }

      setResult(data);

      // Report BOTH numbers. A spares-only file assigns nothing, and saying
      // "0 imported" for a successful import of 200 codes reads as a failure.
      const assigned: number = data.imported ?? 0;
      const pooled: number = data.pooled ?? 0;
      const poolDuplicates: number = data.poolDuplicates ?? 0;
      const parts: string[] = [];
      if (assigned > 0) parts.push(`${assigned} assigned`);
      if (pooled > 0) parts.push(`${pooled} added as spare${pooled === 1 ? "" : "s"}`);

      if (parts.length > 0) {
        toast.success(parts.join(", "));
      } else if (poolDuplicates > 0) {
        toast.info(
          `Nothing new — ${poolDuplicates} code${poolDuplicates === 1 ? " was" : "s were"} already in the pool.`,
        );
      } else {
        toast.warning("Nothing was imported. Check the errors below.");
      }

      if (assigned > 0) {
        queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
      }
      if (pooled > 0 || assigned > 0) {
        queryClient.invalidateQueries({ queryKey: queryKeys.dtcmPool(eventId) });
      }
    } catch {
      toast.error("Import failed");
    } finally {
      setLoading(false);
    }
  };

  const handleClose = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) {
      setResult(null);
      setFileName(null);
      setMode("assign");
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const activeMode = MODES.find((m) => m.value === mode)!;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ScanBarcode className="mr-2 h-4 w-4" />
          Import Barcodes
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import DTCM Barcodes</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">What is in this file?</p>
            <div className="grid grid-cols-2 gap-2">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => {
                    setMode(m.value);
                    setResult(null);
                  }}
                  disabled={loading}
                  aria-pressed={mode === m.value}
                  className={cn(
                    "rounded-md border px-3 py-2 text-sm transition-colors disabled:opacity-60",
                    mode === m.value
                      ? "border-primary bg-primary/10 font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{activeMode.hint}</p>
          </div>

          <div className="border-2 border-dashed rounded-lg p-6 text-center">
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              className="hidden"
              id="barcode-csv"
            />
            <label htmlFor="barcode-csv" className="cursor-pointer">
              <Upload className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-sm font-medium">
                {fileName || "Click to select CSV file"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {mode === "spares"
                  ? "CSV with a barcode column"
                  : "CSV with registrationId/email and barcode columns"}
              </p>
            </label>
          </div>

          {result && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <span className="flex items-center gap-1 text-green-600">
                  <CheckCircle2 className="h-4 w-4" />
                  {result.imported} assigned
                </span>
                {(result.pooled ?? 0) > 0 && (
                  <span className="flex items-center gap-1 text-cyan-700">
                    <ScanBarcode className="h-4 w-4" />
                    {result.pooled} added as spares
                  </span>
                )}
                {(result.poolDuplicates ?? 0) > 0 && (
                  <span className="text-muted-foreground">
                    {result.poolDuplicates} already in the pool
                  </span>
                )}
                {result.skipped > 0 && (
                  <span className="text-muted-foreground">{result.skipped} skipped</span>
                )}
                {result.errors.length > 0 && (
                  <span className="flex items-center gap-1 text-red-600">
                    <AlertCircle className="h-4 w-4" />
                    {result.errors.length} errors
                  </span>
                )}
              </div>
              {result.errors.length > 0 && (
                <div className="max-h-32 overflow-y-auto bg-red-50 rounded-md p-3 text-xs text-red-700 space-y-1">
                  {result.errors.map((err, i) => (
                    <p key={i}>{err}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => handleClose(false)}>
              {result ? "Done" : "Cancel"}
            </Button>
            {!result && (
              <Button onClick={handleImport} disabled={loading || !fileName}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Import
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
