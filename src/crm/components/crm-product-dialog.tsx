"use client";

/**
 * Create or edit a catalog product/service. `product` present = edit, absent = create.
 * `category` is a free-text field with a datalist of the categories already in use, so
 * you can reuse "Sponsorship" / "Content" or type a brand-new group.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateCrmProduct, useUpdateCrmProduct } from "@/crm/hooks/use-crm-api";
import { PRODUCT_SOURCE_LABELS, type CrmProductRow, type CrmProductSourceType } from "@/crm/lib/crm-types";

export function CrmProductDialog({
  open,
  onOpenChange,
  product,
  categories,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  product?: CrmProductRow | null;
  /** Existing categories, for the datalist. */
  categories: string[];
}) {
  const isEdit = !!product;
  const [name, setName] = useState(product?.name ?? "");
  const [sku, setSku] = useState(product?.sku ?? "");
  const [category, setCategory] = useState(product?.category ?? "");
  const [source, setSource] = useState<CrmProductSourceType>(product?.source ?? "IN_HOUSE");
  const [price, setPrice] = useState(product?.price != null ? String(product.price) : "");
  const [currency, setCurrency] = useState(product?.currency ?? "AED");
  const [priceIncludesTax, setPriceIncludesTax] = useState(product?.priceIncludesTax ?? false);
  const [saving, setSaving] = useState(false);

  const create = useCreateCrmProduct();
  const update = useUpdateCrmProduct(product?.id ?? "");

  async function handleSave() {
    if (!name.trim()) return toast.error("Give the product a name");
    if (!category.trim()) return toast.error("Pick or type a category");
    const parsedPrice = price.trim() ? Number(price) : 0;
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) return toast.error("Price must be a non-negative number");

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        sku: sku.trim() || null,
        category: category.trim(),
        source,
        price: parsedPrice,
        currency: currency.trim() || "AED",
        priceIncludesTax,
      };
      if (isEdit) {
        await update.mutateAsync(payload);
        toast.success("Product updated");
      } else {
        await create.mutateAsync(payload);
        toast.success("Product added");
      }
      onOpenChange(false);
    } catch {
      // hooks toast the error
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit product" : "New product"}</DialogTitle>
          <DialogDescription asChild>
            <span>A service or product in your catalog — add it as a line item on deals.</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="prod-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input id="prod-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sponsorship - Gold" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="prod-category">
                Category <span className="text-destructive">*</span>
              </Label>
              <Input
                id="prod-category"
                list="crm-product-categories"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Sponsorship"
              />
              <datalist id="crm-product-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <Label htmlFor="prod-sku">SKU</Label>
              <Input id="prod-sku" value={sku ?? ""} onChange={(e) => setSku(e.target.value)} placeholder="SPO10002" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Sourcing</Label>
              <Select value={source} onValueChange={(v) => setSource(v as CrmProductSourceType)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PRODUCT_SOURCE_LABELS) as CrmProductSourceType[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {PRODUCT_SOURCE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="prod-currency">Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id="prod-currency" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["AED", "USD", "EUR", "GBP", "SAR"].map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="prod-price">List price</Label>
            <Input
              id="prod-price"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="7340"
            />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={priceIncludesTax} onCheckedChange={(v) => setPriceIncludesTax(!!v)} />
              Price includes tax
            </label>
            <p className="text-xs text-muted-foreground">
              This is the default list price — you set the actual price per deal when adding it as a line item.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isEdit ? "Save changes" : "Add product"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
