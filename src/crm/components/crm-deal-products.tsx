"use client";

/**
 * A deal's products (line items). Add a catalog product, set its quantity + unit
 * price (the price is set HERE, pre-filled from the catalog list price), and see a
 * products total. The deal's Value stays manual — this is the itemization.
 *
 * Prices are finance-gated: for a MEMBER the unit prices arrive redacted, so line
 * totals and the products total render "—" (never a partial/fake number), and the
 * inline price inputs don't render.
 */
import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  useDealProducts,
  useCrmProducts,
  useAddDealProduct,
  useUpdateDealProduct,
  useRemoveDealProduct,
} from "@/crm/hooks/use-crm-api";
import { formatDealValue, sumDealProducts, type CrmDealProductRow } from "@/crm/lib/crm-types";

export function DealProducts({ dealId, canWrite }: { dealId: string; canWrite: boolean }) {
  const { data: lines = [], isLoading } = useDealProducts(dealId);
  const add = useAddDealProduct(dealId);

  const total = sumDealProducts(lines);
  const currency = lines[0]?.currency ?? "AED";

  if (isLoading) {
    return <p className="py-2 text-sm text-muted-foreground">Loading products…</p>;
  }

  return (
    <div className="space-y-3">
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No products on this deal yet{canWrite ? " — add what you're selling." : "."}
        </p>
      ) : (
        <ul className="space-y-2">
          {lines.map((line) => (
            <LineItem key={line.id} dealId={dealId} line={line} canWrite={canWrite} />
          ))}
        </ul>
      )}

      {lines.length > 0 && (
        <div className="flex items-center justify-between border-t pt-3 text-sm">
          <span className="font-medium">Products total</span>
          <span className="font-semibold tabular-nums">
            {total === null ? <span className="text-muted-foreground">—</span> : formatDealValue(total, currency)}
          </span>
        </div>
      )}

      {canWrite && (
        <ProductPicker
          excludeIds={lines.map((l) => l.crmProductId).filter((x): x is string => !!x)}
          adding={add.isPending}
          onPick={(crmProductId) => add.mutate({ crmProductId })}
        />
      )}
    </div>
  );
}

function LineItem({ dealId, line, canWrite }: { dealId: string; line: CrmDealProductRow; canWrite: boolean }) {
  const update = useUpdateDealProduct(dealId);
  const remove = useRemoveDealProduct(dealId);

  const [qty, setQty] = useState(String(line.quantity));
  const [price, setPrice] = useState(line.unitPrice != null ? String(line.unitPrice) : "");

  const priceKnown = line.unitPrice !== null && line.unitPrice !== undefined;
  const lineTotal = priceKnown ? Number(line.unitPrice) * line.quantity : null;

  function commitQty() {
    const n = Math.max(1, Math.trunc(Number(qty) || 1));
    setQty(String(n));
    if (n !== line.quantity) update.mutate({ lineId: line.id, quantity: n });
  }
  function commitPrice() {
    const n = Number(price);
    if (!Number.isFinite(n) || n < 0) {
      setPrice(line.unitPrice != null ? String(line.unitPrice) : "");
      return;
    }
    if (n !== Number(line.unitPrice)) update.mutate({ lineId: line.id, unitPrice: n });
  }

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border p-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{line.productName}</p>
        <span className="mt-0.5 inline-flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">{line.category}</Badge>
          {line.sku && <span className="font-mono text-[11px] text-muted-foreground">{line.sku}</span>}
        </span>
      </div>

      {canWrite ? (
        <div className="flex items-center gap-1.5">
          <Input
            className="h-8 w-14 text-center"
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            onBlur={commitQty}
            aria-label="Quantity"
          />
          <span className="text-xs text-muted-foreground">×</span>
          {priceKnown ? (
            <Input
              className="h-8 w-24 text-right tabular-nums"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              onBlur={commitPrice}
              aria-label="Unit price"
            />
          ) : (
            <span className="w-24 text-right text-muted-foreground">—</span>
          )}
        </div>
      ) : (
        <span className="text-sm text-muted-foreground tabular-nums">
          {line.quantity} × {priceKnown ? formatDealValue(line.unitPrice, line.currency) : "—"}
        </span>
      )}

      <span className="w-24 text-right text-sm font-medium tabular-nums">
        {lineTotal === null ? <span className="text-muted-foreground">—</span> : formatDealValue(lineTotal, line.currency)}
      </span>

      {canWrite && (
        <button
          type="button"
          aria-label={`Remove ${line.productName}`}
          className="text-muted-foreground transition-colors hover:text-destructive"
          onClick={() => remove.mutate(line.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );
}

function ProductPicker({
  excludeIds,
  adding,
  onPick,
}: {
  excludeIds: string[];
  adding: boolean;
  onPick: (crmProductId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data: products = [] } = useCrmProducts();

  const excluded = useMemo(() => new Set(excludeIds), [excludeIds]);
  const q = search.trim().toLowerCase();
  const available = products.filter(
    (p) => !excluded.has(p.id) && (!q || `${p.name} ${p.sku ?? ""} ${p.category}`.toLowerCase().includes(q)),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="w-full justify-between" disabled={adding}>
          <span className="flex items-center gap-2 text-muted-foreground">
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add a product…
          </span>
          <ChevronsUpDown className="h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[18rem] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search products…" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>No products match.</CommandEmpty>
            <CommandGroup>
              {available.slice(0, 100).map((p) => (
                <CommandItem
                  key={p.id}
                  value={p.id}
                  onSelect={() => {
                    onPick(p.id);
                    setOpen(false);
                    setSearch("");
                  }}
                >
                  <Check className="mr-2 h-4 w-4 opacity-0" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <Badge variant="outline" className="ml-2 shrink-0 text-[10px]">{p.category}</Badge>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
