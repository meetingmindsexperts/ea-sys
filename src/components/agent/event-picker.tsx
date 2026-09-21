"use client";

// The event picker on the org-level Event Agent page: a searchable combobox
// (Popover + cmdk Command, the app's proven picker shape) that lists the
// organisation's events grouped by status, with the "whole organisation"
// choice on top. Colours come from the theme tokens, so it follows the
// organisation's primary colour like the rest of the dashboard.

import { useMemo, useState } from "react";
import { Building2, CalendarDays, Check, ChevronsUpDown } from "lucide-react";
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

export interface PickerEvent {
  id: string;
  name: string;
  status?: string | null;
  startDate?: string | Date | null;
  endDate?: string | Date | null;
  city?: string | null;
}

/** Same palette as the events list, so a status reads the same everywhere. */
const STATUS: Record<string, { label: string; dot: string; pill: string }> = {
  LIVE: { label: "Live", dot: "bg-green-500", pill: "bg-green-50 text-green-700 border-green-200" },
  PUBLISHED: { label: "Published", dot: "bg-primary", pill: "bg-primary/10 text-primary border-primary/20" },
  DRAFT: { label: "Draft", dot: "bg-gray-400", pill: "bg-gray-100 text-gray-600 border-gray-200" },
  COMPLETED: { label: "Completed", dot: "bg-purple-500", pill: "bg-purple-50 text-purple-700 border-purple-200" },
  CANCELLED: { label: "Cancelled", dot: "bg-red-400", pill: "bg-red-50 text-red-600 border-red-200" },
};
const GROUP_ORDER = ["LIVE", "PUBLISHED", "DRAFT", "COMPLETED", "CANCELLED"] as const;

function statusOf(e: PickerEvent) {
  return STATUS[e.status ?? ""] ?? STATUS.DRAFT;
}

function dateRange(e: PickerEvent): string {
  const fmt = (d: string | Date | null | undefined) =>
    d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" }) : "";
  const start = fmt(e.startDate);
  const end = fmt(e.endDate);
  if (!start) return "";
  return end && end !== start ? `${start} to ${end}` : start;
}

function StatusPill({ event }: { event: PickerEvent }) {
  const s = statusOf(event);
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full border px-1.5 py-0 text-[10px] font-medium", s.pill)}>
      {s.label}
    </span>
  );
}

export function EventPicker({
  events,
  value,
  onChange,
  disabled = false,
}: {
  events: PickerEvent[];
  /** Selected event id, or null for the whole organisation. */
  value: string | null;
  onChange: (eventId: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const current = value ? (events.find((e) => e.id === value) ?? null) : null;

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = q
      ? events.filter((e) => e.name.toLowerCase().includes(q) || (e.city ?? "").toLowerCase().includes(q))
      : events;
    return GROUP_ORDER.map((status) => ({
      status,
      label: STATUS[status].label,
      events: matches
        .filter((e) => (e.status ?? "DRAFT") === status)
        .sort((a, b) => String(b.startDate ?? "").localeCompare(String(a.startDate ?? ""))),
    })).filter((g) => g.events.length > 0);
  }, [events, search]);

  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Choose the event the agent works on"
          disabled={disabled}
          className="h-10 w-full justify-between gap-2 rounded-lg border-border bg-background pl-3 pr-2 font-normal shadow-xs hover:border-primary/40 hover:bg-primary/5 focus-visible:ring-primary/30 sm:w-[400px]"
        >
          <span className="flex min-w-0 items-center gap-2">
            {current ? (
              <CalendarDays className="h-4 w-4 shrink-0 text-primary" />
            ) : (
              <Building2 className="h-4 w-4 shrink-0 text-primary" />
            )}
            <span className="truncate">{current ? current.name : "Whole organisation"}</span>
            {current ? <StatusPill event={current} /> : null}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[360px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search events by name or city…" value={search} onValueChange={setSearch} />
          <CommandList className="max-h-[380px]">
            <CommandEmpty>No event matches.</CommandEmpty>
            <CommandGroup heading="Organisation">
              <CommandItem value="__org__" onSelect={() => pick(null)} className="gap-3 py-2 data-[selected=true]:bg-primary/10 data-[selected=true]:text-foreground">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Building2 className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">Whole organisation</span>
                  <span className="block truncate text-xs text-muted-foreground">Create or find an event, work across events</span>
                </span>
                <Check className={cn("h-4 w-4 shrink-0 text-primary", value === null ? "opacity-100" : "opacity-0")} />
              </CommandItem>
            </CommandGroup>
            {groups.map((g) => (
              <CommandGroup key={g.status} heading={g.label}>
                {g.events.map((e) => {
                  const s = statusOf(e);
                  const meta = [dateRange(e), e.city].filter(Boolean).join(" · ");
                  return (
                    <CommandItem key={e.id} value={e.id} onSelect={() => pick(e.id)} className="gap-3 py-2 data-[selected=true]:bg-primary/10 data-[selected=true]:text-foreground">
                      <span className={cn("mt-0.5 h-2 w-2 shrink-0 rounded-full", s.dot)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{e.name}</span>
                        {meta ? <span className="block truncate text-xs text-muted-foreground">{meta}</span> : null}
                      </span>
                      <Check className={cn("h-4 w-4 shrink-0 text-primary", value === e.id ? "opacity-100" : "opacity-0")} />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
