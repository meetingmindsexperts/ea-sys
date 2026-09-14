"use client";
/**
 * One CSV import dialog for the procurement module (products, suppliers):
 * download the template, choose a file, see its first five rows, import,
 * then read the counts and every per-row message. The file travels as text
 * inside a JSON body (the module's hooks all speak JSON), which the
 * middleware caps at 1 MB, and the parser caps at 5,000 rows; the dialog
 * says both up front rather than letting a big file fail as a bare 413.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Download, FileUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { parseCSV } from "@/lib/csv-parser";
import { importTemplateCsv, type ImportColumn } from "@/procurement/lib/catalogue-import";
import type { CsvImportResult } from "@/procurement/hooks/use-procurement-api";

const MAX_BYTES = 1_000_000;
const PREVIEW_ROWS = 5;

export function ProcurementCsvImportDialog({
  open,
  onOpenChange,
  title,
  description,
  columns,
  templateFilename,
  onImport,
  pending,
  note,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  columns: readonly ImportColumn[];
  templateFilename: string;
  onImport: (csv: string) => Promise<CsvImportResult>;
  pending: boolean;
  /** One line under the columns, e.g. who approves imported rows. */
  note?: string;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [result, setResult] = useState<CsvImportResult | null>(null);

  function reset() {
    setFileName(null);
    setText(null);
    setPreview(null);
    setReadError(null);
    setResult(null);
  }

  function close(o: boolean) {
    if (!o && pending) return;
    if (!o) reset();
    onOpenChange(o);
  }

  function downloadTemplate() {
    const blob = new Blob([importTemplateCsv(columns)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = templateFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function pick(file: File | undefined) {
    setResult(null);
    setReadError(null);
    setPreview(null);
    setText(null);
    setFileName(file?.name ?? null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setReadError(`This file is ${(file.size / 1_000_000).toFixed(1)} MB; the limit is 1 MB. Split it and import in parts.`);
      return;
    }
    try {
      const t = await file.text();
      const parsed = parseCSV(t);
      if (parsed.error) {
        setReadError(parsed.error);
        return;
      }
      setText(t);
      setPreview({ headers: parsed.headers, rows: parsed.rows.slice(0, PREVIEW_ROWS) });
    } catch (err) {
      console.error("procurement-import:read-failed", err);
      setReadError("The file could not be read.");
    }
  }

  async function run() {
    if (!text) return;
    try {
      const r = await onImport(text);
      setResult(r);
      const parts = [`${r.created} created`];
      if (r.updated) parts.push(`${r.updated} updated`);
      if (r.unchanged) parts.push(`${r.unchanged} unchanged`);
      if (r.skipped) parts.push(`${r.skipped} skipped`);
      if (r.errors.length) parts.push(`${r.errors.length} with errors`);
      (r.errors.length && r.created === 0 && !r.updated ? toast.warning : toast.success)(parts.join(", ") + ".");
    } catch (err) {
      console.error("procurement-import:failed", err);
      toast.error((err as Error).message || "The import failed.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">Columns</span>
              <Button type="button" variant="outline" size="sm" onClick={downloadTemplate}><Download className="h-4 w-4" /> Download template</Button>
            </div>
            <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {columns.map((c) => (
                <li key={c.name} className="text-xs">
                  <span className="font-mono">{c.name}</span>
                  {c.required && <span className="text-destructive"> *</span>}
                  {c.hint && <span className="text-muted-foreground">, {c.hint}</span>}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">Up to 5,000 rows or 1 MB per file. Column names are matched regardless of case.{note ? ` ${note}` : ""}</p>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="procurement-import-file">CSV file</label>
            <input
              id="procurement-import-file"
              type="file"
              accept=".csv,text/csv"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
              disabled={pending}
              onChange={(e) => void pick(e.target.files?.[0])}
            />
            {readError && <p className="text-sm text-destructive">{readError}</p>}
          </div>

          {preview && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">{`${fileName}: first ${preview.rows.length} row${preview.rows.length === 1 ? "" : "s"}`}</div>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/60">
                    <tr>{preview.headers.map((h, i) => <th key={`${h}-${i}`} className="px-2 py-1 text-left font-medium">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r, i) => (
                      <tr key={i} className="border-t">
                        {preview.headers.map((_, j) => <td key={j} className="max-w-[12rem] truncate px-2 py-1">{r[j] ?? ""}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {result && (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span><strong>{result.created}</strong> created</span>
                {result.updated !== undefined && <span><strong>{result.updated}</strong> updated</span>}
                {result.unchanged !== undefined && <span className="text-muted-foreground">{result.unchanged} unchanged</span>}
                {result.skipped !== undefined && <span className="text-muted-foreground">{result.skipped} skipped</span>}
                <span className="text-muted-foreground">{result.totalProcessed} rows read</span>
              </div>
              {result.approved !== undefined && result.created > 0 && (
                <p className="text-xs text-muted-foreground">{result.approved ? "Created approved: you hold the settle grant." : "Created as Proposed: the settle holder approves them on the Suppliers page."}</p>
              )}
              {result.skippedDetails && result.skippedDetails.length > 0 && (
                <ul className="max-h-32 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-muted-foreground">
                  {result.skippedDetails.slice(0, 20).map((s, i) => <li key={i}>{s}</li>)}
                  {result.skippedDetails.length > 20 && <li>{`and ${result.skippedDetails.length - 20} more`}</li>}
                </ul>
              )}
              {result.errors.length > 0 && (
                <ul className="max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-destructive">
                  {result.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
                  {result.errors.length > 20 && <li>{`and ${result.errors.length - 20} more`}</li>}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={pending}>{result ? "Done" : "Cancel"}</Button>
          {!result && (
            <Button onClick={() => void run()} disabled={pending || !text}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />} Import
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
