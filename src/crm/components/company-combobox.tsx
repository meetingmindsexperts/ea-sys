"use client";

/**
 * Pick an existing account for a deal — or create one inline.
 *
 * Replaces the old free-text + <datalist> combobox, which didn't make "choose an
 * existing company" obvious (datalist rendering is inconsistent across browsers and
 * reads as a plain text field). This is an explicit searchable picker: type to
 * filter the org's accounts, pick one, or — only when nothing matches — create a
 * new account from what you typed.
 *
 * A picked account carries its `id`; a to-be-created one carries `{ id: null, name }`
 * and the dialog find-or-creates it on save (the server dedups, so typing a name
 * that already exists still links rather than duplicating).
 */
import { useState } from "react";
import { Building2, Check, ChevronsUpDown, Plus, X } from "lucide-react";
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
import { useCrmCompanies } from "@/crm/hooks/use-crm-api";

export interface CompanySelection {
  /** null → a new account to be created (find-or-create) from `name` on save. */
  id: string | null;
  name: string;
}

export function CompanyCombobox({
  value,
  onChange,
  placeholder = "Select or create a company…",
}: {
  value: CompanySelection | null;
  onChange: (value: CompanySelection | null) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data: companies = [] } = useCrmCompanies();

  const trimmed = search.trim();
  const q = trimmed.toLowerCase();
  const filtered = q ? companies.filter((c) => c.name.toLowerCase().includes(q)) : companies;
  const exactMatch = companies.some((c) => c.name.trim().toLowerCase() === q);

  function pick(next: CompanySelection | null) {
    onChange(next);
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
          className="w-full justify-between font-normal"
        >
          <span className={cn("flex min-w-0 items-center gap-2 truncate", !value && "text-muted-foreground")}>
            <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{value ? value.name : placeholder}</span>
            {value && value.id === null && (
              <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                new
              </span>
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        {/* shouldFilter=false — we filter ourselves so the "Create …" affordance can
            live alongside real matches without cmdk hiding it. */}
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search accounts…" value={search} onValueChange={setSearch} />
          <CommandList>
            {filtered.length === 0 && !trimmed && <CommandEmpty>No accounts yet.</CommandEmpty>}

            {value && (
              <CommandGroup>
                <CommandItem value="__clear__" onSelect={() => pick(null)}>
                  <X className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">No company</span>
                </CommandItem>
              </CommandGroup>
            )}

            {filtered.length > 0 && (
              <CommandGroup heading="Existing accounts">
                {filtered.slice(0, 50).map((c) => (
                  <CommandItem key={c.id} value={c.id} onSelect={() => pick({ id: c.id, name: c.name })}>
                    <Check className={cn("mr-2 h-4 w-4", value?.id === c.id ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{c.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {trimmed && !exactMatch && (
              <CommandGroup heading="Create new">
                <CommandItem value="__create__" onSelect={() => pick({ id: null, name: trimmed })}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create &ldquo;{trimmed}&rdquo;
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
