"use client";

/**
 * Create or edit a CRM quote (Sep 15, 2026).
 *
 * Every option lives here: title, currency, dates, who it is prepared for, the
 * lines (product code, name, description, quantity, unit price), tax, terms and
 * notes. A new quote starts from the server draft (the deal's company, products,
 * event tax and the org's default terms); an edit starts from the saved quote.
 *
 * The totals shown are computed by the same `computeQuoteTotals` the service
 * stores, so the preview cannot disagree with the PDF. Prices are never
 * converted: each line remembers the currency its price was entered in, and a
 * currency switch flags any price entered in another one (quote-editor-lines).
 */
import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, PackagePlus, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError } from "@/lib/api-fetch";
import { useCreateCrmDealQuote, useCrmQuoteDraft, useUpdateCrmDealQuote } from "@/crm/hooks/use-crm-api";
import {
  MAX_QUOTE_LINES,
  QUOTE_CURRENCIES,
  computeQuoteTotals,
  formatQuoteMoney,
  formatTaxRate,
  isQuoteCurrency,
  isValidDateString,
  type CrmQuoteDraft,
  type CrmQuoteRow,
  type QuoteCurrency,
  type QuoteInput,
} from "@/crm/lib/quote-rules";
import {
  blankLine,
  fromDraftLine,
  fromQuoteLine,
  keepPricesIn,
  linesNeedingPrice,
  linesPricedInOtherCurrency,
  switchLinesCurrency,
  withTypedPrice,
  type EditorLine,
} from "@/crm/lib/quote-editor-lines";

