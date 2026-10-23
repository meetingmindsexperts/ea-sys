"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Download, Loader2 } from "lucide-react";
import { contactExportFileName } from "@/lib/contact-filters";
import {
  DEFAULT_EXPORT_COLUMNS,
  EXPORT_COLUMNS,
  EXPORT_ROW_CAP,
  EXPORT_COLUMN_GROUPS,
  SENSITIVE_EXPORT_COLUMNS,
  type ExportColumn,
} from "@/lib/contact-export";
import { useCan } from "@/hooks/use-can";

/**
 * Choose the columns before a contacts export (Oct 23, 2026). Opens on the
 * basic set every time, so phone, bio, notes and ID numbers leave only when
 * someone ticks them. The server accepts only known columns.
 *
 * The export takes the page's filters (`filterQuery`), so it is exactly the
 * contacts the list shows. The dialog names those filters in words, because a
 * filter set an hour ago is easy to forget. `matching` is the list's total, or
 * null while the list is still counting (review M1: a 0 or stale count let an
 * export skip the over-cap warning).
 *
 * The file is fetched, not navigated to (review M3): a refusal or a failure
 * becomes a plain toast instead of replacing the tab with raw JSON, and a file
 * cut at the cap says so.
 */
export function ExportContactsDialog({
  open,
  onOpenChange,
  filterQuery,
  filterSummary,
  matching,
  onClearFilters,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filterQuery: Record<string, string>;
  /** The active filters in words, e.g. "Country: India". Empty when none. */
  filterSummary: string[];
  matching: number | null;
  onClearFilters: () => void;
}) {
  // Phone, notes and the ID numbers only for whoever may export them (D4,
  // Oct 23, 2026); the server refuses them too.
  const canExportSensitive = useCan("contacts.export.sensitive") === "allowed";
  const offered = canExportSensitive ? EXPORT_COLUMNS : EXPORT_COLUMNS.filter((c) => !SENSITIVE_EXPORT_COLUMNS.includes(c));
  const groups = EXPORT_COLUMN_GROUPS.map((g) => ({ ...g, columns: g.columns.filter((c) => offered.includes(c.key)) })).filter(
    (g) => g.columns.length > 0,
  );
  const [chosen, setChosen] = useState<Set<ExportColumn>>(() => new Set(DEFAULT_EXPORT_COLUMNS));
  const [busy, setBusy] = useState(false);

  // Reset on CLOSE, not open: the page opens this by setting `open`, and Radix
  // calls onOpenChange only for the user's own open/close, so a reset on open
  // never ran and the last export's ticks (phone, notes) came back.
  const handleOpenChange = (next: boolean) => {
    if (!next) setChosen(new Set(DEFAULT_EXPORT_COLUMNS));
    onOpenChange(next);
  };

  const toggle = (key: ExportColumn, on: boolean) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const handleExport = async () => {
    const columns = EXPORT_COLUMNS.filter((c) => chosen.has(c));
    const query = new URLSearchParams({ ...filterQuery, columns: columns.join(",") });
    setBusy(true);
    try {
      const res = await fetch(`/api/contacts/export?${query.toString()}`);
      if (!res.ok) {
        toast.error(await exportErrorMessage(res));
        return;
      }
      saveBlob(await res.blob(), contactExportFileName(filterQuery));
      announceDownload(res, columns.length);
      handleOpenChange(false);
    } catch (err) {
      console.error("[contacts] export failed", err);
      toast.error("The export could not be downloaded. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const counting = matching === null;
  const nothingToExport = matching === 0;
  const overCap = (matching ?? 0) > EXPORT_ROW_CAP;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Export contacts</DialogTitle>
          <DialogDescription>
            Choose the columns for the CSV. Only what you tick leaves the system. The list starts on the basic
            columns each time
            {canExportSensitive
              ? ": tick Phone, Notes or the ID numbers when you need them."
              : ". Phone, notes and ID numbers are not part of your access."}
          </DialogDescription>
        </DialogHeader>

        <ExportScope matching={matching} filterSummary={filterSummary} onClearFilters={onClearFilters} />

        <div className="flex gap-2 text-xs">
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setChosen(new Set(offered))}>
            Select all
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setChosen(new Set(DEFAULT_EXPORT_COLUMNS))}>
            Basic set
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setChosen(new Set())}>
            Clear
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 max-h-[55vh] overflow-y-auto pr-1">
          {groups.map((group) => (
            <fieldset key={group.label} className="space-y-2">
              <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                {group.label}
              </legend>
              {group.columns.map((col) => {
                const id = `export-col-${col.key}`;
                return (
                  <div key={col.key} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={chosen.has(col.key)}
                      onCheckedChange={(v) => toggle(col.key, v === true)}
                    />
                    <Label htmlFor={id} className="text-sm font-normal cursor-pointer">
                      {col.label}
                    </Label>
                  </div>
                );
              })}
            </fieldset>
          ))}
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground tabular-nums">
            {chosen.size === 0 ? "Tick at least one column" : `${chosen.size} of ${offered.length} columns`}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={handleExport} disabled={busy || counting || nothingToExport || chosen.size === 0}>
              {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}
              {exportButtonLabel(busy, overCap)}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function exportButtonLabel(busy: boolean, overCap: boolean): string {
  if (busy) return "Preparing file…";
  if (overCap) return `Export newest ${EXPORT_ROW_CAP.toLocaleString()}`;
  return "Export CSV";
}

/** The refusal in plain words; the rate limit says when to try again. */
async function exportErrorMessage(res: Response): Promise<string> {
  if (res.status === 429) {
    const seconds = Number(res.headers.get("Retry-After")) || 0;
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `You have reached the limit of 10 exports an hour. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ? `Export failed: ${body.error}` : "Export failed. Please try again.";
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Confirms what was downloaded, and says so plainly when the cap cut it short. */
function announceDownload(res: Response, columnCount: number) {
  const rows = Number(res.headers.get("X-Export-Rows")) || 0;
  const matching = Number(res.headers.get("X-Export-Matching")) || 0;
  if (res.headers.get("X-Export-Truncated")) {
    toast.warning(`Downloaded ${rows.toLocaleString()} of ${matching.toLocaleString()} contacts (newest first).`, {
      description: "One file holds at most 25,000. Narrow the filters and export again to get the rest.",
      duration: 15000,
    });
    return;
  }
  toast.success(`Downloaded ${rows.toLocaleString()} contact${rows === 1 ? "" : "s"}, ${columnCount} column${columnCount === 1 ? "" : "s"}.`);
}

/**
 * Which contacts the file will hold, in words: the filters by name, the count,
 * and a warning when the count is over the cap or zero.
 */
function ExportScope({
  matching,
  filterSummary,
  onClearFilters,
}: {
  matching: number | null;
  filterSummary: string[];
  onClearFilters: () => void;
}) {
  const filtered = filterSummary.length > 0;
  return (
    <div className="space-y-2 text-sm">
      {filtered && (
        <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100">
          <p>
            <strong>Only contacts matching the filters on the page:</strong> {filterSummary.join(" · ")}.
          </p>
          <button type="button" onClick={onClearFilters} className="mt-1 text-xs font-medium underline underline-offset-2">
            Clear the filters to export everyone
          </button>
        </div>
      )}
      <ExportCount matching={matching} filtered={filtered} />
    </div>
  );
}

function ExportCount({ matching, filtered }: { matching: number | null; filtered: boolean }) {
  if (matching === null) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Counting matching contacts…
      </p>
    );
  }
  if (matching === 0) {
    return (
      <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
        No contacts match these filters, so there is nothing to export. Change or clear the filters first.
      </p>
    );
  }
  const scope = filtered ? "will be exported" : "will be exported (all your contacts, no filters set)";
  if (matching <= EXPORT_ROW_CAP) {
    return (
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">{matching.toLocaleString()}</span> contact
        {matching === 1 ? "" : "s"} {scope}.
      </p>
    );
  }
  return (
    <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      <span className="font-medium tabular-nums">{matching.toLocaleString()}</span> contacts match, but one file holds
      at most {EXPORT_ROW_CAP.toLocaleString()}. Only the newest {EXPORT_ROW_CAP.toLocaleString()} will be in the file.
      Tip: filter by Country or Specialty and export in parts.
    </p>
  );
}
