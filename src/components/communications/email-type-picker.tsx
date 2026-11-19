"use client";

/**
 * The email type picker of the bulk email dialog (Nov 19, 2026).
 *
 * It replaced a plain Select. An event with a dozen saved templates made that
 * list longer than the dialog it opened from: it covered the whole dialog, the
 * built-in emails and the organiser's own templates ran together with nothing
 * between them, and the row under the pointer was the brand orange, which reads
 * as a warning (in this theme `--accent` is the orange, see globals.css).
 *
 * Here the list opens under the field at the field's width, is grouped
 * (built-in emails, then saved templates), can be searched, and marks the row
 * under the pointer in the quiet brand blue.
 *
 * The search field is always there, even for two options: it is what takes the
 * keyboard focus, and without it nothing in the popover did, so the arrow keys
 * and Enter never reached the list (review of dacfaafd).
 *
 * Popover + Command, the app's combobox pattern (searchable-select.tsx), and
 * `modal` because it always opens from inside a dialog: without it the
 * dialog's scroll lock swallows the mouse wheel over the list.
 */
import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export interface EmailTypePickerOption {
  value: string;
  label: string;
  description: string;
}

export interface EmailTypePickerGroup {
  heading: string;
  options: EmailTypePickerOption[];
}

function matches(option: EmailTypePickerOption, query: string): boolean {
  return option.label.toLowerCase().includes(query) || option.description.toLowerCase().includes(query);
}

export function EmailTypePicker({
  id,
  value,
  onChange,
  groups,
  disabled = false,
}: {
  /** Put on the button, so a <label htmlFor> can point at the picker. */
  id?: string;
  value: string;
  onChange: (value: string) => void;
  groups: EmailTypePickerGroup[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const all = groups.flatMap((g) => g.options);
  const selected = all.find((o) => o.value === value) ?? null;
  const query = search.trim().toLowerCase();
  // Filtered here, by substring: cmdk's own fuzzy match surfaces rows that
  // merely share letters with what was typed.
  const shown = groups
    .map((g) => ({ ...g, options: query ? g.options.filter((o) => matches(o, query)) : g.options }))
    .filter((g) => g.options.length > 0);
  // One group needs no heading: it would label the whole list.
  const showHeadings = groups.filter((g) => g.options.length > 0).length > 1;

  const close = () => {
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover
      modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-auto min-h-12 w-full justify-between gap-3 border-input bg-field px-3 py-2 text-left font-normal shadow-xs hover:bg-field dark:bg-field dark:hover:bg-field"
        >
          {/* min-w-0: a flex item will not shrink below its content without it, so truncate never fires. */}
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{selected?.label ?? "Select email type"}</span>
            {selected && <span className="block truncate text-xs text-muted-foreground">{selected.description}</span>}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[280px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search emails and templates..." value={search} onValueChange={setSearch} />
          <CommandList className="max-h-[min(22rem,var(--radix-popover-content-available-height))]">
            {shown.length === 0 && <CommandEmpty>No email matches.</CommandEmpty>}
            {shown.map((group) => (
              <CommandGroup key={group.heading} heading={showHeadings ? group.heading : undefined}>
                {group.options.map((o) => (
                  <CommandItem
                    key={o.value}
                    value={o.value}
                    onSelect={() => {
                      onChange(o.value);
                      close();
                    }}
                    className="items-start gap-2.5 py-2 data-[selected=true]:bg-primary/10 data-[selected=true]:text-foreground"
                  >
                    <Check className={cn("mt-0.5 text-primary", value === o.value ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{o.label}</span>
                      <span className="block text-xs text-muted-foreground">{o.description}</span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