function parseAmount(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function QuoteEditorDialog({
  dealId,
  open,
  onOpenChange,
  quote,
}: {
  dealId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = a new quote. */
  quote: CrmQuoteRow | null;
}) {
  const draftQuery = useCrmQuoteDraft(dealId, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{quote ? `Edit quote ${quote.number}` : "New quote"}</DialogTitle>
          <DialogDescription>
            {quote
              ? "Saving keeps the quote number and replaces its PDF under Documents."
              : "The quote gets the next number, its PDF lands under Documents and can be attached in Email."}
          </DialogDescription>
        </DialogHeader>

        {/* The form seeds its fields once, on mount, so it must never mount on a
            draft left in the cache by an earlier open: wait for THIS open's fetch.
            (The card also remounts the dialog per open; review M3.) */}
        {draftQuery.isError ? (
          <p className="py-6 text-sm text-destructive">Could not load the quote details. Close this and try again.</p>
        ) : !draftQuery.isFetchedAfterMount || !draftQuery.data ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Preparing the quote…
          </div>
        ) : (
          <QuoteEditorForm
            dealId={dealId}
            quote={quote}
            draft={draftQuery.data.draft}
            canSaveDefaultTerms={draftQuery.data.canSaveDefaultTerms}
            onCancel={() => onOpenChange(false)}
            onSaved={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function QuoteEditorForm({
  dealId,
  quote,
  draft,
  canSaveDefaultTerms,
  onCancel,
  onSaved,
}: {
  dealId: string;
  quote: CrmQuoteRow | null;
  draft: CrmQuoteDraft;
  canSaveDefaultTerms: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const create = useCreateCrmDealQuote(dealId);
  const update = useUpdateCrmDealQuote(dealId);
  const saving = create.isPending || update.isPending;

  const initialCurrency: QuoteCurrency = quote && isQuoteCurrency(quote.currency) ? quote.currency : draft.currency;
  const [title, setTitle] = useState(quote?.title ?? draft.title);
  const [currency, setCurrency] = useState<QuoteCurrency>(initialCurrency);
  const [quoteDate, setQuoteDate] = useState(quote?.quoteDate ?? draft.quoteDate);
  const [validUntil, setValidUntil] = useState(quote?.validUntil ?? draft.validUntil);
  const [preparedFor, setPreparedFor] = useState(quote?.preparedFor ?? draft.preparedFor);
  const [attention, setAttention] = useState(quote ? (quote.attention ?? "") : (draft.attention ?? ""));
  const [taxRate, setTaxRate] = useState(() => {
    const rate = quote ? quote.taxRate : draft.taxRate;
    return rate === null ? "" : formatTaxRate(rate);
  });
  const [taxLabel, setTaxLabel] = useState(quote?.taxLabel ?? draft.taxLabel);
  const [terms, setTerms] = useState(quote ? (quote.terms ?? "") : (draft.terms ?? ""));
  const [notes, setNotes] = useState(quote ? (quote.notes ?? "") : (draft.notes ?? ""));
  const [lines, setLines] = useState<EditorLine[]>(() =>
    quote
      ? quote.lines.map((l) => fromQuoteLine(l, initialCurrency))
      : draft.lines.map((l) => fromDraftLine(l, initialCurrency)),
  );
  const [saveTermsAsDefault, setSaveTermsAsDefault] = useState(false);

  const totals = computeQuoteTotals(
    lines.map((l) => ({ quantity: parseAmount(l.quantity) ?? 0, unitPrice: parseAmount(l.unitPrice) ?? 0 })),
    parseAmount(taxRate),
  );

  const onQuote = new Set(lines.map((l) => l.crmProductId).filter(Boolean));
  const productsToAdd = draft.lines.filter((l) => !l.crmProductId || !onQuote.has(l.crmProductId));
  const needsPrice = linesNeedingPrice(lines, currency);
  const pricedElsewhere = linesPricedInOtherCurrency(lines, currency);
  const pricedElsewhereKeys = new Set(pricedElsewhere.map((l) => l.key));
  const otherCurrencies = [...new Set(pricedElsewhere.map((l) => l.priceCurrency))].join(" / ");

  function patchLine(key: string, patch: Partial<EditorLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function typePrice(key: string, value: string) {
    setLines((prev) => prev.map((l) => (l.key === key ? withTypedPrice(l, value, currency) : l)));
  }

  function changeCurrency(next: string) {
    if (!isQuoteCurrency(next) || next === currency) return;
    setLines((prev) => switchLinesCurrency(prev, next));
    setCurrency(next);
  }

  function addDealProducts() {
    setLines((prev) => [...prev, ...productsToAdd.map((l) => fromDraftLine(l, currency))].slice(0, MAX_QUOTE_LINES));
  }

  function buildInput(): QuoteInput | string {
    if (!title.trim()) return "Give the quote a title";
    if (!preparedFor.trim()) return "Say who the quote is prepared for";
    if (!isValidDateString(quoteDate) || !isValidDateString(validUntil)) return "Pick a quote date and a valid-until date";
    if (validUntil < quoteDate) return "Valid until must be on or after the quote date";
    if (lines.length === 0) return "Add at least one line";

    const rate = parseAmount(taxRate);
    if (taxRate.trim() && (rate === null || rate < 0 || rate > 100)) return "Tax rate must be between 0 and 100";

    const built: QuoteInput["lines"] = [];
    for (const [i, l] of lines.entries()) {
      const row = i + 1;
      if (!l.name.trim()) return `Line ${row} needs a product name`;
      const quantity = parseAmount(l.quantity);
      if (quantity === null || !Number.isInteger(quantity) || quantity < 1) return `Line ${row}: quantity must be a whole number of at least 1`;
      if (pricedElsewhereKeys.has(l.key)) {
        return `Line ${row}: the price was entered in ${l.priceCurrency}. Re-enter it in ${currency}, or keep the prices as they are.`;
      }
      const unitPrice = parseAmount(l.unitPrice);
      if (unitPrice === null || unitPrice < 0) return `Line ${row} needs a unit price in ${currency}`;
      built.push({
        productCode: l.productCode.trim() || null,
        name: l.name.trim(),
        description: l.description.trim() || null,
        quantity,
        unitPrice,
        crmProductId: l.crmProductId,
      });
    }

    return {
      title: title.trim(),
      currency,
      quoteDate,
      validUntil,
      preparedFor: preparedFor.trim(),
      attention: attention.trim() || null,
      taxRate: rate,
      taxLabel: taxLabel.trim() || "VAT",
      terms: terms.trim() || null,
      notes: notes.trim() || null,
      lines: built,
    };
  }

  async function handleSave() {
    const input = buildInput();
    if (typeof input === "string") {
      toast.error(input);
      return;
    }
    const extra = saveTermsAsDefault ? { saveTermsAsDefault: true } : {};
    try {
      if (quote) {
        const res = await update.mutateAsync({ quoteId: quote.id, expectedVersion: quote.version, ...input, ...extra });
        toast.success(`Quote ${res.quote.number} updated`);
      } else {
        const res = await create.mutateAsync({ ...input, ...extra });
        toast.success(`Quote ${res.quote.number} saved`);
      }
      onSaved();
    } catch (err) {
      // The mutation hook toasts the server's message. A 409 (changed or deleted
      // meanwhile) cannot be saved from this form, which holds the old version, so
      // close it: the hook has refetched the list, and reopening loads the current quote.
      if (err instanceof ApiError && err.status === 409) onCancel();
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Header fields ─────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="space-y-2 sm:col-span-3">
          <Label htmlFor="quote-title">Title</Label>
          <Input id="quote-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Abbott Quote - MEHFC 2026" />
        </div>
        <div className="space-y-2">
          <Label>Currency</Label>
          <Select value={currency} onValueChange={changeCurrency}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {QUOTE_CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="quote-for">Prepared for</Label>
          <Input id="quote-for" value={preparedFor} onChange={(e) => setPreparedFor(e.target.value)} />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="quote-attn">Attention (optional)</Label>
          <Input id="quote-attn" value={attention} onChange={(e) => setAttention(e.target.value)} placeholder="Contact name" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="quote-date">Quote date</Label>
          <Input id="quote-date" type="date" value={quoteDate} onChange={(e) => setQuoteDate(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="quote-valid">Valid till</Label>
          <Input id="quote-valid" type="date" value={validUntil} min={quoteDate} onChange={(e) => setValidUntil(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Prepared by</Label>
          <p className="flex h-9 items-center text-sm text-muted-foreground">{quote?.preparedByName ?? draft.preparedByName}</p>
        </div>
      </div>

      {/* ── Lines ─────────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Products / services</p>
        {pricedElsewhere.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <p className="flex-1">
              {pricedElsewhere.length === 1 ? "1 price was" : `${pricedElsewhere.length} prices were`} entered in{" "}
              {otherCurrencies}. Prices are not converted: re-enter them in {currency}, or keep them as they are.
            </p>
            <Button type="button" size="sm" variant="outline" onClick={() => setLines((prev) => keepPricesIn(prev, currency))}>
              Keep as {currency}
            </Button>
          </div>
        )}
        <div className="overflow-x-auto rounded-md border">
          <div className="min-w-[760px]">
            <div className="grid grid-cols-[7rem_1fr_5rem_8rem_8rem_2.25rem] gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
              <span>Product code</span>
              <span>Product name / description</span>
              <span className="text-right">Qty</span>
              <span className="text-right">Unit price</span>
              <span className="text-right">Total</span>
              <span />
            </div>
            {lines.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">No lines yet. Add one below.</p>
            ) : (
              lines.map((l, i) => {
                const missingPrice = !l.unitPrice.trim() && !!l.catalogue && l.catalogue.currency !== currency;
                const wrongCurrency = pricedElsewhereKeys.has(l.key);
                return (
                  <div
                    key={l.key}
                    className="grid grid-cols-[7rem_1fr_5rem_8rem_8rem_2.25rem] items-start gap-2 border-b px-3 py-2 last:border-b-0"
                  >
                    <Input
                      aria-label={`Line ${i + 1} product code`}
                      value={l.productCode}
                      onChange={(e) => patchLine(l.key, { productCode: e.target.value })}
                      className="h-8"
                    />
                    <div className="space-y-1.5">
                      <Input
                        aria-label={`Line ${i + 1} product name`}
                        value={l.name}
                        onChange={(e) => patchLine(l.key, { name: e.target.value })}
                        placeholder="Sponsorship - Diamond"
                        className="h-8 font-medium"
                      />
                      <Textarea
                        aria-label={`Line ${i + 1} description`}
                        value={l.description}
                        onChange={(e) => patchLine(l.key, { description: e.target.value })}
                        placeholder="Description (optional)"
                        rows={1}
                        className="min-h-8 text-xs"
                      />
                    </div>
                    <Input
                      aria-label={`Line ${i + 1} quantity`}
                      inputMode="numeric"
                      value={l.quantity}
                      onChange={(e) => patchLine(l.key, { quantity: e.target.value })}
                      className="h-8 text-right tabular-nums"
                    />
                    <div className="space-y-1">
                      <Input
                        aria-label={`Line ${i + 1} unit price`}
                        inputMode="decimal"
                        value={l.unitPrice}
                        onChange={(e) => typePrice(l.key, e.target.value)}
                        className={`h-8 text-right tabular-nums ${missingPrice || wrongCurrency ? "border-amber-400" : ""}`}
                      />
                      {missingPrice && (
                        <p className="text-right text-[11px] text-amber-700">Catalogue price is in {l.catalogue?.currency}</p>
                      )}
                      {wrongCurrency && (
                        <p className="text-right text-[11px] text-amber-700">Entered in {l.priceCurrency}</p>
                      )}
                    </div>
                    <p className="flex h-8 items-center justify-end text-sm tabular-nums">
                      {formatQuoteMoney(totals.amounts[i] ?? 0, currency)}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                      title="Remove line"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={lines.length >= MAX_QUOTE_LINES}
            onClick={() => setLines((prev) => [...prev, blankLine()])}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add line
          </Button>
          {productsToAdd.length > 0 && (
            <Button type="button" size="sm" variant="outline" onClick={addDealProducts}>
              <PackagePlus className="mr-1.5 h-3.5 w-3.5" /> Add deal products ({productsToAdd.length})
            </Button>
          )}
          {needsPrice.length > 0 && (
            <p className="text-xs text-amber-700">
              {needsPrice.length === 1 ? "1 line needs" : `${needsPrice.length} lines need`} a price in {currency}.
              Prices are not converted between currencies.
            </p>
          )}
        </div>
      </div>

      {/* ── Tax + totals ──────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid grid-cols-2 gap-3 self-start">
          <div className="space-y-2">
            <Label htmlFor="quote-tax-rate">Tax rate %</Label>
            <Input id="quote-tax-rate" inputMode="decimal" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} placeholder="none" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="quote-tax-label">Tax label</Label>
            <Input id="quote-tax-label" value={taxLabel} onChange={(e) => setTaxLabel(e.target.value)} />
          </div>
        </div>
        <dl className="space-y-1.5 rounded-md border bg-muted/20 p-3 text-sm tabular-nums">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd>{formatQuoteMoney(totals.subtotal, currency)}</dd>
          </div>
          {totals.taxRate !== null && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">
                {taxLabel.trim() || "VAT"} ({formatTaxRate(totals.taxRate)}%)
              </dt>
              <dd>{formatQuoteMoney(totals.taxAmount, currency)}</dd>
            </div>
          )}
          <div className="flex justify-between border-t pt-1.5 font-semibold">
            <dt>Total</dt>
            <dd>{formatQuoteMoney(totals.total, currency)}</dd>
          </div>
        </dl>
      </div>

      {/* ── Terms + notes ─────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <Label htmlFor="quote-terms">Terms and conditions</Label>
        <Textarea id="quote-terms" rows={5} value={terms} onChange={(e) => setTerms(e.target.value)} />
        {canSaveDefaultTerms && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox checked={saveTermsAsDefault} onCheckedChange={(v) => setSaveTermsAsDefault(v === true)} />
            Save these terms as the default for new quotes
          </label>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="quote-notes">Notes (optional, printed on the quote)</Label>
        <Textarea id="quote-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Payment terms, inclusions…" />
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {quote ? "Save changes" : "Save quote"}
        </Button>
      </DialogFooter>
    </div>
  );
}
