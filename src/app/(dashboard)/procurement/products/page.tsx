"use client";
/**
 * The product catalogue: the cost items a budget line is picked from, with
 * the accounting SKU. Everyone who reads budgets can read the list; an admin
 * (SUPER_ADMIN or ADMIN) adds, renames, re-categorises and archives. Items are
 * never deleted, so a line that used one keeps its link and its SKU.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { canAdminProcurement } from "@/lib/procurement-visibility";
import { useBudgetCategories, useBudgetProducts, useCreateBudgetProduct, useImportBudgetProducts, useUpdateBudgetProduct, type BudgetProductRow } from "@/procurement/hooks/use-procurement-api";
import { ProcurementCsvImportDialog } from "@/procurement/components/csv-import-dialog";
import { PRODUCT_IMPORT_COLUMNS } from "@/procurement/lib/catalogue-import";
import { ErrorState, LoadingState } from "@/procurement/components/budget-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArchiveRestore, ArrowLeft, FileUp, Loader2, Package, Pencil, Plus } from "lucide-react";

const ALL = "__all__";

export default function BudgetProductsPage() {
  const { data: session } = useSession();
  const canAdmin = canAdminProcurement(session?.user);
  const products = useBudgetProducts();
  const categories = useBudgetCategories();
  const update = useUpdateBudgetProduct();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(ALL);
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const importProducts = useImportBudgetProducts();
  const [editing, setEditing] = useState<BudgetProductRow | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products.data ?? []).filter((p) =>
      (showArchived || p.isActive) &&
      (category === ALL || p.categoryId === category) &&
      (!q || p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)),
    );
  }, [products.data, search, category, showArchived]);

  async function setActive(p: BudgetProductRow, isActive: boolean) {
    try {
      await update.mutateAsync({ productId: p.id, isActive });
      toast.success(isActive ? `${p.sku} is back in the picker.` : `${p.sku} archived. Lines that used it keep it.`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (products.isPending || categories.isPending) return <LoadingState label="Loading the catalogue…" />;
  if (products.isError) return <ErrorState title="Couldn't load the catalogue" message={(products.error as Error)?.message ?? ""} backHref="/procurement" backLabel="Budgets" />;

  const activeCount = (products.data ?? []).filter((p) => p.isActive).length;
  const cats = (categories.data ?? []).filter((c) => c.isActive);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/procurement" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Budgets
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><Package className="h-6 w-6 text-primary" /> Products</h1>
            <p className="mt-1 text-sm text-muted-foreground">{`${activeCount} items a budget line can be picked from, each with its accounting SKU.`}</p>
          </div>
          {canAdmin && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setImporting(true)}><FileUp className="h-4 w-4" /> Import CSV</Button>
              <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add product</Button>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem] flex-1 space-y-1">
          <Label className="text-xs">Search</Label>
          <Input className="h-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="SKU or name" />
        </div>
        <div className="min-w-[14rem] space-y-1">
          <Label className="text-xs">Category</Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All categories</SelectItem>
              {cats.map((c) => <SelectItem key={c.id} value={c.id}>{c.code} · {c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <Switch checked={showArchived} onCheckedChange={setShowArchived} /> Show archived
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">SKU</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-56">Category</TableHead>
              <TableHead className="w-24">Status</TableHead>
              {canAdmin && <TableHead className="w-24 text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={canAdmin ? 5 : 4} className="py-8 text-center text-sm text-muted-foreground">No product matches.</TableCell></TableRow>
            ) : rows.map((p) => (
              <TableRow key={p.id} className={p.isActive ? undefined : "opacity-60"}>
                <TableCell className="font-mono text-xs">{p.sku}</TableCell>
                <TableCell>{p.name}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{p.category.code} · {p.category.name}</TableCell>
                <TableCell>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${p.isActive ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}>{p.isActive ? "Active" : "Archived"}</span>
                </TableCell>
                {canAdmin && (
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${p.sku}`} onClick={() => setEditing(p)}><Pencil className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={p.isActive ? `Archive ${p.sku}` : `Restore ${p.sku}`} disabled={update.isPending} onClick={() => void setActive(p, !p.isActive)}><ArchiveRestore className="h-4 w-4" /></Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {canAdmin && <AddProductDialog open={adding} onOpenChange={setAdding} categories={cats} />}
      {canAdmin && (
        <ProcurementCsvImportDialog
          open={importing}
          onOpenChange={setImporting}
          title="Import products"
          description="One row per cost item. An existing SKU is updated (name, category, active), a new SKU is created; nothing is deleted."
          columns={PRODUCT_IMPORT_COLUMNS}
          templateFilename="products-template.csv"
          onImport={(csv) => importProducts.mutateAsync(csv)}
          pending={importProducts.isPending}
        />
      )}
      {canAdmin && <EditProductDialog product={editing} onClose={() => setEditing(null)} categories={cats} />}
    </div>
  );
}

type Cat = { id: string; code: string; name: string };

function AddProductDialog({ open, onOpenChange, categories }: { open: boolean; onOpenChange: (o: boolean) => void; categories: Cat[] }) {
  const create = useCreateBudgetProduct();
  const [f, setF] = useState({ sku: "", name: "", categoryId: "" });
  async function save() {
    if (!f.sku.trim() || !f.name.trim() || !f.categoryId) return toast.error("A product needs a SKU, a name and a category.");
    try {
      const p = await create.mutateAsync({ sku: f.sku.trim(), name: f.name.trim(), categoryId: f.categoryId });
      toast.success(`${p.sku} added.`);
      setF({ sku: "", name: "", categoryId: "" });
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a product</DialogTitle>
          <DialogDescription>A cost item a budget line can be picked from. The SKU is the accounting key and cannot change later.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label htmlFor="sku">SKU</Label><Input id="sku" value={f.sku} onChange={(e) => setF((s) => ({ ...s, sku: e.target.value }))} placeholder="510323" /></div>
          <div className="space-y-1"><Label htmlFor="pname">Name</Label><Input id="pname" value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} placeholder="What is bought" /></div>
          <div className="space-y-1">
            <Label>Category</Label>
            <Select value={f.categoryId} onValueChange={(v) => setF((s) => ({ ...s, categoryId: v }))}>
              <SelectTrigger><SelectValue placeholder="Pick a category" /></SelectTrigger>
              <SelectContent>{categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.code} · {c.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>Cancel</Button>
          <Button onClick={() => void save()} disabled={create.isPending}>{create.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Add product</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditProductDialog({ product, onClose, categories }: { product: BudgetProductRow | null; onClose: () => void; categories: Cat[] }) {
  const update = useUpdateBudgetProduct();
  // Keyed remount: the form state is seeded from the product being edited.
  return product ? <EditProductForm key={product.id} product={product} onClose={onClose} categories={categories} update={update} /> : null;
}

function EditProductForm({ product, onClose, categories, update }: { product: BudgetProductRow; onClose: () => void; categories: Cat[]; update: ReturnType<typeof useUpdateBudgetProduct> }) {
  const [f, setF] = useState({ name: product.name, categoryId: product.categoryId });
  async function save() {
    if (!f.name.trim()) return toast.error("A product needs a name.");
    try {
      await update.mutateAsync({ productId: product.id, ...(f.name.trim() !== product.name ? { name: f.name.trim() } : {}), ...(f.categoryId !== product.categoryId ? { categoryId: f.categoryId } : {}) });
      toast.success(`${product.sku} saved.`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Edit ${product.sku}`}</DialogTitle>
          <DialogDescription>Rename the item or move it to another category. Lines that already use it are not changed.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label htmlFor="ename">Name</Label><Input id="ename" value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} /></div>
          <div className="space-y-1">
            <Label>Category</Label>
            <Select value={f.categoryId} onValueChange={(v) => setF((s) => ({ ...s, categoryId: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.code} · {c.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>Cancel</Button>
          <Button onClick={() => void save()} disabled={update.isPending}>{update.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
