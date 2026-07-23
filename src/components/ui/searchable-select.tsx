"use client";

/**
 * Searchable single-value picker — Popover + cmdk Command combobox.
 *
 * Backs CountrySelect + SpecialtySelect. Those components previously embedded
 * a text <Input> INSIDE a Radix <SelectContent>, which Radix Select does not
 * support: on mobile, each typed character fought Select's internal typeahead
 * / focus management and the dropdown dismissed after one keystroke (the
 * organizer-reported "type one letter and it vanishes" bug). The
 * Popover+Command shape is the app's proven combobox pattern (CompanyCombobox,
 * accommodation person picker) and handles touch + on-screen keyboards
 * correctly.
 *
 * Trigger is styled to visually match SelectTrigger so these sit seamlessly
 * next to real Selects in the same form row.
 */
import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "./button";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command";
import { cn } from "@/lib/utils";

export interface SearchableSelectOption {
  value: string;
  label: string;
}

export function SearchableSelect({
  value,
  displayLabel,
  onChange,
  options,
  disabled = false,
  placeholder,
  searchPlaceholder,
  emptyText,
}: {
  value: string | null | undefined;
  /** Resolved label for the current value (falls back to the raw value). */
  displayLabel?: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  disabled?: boolean;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  // Substring filter (matches the old behavior — cmdk's default fuzzy match
  // would subtly change which options surface, so we filter ourselves).
  const q = search.trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => o.label.toLowerCase().includes(q))
    : options;

  const shownLabel = value ? displayLabel || value : "";

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-9 w-full justify-between px-3 font-normal shadow-xs hover:bg-transparent"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {shownLabel || placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[240px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={searchPlaceholder}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-[220px]">
            {filtered.length === 0 && <CommandEmpty>{emptyText}</CommandEmpty>}
            {filtered.length > 0 && (
              <CommandGroup>
                {filtered.map((o) => (
                  <CommandItem
                    key={o.value}
                    value={o.value}
                    onSelect={() => {
                      onChange(o.value);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value === o.value ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="truncate">{o.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
