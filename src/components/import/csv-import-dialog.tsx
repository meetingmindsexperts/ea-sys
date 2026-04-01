"use client";

import { useState, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Upload, FileText, CheckCircle2, AlertCircle, Loader2, Download, Send } from "lucide-react";
import { toast } from "sonner";
import { useCSVImport, useSendCompletionEmails } from "@/hooks/use-api";

interface CSVImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: string;
  entityType: "registrations" | "speakers" | "sessions" | "abstracts";
  onSuccess?: () => void;
}

const ENTITY_CONFIG = {
  registrations: {
    label: "Registrations",
    required: ["email", "firstName", "lastName"],
    optional: ["organization", "jobTitle", "phone", "city", "country", "specialty", "registrationType", "tags", "dietaryReqs", "notes", "title"],
    sampleRow: ["john@example.com", "John", "Doe", "Acme Corp", "Engineer", "+971501234567", "Dubai", "UAE", "Cardiology", "General", "vip,sponsor", "Vegetarian", "VIP guest", "Dr"],
  },
  speakers: {
    label: "Speakers",
    required: ["email", "firstName", "lastName"],
    optional: ["organization", "jobTitle", "phone", "bio", "city", "country", "specialty", "registrationType", "tags", "website", "status", "title"],
    sampleRow: ["jane@example.com", "Jane", "Smith", "University Hospital", "Professor", "+971509876543", "Keynote speaker on AI in healthcare", "Dubai", "UAE", "Neurology", "Speaker", "keynote,invited", "https://example.com", "CONFIRMED", "Prof"],
  },
  sessions: {
    label: "Sessions",
    required: ["name", "startTime", "endTime"],
    optional: ["description", "location", "capacity", "track", "speakerEmails", "status"],
    sampleRow: ["Opening Keynote", "2026-06-15T09:00:00Z", "2026-06-15T10:00:00Z", "Welcome and opening remarks", "Main Hall", "500", "Plenary", "jane@example.com;john@example.com", "SCHEDULED"],
  },
  abstracts: {
    label: "Abstracts",
    required: ["title", "content", "speakerEmail"],
    optional: ["specialty", "track", "status"],
    sampleRow: ["AI in Cardiology", "This paper explores the use of artificial intelligence...", "jane@example.com", "Cardiology", "Research", "SUBMITTED"],
  },
};

