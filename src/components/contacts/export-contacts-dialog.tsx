"use client";

import { useState } from "react";
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
import { Download } from "lucide-react";
import {
  DEFAULT_EXPORT_COLUMNS,
  EXPORT_COLUMNS,
  EXPORT_ROW_CAP,
  EXPORT_COLUMN_GROUPS,
  type ExportColumn,
} from "@/lib/contact-export";

/**
 * Choose the columns before a contacts export (Oct 23, 2026). Opens on the
 * basic set every time, so phone, bio, notes and ID numbers leave only when
 * someone ticks them. The server accepts only known columns.
 *
 * The export takes the page's filters (`filterQuery`), so it is exactly the
 * contacts the list shows; `matching` is that list's total, used to warn when
 * the file would stop at the row cap.
 */
export function ExportContactsDialog({
  open,
  onOpenChange,
  filterQuery,
  matching,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filterQuery: Record<string, string>;
  matching: number;
}) {
  const [chosen, setChosen] = useState<Set<ExportColumn>>(() => new Set(DEFAULT_EXPORT_COLUMNS));

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

  const handleExport = () => {
    const columns = EXPORT_COLUMNS.filter((c) => chosen.has(c));
    const query = new URLSearchParams({ ...filterQuery, columns: columns.join(",") });
    window.location.href = `/api/contacts/export?${query.toString()}`;
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Export contacts</DialogTitle>
          <DialogDescription>
            Choose the columns for the CSV. Only what you tick leaves the system.
          </DialogDescription>
        </DialogHeader>

        <ExportScope matching={matching} filtered={Object.keys(filterQuery).length > 0} />

        <div className="flex gap-2 text-xs">
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setChosen(new Set(EXPORT_COLUMNS))}>
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
          {EXPORT_COLUMN_GROUPS.map((group) => (
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
            {chosen.size} of {EXPORT_COLUMNS.length} columns
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleExport} disabled={chosen.size === 0}>
              <Download className="h-4 w-4 mr-1.5" />
              Export CSV
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** How many contacts the file will hold, and a warning when it would be cut short. */
function ExportScope({ matching, filtered }: { matching: number; filtered: boolean }) {
  const scope = filtered ? "match the filters on the page" : "are in your contacts (no filters set)";
  if (matching <= EXPORT_ROW_CAP) {
    return (
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">{matching.toLocaleString()}</span> contacts {scope}.
      </p>
    );
  }
  return (
    <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      <span className="font-medium tabular-nums">{matching.toLocaleString()}</span> contacts {scope}. One file holds
      at most {EXPORT_ROW_CAP.toLocaleString()}, so only the newest {EXPORT_ROW_CAP.toLocaleString()} would be included.
      Narrow the filters (specialty, country, role or tags) to export them all.
    </p>
  );
}
