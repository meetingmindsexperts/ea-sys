"use client";

/**
 * Searchable event picker for the CRM — deal dialogs and the board/report filters.
 *
 * Replaces the plain <Select> so a long list of events is typeable rather than a
 * scroll. Options come from the CRM-gated events-lite endpoint, which returns only
 * PUBLISHED events (not drafts). `value` is the eventId or null; `clearLabel` names
 * the empty option ("No event" in a dialog, "All events" in a filter).
 */
import { useState } from "react";
import { CalendarDays, Check, ChevronsUpDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useCrmEvents } from "@/crm/hooks/use-crm-api";

export function EventCombobox({
  value,
  onChange,
  clearLabel = "No event",
  className,
}: {
  value: string | null;
  onChange: (eventId: string | null) => void;
  clearLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data: events = [] } = useCrmEvents();

  const selected = events.find((e) => e.id === value) ?? null;
  const q = search.trim().toLowerCase();
  const filtered = q ? events.filter((e) => e.name.toLowerCase().includes(q)) : events;

  function pick(id: string | null) {
    onChange(id);
    setOpen(false);
    setSearch("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("justify-between font-normal", className)}
        >
          <span className={cn("flex min-w-0 items-center gap-2 truncate", !selected && "text-muted-foreground")}>
            <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{selected ? selected.name : clearLabel}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[14rem] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search events…" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>No published events match.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__clear__" onSelect={() => pick(null)}>
                <X className="mr-2 h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">{clearLabel}</span>
              </CommandItem>
            </CommandGroup>
            {filtered.length > 0 && (
              <CommandGroup heading="Published events">
                {filtered.slice(0, 100).map((e) => (
                  <CommandItem key={e.id} value={e.id} onSelect={() => pick(e.id)}>
                    <Check className={cn("mr-2 h-4 w-4", value === e.id ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{e.name}</span>
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
