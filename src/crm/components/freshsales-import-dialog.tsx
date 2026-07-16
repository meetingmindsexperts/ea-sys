"use client";

/**
 * Freshsales CSV import dialog — one component, three modes (companies /
 * contacts / deals), mounted from each CRM tab's Import button.
 *
 * The flow is DRY-RUN-FIRST by construction: picking a file runs the full
 * decision pass server-side with zero writes, and what the operator confirms
 * is that exact report — created/updated/enriched/kept-local counts, the
 * stage/event mapping notes, unrecognized columns, per-row errors. The write
 * run then executes the same decisions.
 *
 * Re-uploading a fresh export is safe by design (the whole point of the
 * conflict rule): externalId upserts converge, EA-SYS edits win over the CSV.
 */
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, FileUp, Loader2, TriangleAlert, Upload } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EventCombobox } from "@/crm/components/event-combobox";
import { apiPostJson } from "@/lib/api-fetch";

export type FreshsalesImportType = "companies" | "contacts" | "deals";

interface ImportReport {
  ok: true;
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  enriched: number;
  keptLocal: number;
  errors: Array<{ row: number; error: string }>;
  unrecognizedColumns: string[];
  notes: string[];
}

const TYPE_COPY: Record<FreshsalesImportType, { title: string; source: string }> = {
  companies: { title: "Import companies", source: "Freshsales Accounts export" },
  contacts: { title: "Import contacts", source: "Freshsales Contacts export" },
  deals: { title: "Import deals", source: "Freshsales Deals export" },
};

export function FreshsalesImportDialog({
  type,
  open,
  onOpenChange,
}: {
  type: FreshsalesImportType;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [fallbackEventId, setFallbackEventId] = useState<string | null>(null);
  const [defaultCurrency, setDefaultCurrency] = useState("USD");
  const [preview, setPreview] = useState<ImportReport | null>(null);
  const [result, setResult] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setFileName("");
    setCsv("");
    setFallbackEventId(null);
    setDefaultCurrency("USD");
    setPreview(null);
    setResult(null);
    setBusy(false);
  }

  async function post(dryRun: boolean): Promise<ImportReport | null> {
    try {
      return await apiPostJson<ImportReport>(`/api/crm/import/${type}`, {
        csv,
        dryRun,
        ...(type === "deals"
          ? { fallbackEventId, defaultCurrency: defaultCurrency.trim().toUpperCase() || "USD" }
          : {}),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
      return null;
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setPreview(null);
    setResult(null);
    setCsv(await file.text());
  }

  async function runPreview() {
    if (type === "deals" && !fallbackEventId) {
      toast.error("Pick the fallback event first — deals whose name matches no event land there");
      return;
    }
    setBusy(true);
    const report = await post(true);
    setBusy(false);
    if (report) setPreview(report);
  }

  async function runImport() {
    setBusy(true);
    const report = await post(false);
    setBusy(false);
    if (!report) return;
    setResult(report);
    setPreview(null);
    // Everything an import can touch.
    qc.invalidateQueries({ queryKey: ["crm"] });
    toast.success(
      `Imported: ${report.created} created, ${report.updated} updated${report.errors.length ? `, ${report.errors.length} row error(s)` : ""}`,
    );
  }

  const shown = result ?? preview;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{TYPE_COPY[type].title} from Freshsales</DialogTitle>
          <DialogDescription asChild>
            <span>
              Upload a {TYPE_COPY[type].source} (CSV). Nothing writes until you confirm the
              preview. Re-uploading a fresh export is safe — records converge on the Freshsales id,
              and anything you edited here since the last import keeps your version.
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="fs-file">CSV file</Label>
            <Input
              id="fs-file"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void handleFile(e.target.files?.[0])}
            />
            {fileName && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <FileUp className="h-3.5 w-3.5" />
                {fileName}
              </p>
            )}
          </div>

          {type === "deals" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>
                  Fallback event <span className="text-destructive">*</span>
                </Label>
                <EventCombobox
                  value={fallbackEventId}
                  onChange={setFallbackEventId}
                  allowClear={false}
                  placeholder="Deals with no name match land here"
                />
                <p className="text-xs text-muted-foreground">
                  Deal names are matched against your event names first (e.g. “Abbott — BRIDGES
                  2026 Gold”); only the rest use this.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="fs-currency">Default currency</Label>
                <Input
                  id="fs-currency"
                  value={defaultCurrency}
                  onChange={(e) => setDefaultCurrency(e.target.value)}
                  maxLength={3}
                  className="w-24 uppercase"
                />
                <p className="text-xs text-muted-foreground">Used when the CSV has no currency column.</p>
              </div>
            </div>
          )}

          {shown && (
            <div className="space-y-3 rounded-lg border bg-muted/20 p-3 text-sm">
              <p className="flex items-center gap-2 font-medium">
                {result ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    Imported
                  </>
                ) : (
                  <>Preview — nothing has been written yet</>
                )}
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 tabular-nums sm:grid-cols-3">
                <span>{shown.total} rows</span>
                <span>{shown.created} new</span>
                <span>{shown.updated} updated</span>
                {shown.enriched > 0 && <span>{shown.enriched} enriched (blanks filled)</span>}
                {shown.keptLocal > 0 && <span>{shown.keptLocal} kept your edits</span>}
                {shown.errors.length > 0 && (
                  <span className="text-destructive">{shown.errors.length} row error(s)</span>
                )}
              </div>

              {shown.notes.length > 0 && (
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {shown.notes.map((n, i) => (
                    <li key={i}>• {n}</li>
                  ))}
                </ul>
              )}

              {shown.unrecognizedColumns.length > 0 && (
                <p className="flex items-start gap-1.5 text-xs text-amber-700">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Columns not imported: {shown.unrecognizedColumns.join(", ")}
                </p>
              )}

              {shown.errors.length > 0 && (
                <div className="max-h-32 space-y-0.5 overflow-y-auto text-xs text-destructive">
                  {shown.errors.slice(0, 20).map((e) => (
                    <p key={e.row}>
                      Row {e.row}: {e.error}
                    </p>
                  ))}
                  {shown.errors.length > 20 && <p>… and {shown.errors.length - 20} more</p>}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {result ? "Done" : "Cancel"}
          </Button>
          {!result && !preview && (
            <Button onClick={() => void runPreview()} disabled={busy || !csv}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              Preview
            </Button>
          )}
          {!result && preview && (
            <Button onClick={() => void runImport()} disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Import {preview.created + preview.updated + preview.enriched} record
              {preview.created + preview.updated + preview.enriched === 1 ? "" : "s"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
