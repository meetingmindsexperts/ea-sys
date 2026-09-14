"use client";
/**
 * The catalogue picker on the line form: a searchable list of the active
 * products (SKU and name, grouped by category). Picking one fills the line's
 * description and category; the line stays free text afterwards. The list is
 * filtered here, not by cmdk, so a SKU search ("5103") and a word search
 * ("kiosk") behave the same.
 */
import { useMemo, useState } from "react";
import { Check, ChevronDown, Package, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import type { BudgetProductRow } from "@/procurement/hooks/use-procurement-api";

const MAX_SHOWN = 80;

export function ProductPicker({ products, loading, value, onPick, onClear }: {
  products: BudgetProductRow[];
  loading?: boolean;
  value: string | null;
  onPick: (product: BudgetProductRow) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const current = value ? products.find((p) => p.id === value) ?? null : null;

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const active = products.filter((p) => p.isActive || p.id === value);
    const hits = (q ? active.filter((p) => p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) : active).slice(0, MAX_SHOWN);
    const byCategory = new Map<string, BudgetProductRow[]>();
    for (const p of hits) {
      const key = p.category.name;
      byCategory.set(key, [...(byCategory.get(key) ?? []), p]);
    }
    return [...byCategory.entries()];
  }, [products, search, value]);

  return (
    <div className="flex gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {/* The empty state is styled as an action (accent border and text, a
              search icon, a down chevron) so it reads as "click me" rather
              than as an empty field; once a product is picked it settles back
              to a plain value row. */}
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            title="Search the catalogue by SKU or name"
            className={cn(
              "h-9 w-full justify-between font-normal",
              !current && !loading && "border-primary/50 text-primary hover:border-primary hover:bg-primary/5 hover:text-primary",
            )}
            disabled={loading}
          >
            <span className="flex min-w-0 items-center gap-2">
              {current ? <Package className="h-4 w-4 shrink-0 text-muted-foreground" /> : <Search className="h-4 w-4 shrink-0" />}
              <span className="truncate">{current ? `${current.sku} · ${current.name}` : loading ? "Loading the catalogue" : "Pick from the catalogue"}</span>
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-70" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[20rem] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search by SKU or name" value={search} onValueChange={setSearch} />
            <CommandList>
              <CommandEmpty>No product matches.</CommandEmpty>
              {groups.map(([category, items]) => (
                <CommandGroup key={category} heading={category}>
                  {items.map((p) => (
                    <CommandItem
                      key={p.id}
                      value={p.id}
                      onSelect={() => {
                        onPick(p);
                        setOpen(false);
                        setSearch("");
                      }}
                    >
                      <span className="mr-2 font-mono text-xs text-muted-foreground">{p.sku}</span>
                      <span className="truncate">{p.name}</span>
                      {p.id === value && <Check className="ml-auto h-4 w-4" />}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {current && (
        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={onClear} aria-label="Unlink the catalogue item">
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
