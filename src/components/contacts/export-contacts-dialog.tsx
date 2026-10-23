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
  EXPORT_COLUMN_GROUPS,
  type ExportColumn,
} from "@/lib/contact-export";

/**
 * Choose the columns before a contacts export (Oct 23, 2026). Opens on the
 * basic set every time, so phone, bio, notes and ID numbers leave only when
 * someone ticks them. The server accepts only known columns.
 */
export function ExportContactsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
    window.location.href = `/api/contacts/export?columns=${encodeURIComponent(columns.join(","))}`;
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
