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

interface BarcodeImportDialogProps {
  eventId: string;
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export function BarcodeImportDialog({ eventId }: BarcodeImportDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
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

      const res = await fetch(`/api/events/${eventId}/import/barcodes`, {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Import failed");
        return;
      }

      setResult(data);
      if (data.imported > 0) {
        toast.success(`${data.imported} barcode(s) imported`);
        queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
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
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ScanBarcode className="mr-2 h-4 w-4" />
          Import Barcodes
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import Barcodes from CSV</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Upload a CSV with <code className="text-xs bg-muted px-1 py-0.5 rounded">registrationId</code> (or <code className="text-xs bg-muted px-1 py-0.5 rounded">email</code>) and <code className="text-xs bg-muted px-1 py-0.5 rounded">barcode</code> columns.
          </p>

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
                CSV with registrationId/email and barcode columns
              </p>
            </label>
          </div>

          {result && (
            <div className="space-y-2">
              <div className="flex items-center gap-4 text-sm">
                <span className="flex items-center gap-1 text-green-600">
                  <CheckCircle2 className="h-4 w-4" />
                  {result.imported} imported
                </span>
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