export function CSVImportDialog({ open, onOpenChange, eventId, entityType, onSuccess }: CSVImportDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string[][] | null>(null);
  const [previewHeaders, setPreviewHeaders] = useState<string[] | null>(null);
  const [result, setResult] = useState<{ created: number; skipped?: number; tracksCreated?: number; errors: string[]; registrationIds?: string[] } | null>(null);
  const [sendResult, setSendResult] = useState<{ sent: number; skipped: number; errors: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importMutation = useCSVImport(eventId, entityType);
  const sendEmailsMutation = useSendCompletionEmails(eventId);
  const config = ENTITY_CONFIG[entityType];

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setFile(selected);
    setResult(null);

    // Parse preview
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) return;

      const headers = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
      setPreviewHeaders(headers);

      const previewRows = lines.slice(1, 6).map((line) =>
        line.split(",").map((f) => f.replace(/"/g, "").trim())
      );
      setPreview(previewRows);
    };
    reader.readAsText(selected);
  };

  const handleImport = async () => {
    if (!file) return;

    try {
      const data = await importMutation.mutateAsync(file);
      setResult(data);
      toast.success(`Imported ${data.created} ${config.label.toLowerCase()}`);
      onSuccess?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    }
  };

  const handleClose = () => {
    setFile(null);
    setPreview(null);
    setPreviewHeaders(null);
    setResult(null);
    setSendResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    onOpenChange(false);
  };

  const downloadTemplate = () => {
    const allColumns = [...config.required, ...config.optional];
    const headerRow = allColumns.join(",");
    // Wrap sample values in quotes to handle commas inside values
    const sampleValues = config.sampleRow.map((v) =>
      v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v
    );
    const sampleRow = sampleValues.join(",");
    const csv = headerRow + "\n" + sampleRow + "\n";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${entityType}-template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Import {config.label} from CSV
          </DialogTitle>
          <DialogDescription>
            Upload a CSV file with <strong>{config.required.join(", ")}</strong> columns (required).
            {entityType === "sessions" && (
              <> Dates must be ISO 8601 format (e.g. 2026-06-15T09:00:00Z). Separate multiple speaker emails with semicolons.</>
            )}
            {entityType === "registrations" && (
              <> Separate multiple tags with commas inside the tags field.</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto space-y-4">
          {/* File input */}
          <div className="border-2 border-dashed rounded-lg p-6 text-center">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleFileSelect}
              className="hidden"
            />
            {file ? (
              <div className="flex items-center justify-center gap-2 text-sm">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{file.name}</span>
                <Button variant="ghost" size="sm" onClick={() => { setFile(null); setPreview(null); setPreviewHeaders(null); setResult(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}>
                  Change
                </Button>
              </div>
            ) : (
              <div>
                <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                  <Upload className="h-4 w-4 mr-2" />
                  Select CSV File
                </Button>
                <p className="text-xs text-muted-foreground mt-2">Max 5,000 rows</p>
              </div>
            )}
          </div>

          {/* Column info + Download template */}
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Required:</span> {config.required.join(", ")}
              {config.optional.length > 0 && (
                <span className="ml-2"><span className="font-medium text-foreground">Optional:</span> {config.optional.join(", ")}</span>
              )}
            </div>
            <Button variant="outline" size="sm" className="text-xs shrink-0" onClick={downloadTemplate}>
              <Download className="h-3 w-3 mr-1" />
              Download Template
            </Button>
          </div>

          {/* Preview */}
          {previewHeaders && preview && !result && (
            <div className="border rounded-md overflow-auto max-h-48">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    {previewHeaders.map((h, i) => (
                      <th key={i} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">
                        {h}
                        {config.required.some((r) => r.toLowerCase() === h.toLowerCase().replace(/\s+/g, "")) && (
                          <span className="text-red-500 ml-0.5">*</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {preview.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j} className="px-2 py-1 whitespace-nowrap max-w-[150px] truncate">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Results */}
          {result && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span><strong>{result.created}</strong> created</span>
                {result.skipped !== undefined && result.skipped > 0 && (
                  <span className="text-muted-foreground">({result.skipped} skipped)</span>
                )}
                {result.tracksCreated !== undefined && result.tracksCreated > 0 && (
                  <span className="text-muted-foreground">({result.tracksCreated} tracks created)</span>
                )}
              </div>
              {result.errors.length > 0 && (
                <div className="border rounded-md p-3 bg-destructive/5 max-h-32 overflow-auto">
                  <div className="flex items-center gap-1 text-sm text-destructive mb-1">
                    <AlertCircle className="h-3.5 w-3.5" />
                    <span>{result.errors.length} error{result.errors.length !== 1 ? "s" : ""}</span>
                  </div>
                  <ul className="text-xs text-muted-foreground space-y-0.5">
                    {result.errors.slice(0, 20).map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                    {result.errors.length > 20 && (
                      <li>...and {result.errors.length - 20} more</li>
                    )}
                  </ul>
                </div>
              )}

              {/* Send Registration Forms button (registrations only) */}
              {entityType === "registrations" && result.created > 0 && result.registrationIds && result.registrationIds.length > 0 && !sendResult && (
                <div className="border-t pt-3">
                  <p className="text-xs text-muted-foreground mb-2">
                    Send registration completion forms to imported registrants so they can fill in remaining details and create their accounts.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        const data = await sendEmailsMutation.mutateAsync(result.registrationIds!);
                        setSendResult(data);
                        if (data.sent > 0) toast.success(`Sent ${data.sent} registration form${data.sent !== 1 ? "s" : ""}`);
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Failed to send emails");
                      }
                    }}
                    disabled={sendEmailsMutation.isPending}
                  >
                    {sendEmailsMutation.isPending ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Sending...</>
                    ) : (
                      <><Send className="h-4 w-4 mr-2" /> Send Registration Forms</>
                    )}
                  </Button>
                </div>
              )}

              {/* Send results */}
              {sendResult && (
                <div className="border-t pt-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <Send className="h-4 w-4 text-primary" />
                    <span><strong>{sendResult.sent}</strong> email{sendResult.sent !== 1 ? "s" : ""} sent</span>
                    {sendResult.skipped > 0 && (
                      <span className="text-muted-foreground">({sendResult.skipped} skipped — already have accounts)</span>
                    )}
                  </div>
                  {sendResult.errors.length > 0 && (
                    <ul className="text-xs text-destructive space-y-0.5">
                      {sendResult.errors.map((err, i) => <li key={i}>{err}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              className="btn-gradient"
              onClick={handleImport}
              disabled={!file || importMutation.isPending}
            >
              {importMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Importing...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Import
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Convenience button that opens the dialog
export function CSVImportButton({
  eventId,
  entityType,
  onSuccess,
}: {
  eventId: string;
  entityType: "registrations" | "speakers" | "sessions" | "abstracts";
  onSuccess?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Upload className="h-4 w-4 mr-1.5" />
        Import CSV
      </Button>
      <CSVImportDialog
        open={open}
        onOpenChange={setOpen}
        eventId={eventId}
        entityType={entityType}
        onSuccess={onSuccess}
      />
    </>
  );
}
