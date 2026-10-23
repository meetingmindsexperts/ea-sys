"use client";

/**
 * A searchable checklist for picking several values of one field (Oct 23,
 * 2026): Specialty and Country on the Contacts page. Same shape as the tag
 * filter (trigger, search box, checkbox rows with counts, chips for what is
 * chosen) so the page has one way of picking several things.
 *
 * Rows chosen when the popover opened stay at the top while it is open, and
 * the order is not re-sorted on each click, so the next row never slides
 * under the cursor.
 */

import { useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface MultiValueOption {
  value: string;
  label: string;
  count: number;
}

export function MultiValueFilter({
  label,
  noun,
  options,
  selected,
  onChange,
  labelFor,
  disabled = false,
}: {
  /** The button's text when nothing is chosen, e.g. "All specialties". */
  label: string;
  /** Plural, for the search box and messages, e.g. "specialties". */
  noun: string;
  options: MultiValueOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** The label for a chosen value, including one no longer in `options`. */
  labelFor: (value: string) => string;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set(selected));
  const chosen = new Set(selected);

  const q = search.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  const ordered = [...filtered.filter((o) => pinned.has(o.value)), ...filtered.filter((o) => !pinned.has(o.value))];

  const toggle = (value: string) => {
    onChange(chosen.has(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  return (
    <div className="flex max-w-full flex-wrap items-center gap-1.5">
      <Popover
        onOpenChange={(open) => {
          if (open) setPinned(new Set(selected));
          else setSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="h-9 w-60 max-w-full justify-between border-input bg-field px-3 font-normal shadow-xs hover:bg-field"
          >
            <span className="truncate min-w-0">{triggerText(label, selected, labelFor)}</span>
            <span className="flex shrink-0 items-center gap-1">
              {selected.length > 1 && (
                <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-white">
                  {selected.length}
                </span>
              )}
              <ChevronDown className="h-4 w-4 opacity-50" />
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          <div className="border-b p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Type to find ${noun}…`}
                aria-label={`Search ${noun}`}
                className="h-8 pl-7 text-sm"
              />
            </div>
            <p className="mt-1.5 px-0.5 text-[11px] text-muted-foreground">
              Tick as many as you like. Contacts matching any of them are shown.
            </p>
          </div>
          <div className="max-h-72 overflow-y-auto p-1" role="listbox" aria-multiselectable="true">
            {ordered.length === 0 && (
              <div className="p-3 text-center text-xs text-muted-foreground">Nothing matches what you typed.</div>
            )}
            {ordered.map((o) => {
              const active = chosen.has(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => toggle(o.value)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      active ? "border-primary bg-primary text-white" : "border-input"
                    }`}
                  >
                    {active && <Check className="h-3 w-3" />}
                  </span>
                  <span className="truncate">{o.label}</span>
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                    {o.count.toLocaleString()}
                  </span>
                </button>
              );
            })}
          </div>
          {selected.length > 0 && (
            <div className="border-t p-1">
              <button
                type="button"
                onClick={() => onChange([])}
                className="flex w-full items-center justify-center gap-1 rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
              >
                <X className="h-3 w-3" />
                Clear {selected.length === 1 ? "this choice" : `these ${selected.length} choices`}
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* With several chosen, each shows as a chip so nothing is hidden behind "3". */}
      {selected.length > 1 &&
        selected.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => toggle(v)}
            title="Remove this choice"
            className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-xs font-medium text-primary hover:opacity-70"
          >
            {labelFor(v)}
            <X className="h-3 w-3" />
          </button>
        ))}
    </div>
  );
}

/** "All specialties", the one chosen value, or "Cardiology + 2 more". */
function triggerText(label: string, selected: string[], labelFor: (v: string) => string): string {
  if (selected.length === 0) return label;
  if (selected.length === 1) return labelFor(selected[0]);
  return `${labelFor(selected[0])} + ${selected.length - 1} more`;
}
