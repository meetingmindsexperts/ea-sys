"use client";

/**
 * CRM → Products — the org's product/service catalog.
 *
 * Seeded from Meeting Minds' service list on first load, then editable. Products are
 * added to deals as line items (Deals → a deal → Products). Prices are finance-gated:
 * a MEMBER sees the catalog but prices render "—" (redacted server-side).
 */
import { useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { Archive, ArchiveRestore, Loader2, Package, Pencil, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useCrmProducts, useSetCrmProductArchived } from "@/crm/hooks/use-crm-api";
import { canOwnDeals, canDeleteCrm } from "@/crm/lib/crm-roles";
import { CrmEmptyState } from "@/crm/components/crm-empty-state";
import { CrmTableSkeleton } from "@/crm/components/crm-skeletons";
import { CrmProductDialog } from "@/crm/components/crm-product-dialog";
import { formatDealValue, PRODUCT_SOURCE_LABELS, type CrmProductRow } from "@/crm/lib/crm-types";

const ALL_CATEGORIES = "__all__";

export default function CrmProductsPage() {
  const { data: session } = useSession();
  const canWrite = canOwnDeals(session?.user?.role);

  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const { data: products = [], isLoading } = useCrmProducts(showArchived);

  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category))].sort((a, b) => a.localeCompare(b)),
    [products],
  );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return products.filter((p) => {
      if (category !== ALL_CATEGORIES && p.category !== category) return false;
      if (needle && !`${p.name} ${p.sku ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [products, q, category]);

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Your service catalog. Add these to deals as line items to itemize what you&rsquo;re selling.
        </p>
        {canWrite && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New product
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or SKU…" className="pl-8" />
        </div>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-[14rem]">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={showArchived ? "default" : "outline"}
          size="sm"
          onClick={() => setShowArchived((v) => !v)}
        >
          <Archive className="mr-2 h-3.5 w-3.5" />
          {showArchived ? "Showing archived" : "Show archived"}
        </Button>
      </div>

      {isLoading ? (
        <CrmTableSkeleton />
      ) : rows.length === 0 ? (
        <CrmEmptyState
          icon={Package}
          title={products.length === 0 ? (showArchived ? "No archived products" : "No products yet") : "No products match"}
          description={
            products.length === 0
              ? "Your catalog seeds on first load — reload in a moment, or add one."
              : "Try clearing the search or the category filter."
          }
          action={
            canWrite && products.length === 0 && !showArchived ? (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                New product
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Product / Service</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Sourcing</TableHead>
                <TableHead className="text-right">List price</TableHead>
                {canWrite && <TableHead className="w-24" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <ProductRow key={p.id} product={p} canWrite={canWrite} categories={categories} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CrmProductDialog open={createOpen} onOpenChange={setCreateOpen} categories={categories} />
    </div>
  );
}

function ProductRow({
  product,
  canWrite,
  categories,
}: {
  product: CrmProductRow;
  canWrite: boolean;
  categories: string[];
}) {
  const { data: session } = useSession();
  const canDelete = canDeleteCrm(session?.user?.role);
  const [editOpen, setEditOpen] = useState(false);
  const setArchived = useSetCrmProductArchived(product.id);
  const archived = !!product.archivedAt;
  const price = formatDealValue(product.price, product.currency);

  return (
    <TableRow className={cn(archived && "opacity-60")}>
      <TableCell className="font-medium">
        {product.name}
        {archived && (
          <Badge variant="outline" className="ml-2 border-rose-200 bg-rose-50 text-[10px] text-rose-700">
            Archived
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <Badge variant="outline">{product.category}</Badge>
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{product.sku ?? "—"}</TableCell>
      <TableCell className="text-muted-foreground">{PRODUCT_SOURCE_LABELS[product.source]}</TableCell>
      <TableCell className="text-right tabular-nums">
        {price ?? <span className="text-muted-foreground">—</span>}
      </TableCell>
      {canWrite && (
        <TableCell>
          <div className="flex items-center justify-end gap-1">
            {!archived && (
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditOpen(true)} aria-label="Edit product">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            {canDelete &&
              (archived ? (
                <Button size="icon" variant="ghost" className="h-8 w-8" disabled={setArchived.isPending} onClick={() => setArchived.mutate(false)} aria-label="Restore product">
                  <ArchiveRestore className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  disabled={setArchived.isPending}
                  aria-label="Archive product"
                  onClick={() => {
                    if (!confirm(`Archive "${product.name}"? It will be hidden from the catalog and the deal picker. You can restore it later.`)) return;
                    setArchived.mutate(true);
                  }}
                >
                  {setArchived.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
                </Button>
              ))}
          </div>
          <CrmProductDialog open={editOpen} onOpenChange={setEditOpen} product={product} categories={categories} />
        </TableCell>
      )}
    </TableRow>
  );
}
