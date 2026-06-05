"use client";

/**
 * Searchable multi-select tag filter for the registrations list page.
 *
 * Lives in a Popover with a command-list pattern: type to search, click
 * to toggle. Selected tags appear as removable chips above the list.
 * The list shows all tags that exist on attendees registered for the
 * event (fetched via useEventTags()), with usage counts on the right.
 *
 * Stateless: receives `selected` + `onChange`; the parent owns the
 * source of truth. Empty selected array = "no filter" (the list page
 * collapses this case so the URL doesn't carry an empty tags=).
 *
 * Performance: the Command primitive does its own filter — we feed it
 * every tag and rely on it to narrow as the user types. For >500 tags
 * we'd cap visible suggestions, but the realistic max here is dozens.
 */

import { useState } from "react";
import { ChevronDown, Loader2, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

interface TagFilterProps {
  tags: Array<{ tag: string; count: number }> | undefined;
  isLoading: boolean;
  selected: string[];
  onChange: (next: string[]) => void;
  /** Optional class to size the trigger button. */
  className?: string;
}

export function TagFilter({
  tags,
  isLoading,
  selected,
  onChange,
  className,
}: TagFilterProps) {
  const [open, setOpen] = useState(false);

  const allTags = tags ?? [];
  const selectedSet = new Set(selected);
  const summary =
    selected.length === 0
      ? "Filter by tag"
      : selected.length === 1
        ? selected[0]
        : `${selected.length} tags`;

  const toggle = (tag: string) => {
    onChange(
      selectedSet.has(tag)
        ? selected.filter((t) => t !== tag)
        : [...selected, tag],
    );
  };

  const clearAll = () => onChange([]);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "h-9 justify-between gap-2 min-w-[160px]",
              selected.length > 0 && "border-primary/40 bg-primary/5",
            )}
          >
            <span className="flex items-center gap-1.5 truncate">
              <Tag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{summary}</span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[280px] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search tags..." />
            <CommandList>
              {isLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <>
                  <CommandEmpty>No tags found.</CommandEmpty>
                  {allTags.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                      No tags have been added to attendees on this event yet.
                    </div>
                  ) : (
                    <CommandGroup>
                      {allTags.map(({ tag, count }) => {
                        const isSelected = selectedSet.has(tag);
                        return (
                          <CommandItem
                            key={tag}
                            value={tag}
                            onSelect={() => toggle(tag)}
                            className="flex items-center gap-2"
                          >
                            <div
                              className={cn(
                                "flex h-4 w-4 items-center justify-center rounded border",
                                isSelected
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-muted-foreground/40",
                              )}
                            >
                              {isSelected ? (
                                <svg
                                  width="10"
                                  height="10"
                                  viewBox="0 0 12 12"
                                  fill="none"
                                  xmlns="http://www.w3.org/2000/svg"
                                  aria-hidden
                                >
                                  <path
                                    d="M2.5 6.5L5 9L9.5 3.5"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              ) : null}
                            </div>
                            <span className="flex-1 truncate">{tag}</span>
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {count}
                            </span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  )}
                </>
              )}
            </CommandList>
          </Command>
          {selected.length > 0 ? (
            <div className="border-t p-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-center text-xs h-7"
                onClick={clearAll}
              >
                Clear {selected.length} tag{selected.length === 1 ? "" : "s"}
              </Button>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>

      {/* Inline chips for selected tags — visible at-a-glance so the
          operator knows what's active without re-opening the dropdown.
          Each chip has an × to remove individually. */}
      {selected.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {selected.map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className="gap-1 pr-1"
            >
              <span>{tag}</span>
              <button
                type="button"
                onClick={() => toggle(tag)}
                className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
                aria-label={`Remove tag ${tag}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
