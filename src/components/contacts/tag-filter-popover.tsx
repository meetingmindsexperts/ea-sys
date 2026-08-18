"use client";

/**
 * Tag filter for the contacts list.
 *
 * Replaces a flat row of one pill per tag. That worked at ~4 tags and became a
 * wall at 125 (the contacts-central import added 121 of them), where the filter
 * control was taller than the table it filtered. Same pattern as the "Manage
 * events" popover in Settings → Onsite Staff: a trigger, a search box, a
 * scrollable checkbox list.
 *
 * Tags are offered frequency-first, not alphabetically. Alphabetical order puts
 * whatever happens to start with "A" at the top; frequency puts the tags people
 * actually filter by there.
 */

import { useState } from "react";
import { Check, Search, Tag as TagIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const TAG_COLORS = [
  "bg-sky-50 text-sky-700 border-sky-200",
  "bg-emerald-50 text-emerald-700 border-emerald-200",
  "bg-violet-50 text-violet-700 border-violet-200",
  "bg-amber-50 text-amber-700 border-amber-200",
  "bg-rose-50 text-rose-700 border-rose-200",
  "bg-cyan-50 text-cyan-700 border-cyan-200",
];

/** Stable per-tag colour. Exported so the page's other tag chips match. */
export function getTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) % TAG_COLORS.length;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

export interface TagUsage {
  tag: string;
  count: number;
}

export function TagFilterPopover({
  tags,
  selected,
  onToggle,
  onClear,
}: {
  /** Frequency-ordered when the API supplies counts; falls back to whatever order it gets. */
  tags: TagUsage[];
  selected: Set<string>;
  onToggle: (tag: string) => void;
  onClear: () => void;
}) {
  const [search, setSearch] = useState("");
  // Row order is frozen for the lifetime of one open popover. Re-sorting on
  // every toggle made the row you just clicked jump to the top and slid the
  // next one under the cursor, which is miserable when picking several tags in
  // a row. Recomputed on open, not on select.
  const [pinned, setPinned] = useState<ReadonlySet<string>>(selected);

  const q = search.trim().toLowerCase();
  const filtered = q ? tags.filter((t) => t.tag.toLowerCase().includes(q)) : tags;

  // Tags selected WHEN THE POPOVER OPENED sit at the top, so de-selecting never
  // requires searching for something you just clicked.
  const ordered = [
    ...filtered.filter((t) => pinned.has(t.tag)),
    ...filtered.filter((t) => !pinned.has(t.tag)),
  ];

  if (tags.length === 0) return null;

  return (
    <div className="flex w-full flex-wrap items-center gap-1.5">
      <Popover
        onOpenChange={(open) => {
          if (open) setPinned(new Set(selected));
          else setSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 shrink-0 border-gray-200 text-xs">
            <TagIcon className="mr-1.5 h-3 w-3" />
            Filter by tag
            {selected.size > 0 && (
              <span className="ml-1.5 rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-white">
                {selected.size}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <div className="border-b p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${tags.length} tags…`}
                className="h-8 pl-7 text-sm"
              />
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {ordered.length === 0 ? (
              <div className="p-3 text-center text-xs text-muted-foreground">No tags match your search.</div>
            ) : (
              ordered.map((t) => {
                const active = selected.has(t.tag);
                return (
                  <button
                    key={t.tag}
                    type="button"
                    onClick={() => onToggle(t.tag)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        active ? "border-primary bg-primary text-white" : "border-input"
                      }`}
                    >
                      {active && <Check className="h-3 w-3" />}
                    </span>
                    <span className="truncate">{t.tag}</span>
                    {/* Render nothing rather than a misleading "0" when the API
                        response predates the `usage` field. */}
                    {t.count > 0 && (
                      <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                        {t.count.toLocaleString()}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
          {selected.size > 0 && (
            <div className="border-t p-1">
              <button
                type="button"
                onClick={onClear}
                className="flex w-full items-center justify-center gap-1 rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
              >
                <X className="h-3 w-3" />
                Clear {selected.size} filter{selected.size === 1 ? "" : "s"}
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Active filters stay visible without opening the popover. */}
      {[...selected].map((tag) => (
        <button
          key={tag}
          type="button"
          onClick={() => onToggle(tag)}
          title="Remove this filter"
          className={`flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-opacity hover:opacity-70 ${getTagColor(tag)}`}
        >
          {tag}
          <X className="h-3 w-3" />
        </button>
      ))}
    </div>
  );
}
