"use client";

/**
 * The event switcher in the header: the current event's name, and a list of
 * the person's events to jump to, with a search box (owner, Nov 12, 2026).
 *
 * A Popover with a Command list, not a DropdownMenu: a menu treats every key
 * typed as "jump to the item starting with this letter" and moves focus out
 * of any text box placed inside it. Arrow keys and Enter work from the search
 * box; the matching rule is `eventMatchesSearch`.
 */
import { useState } from "react";
import Link from "next/link";
import { Calendar, Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn, formatDate } from "@/lib/utils";
import { filterEventsBySearch, type SearchableEvent } from "@/lib/event-search";

export interface SwitcherEvent extends SearchableEvent {
  id: string;
  startDate: string | Date;
}

export function EventSwitcher({
  currentEventId,
  currentEventName,
  events,
  onSwitch,
}: {
  currentEventId: string;
  currentEventName: string;
  events: SwitcherEvent[];
  onSwitch: (eventId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const matches = filterEventsBySearch(events, search);

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };

  const pick = (eventId: string) => {
    close(false);
    if (eventId !== currentEventId) onSwitch(eventId);
  };

  return (
    <Popover open={open} onOpenChange={close}>
      <PopoverTrigger asChild>
        <Button variant="ghost" role="combobox" aria-expanded={open} aria-label="Switch event" className="flex h-auto min-w-0 items-center gap-2 py-1">
          <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-semibold">{currentEventName}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search events" value={search} onValueChange={setSearch} aria-label="Search events" />
          <CommandList className="max-h-[420px] p-1">
            <CommandEmpty>No event matches &ldquo;{search.trim()}&rdquo;.</CommandEmpty>
            {matches.length > 0 && (
              <CommandGroup heading={search.trim() ? `${matches.length} of ${events.length} events` : "Switch event"}>
                {matches.map((event) => {
                  const current = event.id === currentEventId;
                  return (
                    <CommandItem
                      key={event.id}
                      value={event.id}
                      onSelect={() => pick(event.id)}
                      className={cn("cursor-pointer gap-3 rounded-md px-3 py-2.5", current && "bg-primary/10 text-primary")}
                    >
                      <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", current ? "bg-primary text-primary-foreground" : "bg-muted")}>
                        <Calendar className="h-4 w-4" />
                      </div>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{event.name}</span>
                        <span className="text-xs text-muted-foreground">{formatDate(event.startDate)}</span>
                      </div>
                      {current && <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
          <div className="border-t p-1">
            <Link
              href="/events"
              onClick={() => close(false)}
              className="flex items-center justify-center rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              View All Events
            </Link>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
