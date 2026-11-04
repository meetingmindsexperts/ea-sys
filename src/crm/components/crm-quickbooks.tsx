"use client";

/**
 * The CRM's QuickBooks screens (Nov 4, 2026): link a sponsor to its QuickBooks
 * customer, link catalogue products to QuickBooks products/services, choose
 * the VAT codes, and send a won deal's quote as an Estimate.
 *
 * EA-SYS only LINKS existing QuickBooks customers (owner decision), so the
 * customer picker searches and never offers to create. Every QuickBooks list
 * here is a live search, run only while its picker is open.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Check, ChevronsUpDown, CircleAlert, Loader2, Send, Unlink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api-fetch";
import {
  useCrmQuickBooksStatus,
  useLinkCompanyToQuickBooks,
  useLinkProductToQuickBooks,
  useQboLookup,
  useQuoteQuickBooksState,
  useSaveQuickBooksTaxCodes,
  useSendQuoteToQuickBooks,
  type QboCustomerOption,
  type QboItemOption,
  type QboTaxCodeOption,
} from "@/crm/hooks/use-crm-api";
import type { QuickBooksProblem } from "@/crm/lib/quickbooks-rules";
import type { CrmQuoteRow } from "@/crm/lib/quote-rules";

/** The search text, settled for 300 ms, so each keystroke is not a QuickBooks call. */
function useSettled(value: string, ms = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

function lookupError(err: unknown): string {
  return err instanceof Error ? err.message : "QuickBooks did not answer";
}

/** A popover that searches one QuickBooks list and hands back the pick. */
function QboSearchPicker<T extends { id: string }>({
  kind,
  label,
  placeholder,
  disabled,
  optionLabel,
  optionHint,
  onPick,
}: {
  kind: "customers" | "items";
  label: string;
  placeholder: string;
  disabled?: boolean;
  optionLabel: (o: T) => string;
  optionHint?: (o: T) => string | null;
  onPick: (o: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const settled = useSettled(search.trim());
  const { data = [], isFetching, error } = useQboLookup<T>(kind, settled, open);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={disabled}>
          {label}
          <ChevronsUpDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={placeholder} value={search} onValueChange={setSearch} />
          <CommandList>
            {isFetching && (
              <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Searching QuickBooks…
              </p>
            )}
            {error && <p className="px-3 py-2 text-xs text-destructive">{lookupError(error)}</p>}
            {!isFetching && !error && <CommandEmpty>Nothing in QuickBooks matches.</CommandEmpty>}
            <CommandGroup>
              {data.map((o) => (
                <CommandItem
                  key={o.id}
                  value={o.id}
                  onSelect={() => {
                    onPick(o);
                    setOpen(false);
                    setSearch("");
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{optionLabel(o)}</span>
                  {optionHint?.(o) && <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">{optionHint(o)}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Whether a stored link belongs to the QuickBooks company connected now. */
function linkedHere(realmId: string | null | undefined, currentRealm: string | null | undefined): boolean {
  return !!realmId && realmId === currentRealm;
}

// ── Account: the QuickBooks customer ──────────────────────────────────────────

export function CompanyQuickBooksLink({
  company,
  canWrite,
}: {
  company: { id: string; qboCustomerId?: string | null; qboCustomerName?: string | null; qboCustomerCurrency?: string | null; qboRealmId?: string | null };
  canWrite: boolean;
}) {
  const { data: status } = useCrmQuickBooksStatus();
  const link = useLinkCompanyToQuickBooks(company.id);

  if (!status) return <span className="text-muted-foreground">…</span>;
  if (!status.connected) return <span className="text-muted-foreground">Not connected</span>;

  const linked = company.qboCustomerId && linkedHere(company.qboRealmId, status.realmId);
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {linked ? (
        <span>
          {company.qboCustomerName}
          {company.qboCustomerCurrency && <span className="ml-1 text-xs text-muted-foreground">({company.qboCustomerCurrency})</span>}
        </span>
      ) : (
        <span className="text-muted-foreground">Not linked</span>
      )}
      {canWrite && (
        <QboSearchPicker<QboCustomerOption>
          kind="customers"
          label={linked ? "Change" : "Link"}
          placeholder="Search QuickBooks customers…"
          disabled={link.isPending}
          optionLabel={(c) => c.displayName}
          optionHint={(c) => c.currency}
          onPick={(c) => link.mutate(c.id, { onSuccess: () => toast.success(`Linked to ${c.displayName} in QuickBooks`) })}
        />
      )}
      {canWrite && linked && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Unlink from QuickBooks"
          disabled={link.isPending}
          onClick={() => link.mutate(null, { onSuccess: () => toast.success("Unlinked from QuickBooks") })}
        >
          <Unlink className="h-3.5 w-3.5" />
        </Button>
      )}
    </span>
  );
}

// ── Products: the QuickBooks product/service ──────────────────────────────────

export function ProductQuickBooksCell({
  product,
  canWrite,
  currentRealm,
}: {
  product: { id: string; qboItemId?: string | null; qboItemName?: string | null; qboRealmId?: string | null };
  canWrite: boolean;
  currentRealm: string | null;
}) {
  const link = useLinkProductToQuickBooks();
  const linked = product.qboItemId && linkedHere(product.qboRealmId, currentRealm);

  return (
    <span className="flex items-center gap-1.5">
      {linked ? <span className="truncate text-sm">{product.qboItemName}</span> : <span className="text-xs text-muted-foreground">Not linked</span>}
      {canWrite && (
        <QboSearchPicker<QboItemOption>
          kind="items"
          label={linked ? "Change" : "Link"}
          placeholder="Search QuickBooks products/services…"
          disabled={link.isPending}
          optionLabel={(i) => i.name}
          optionHint={(i) => i.type}
          onPick={(i) => link.mutate({ productId: product.id, itemId: i.id }, { onSuccess: () => toast.success(`Linked to ${i.name}`) })}
        />
      )}
      {canWrite && linked && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Unlink from QuickBooks"
          disabled={link.isPending}
          onClick={() => link.mutate({ productId: product.id, itemId: null })}
        >
          <Unlink className="h-3.5 w-3.5" />
        </Button>
      )}
    </span>
  );
}

// ── Products page: connection + VAT codes ─────────────────────────────────────

function TaxCodeSelect({
  id,
  value,
  onChange,
  codes,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  codes: QboTaxCodeOption[];
  placeholder: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="h-8 w-64">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {codes.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.name}
            {c.rate !== null ? ` (${c.rate}%)` : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function QuickBooksProductsPanel({ unlinkedCount }: { unlinkedCount: number }) {
  const { data: status, isLoading } = useCrmQuickBooksStatus();
  const [editing, setEditing] = useState(false);
  const { data: codes = [], isFetching, error } = useQboLookup<QboTaxCodeOption>("tax-codes", "", editing);
  const save = useSaveQuickBooksTaxCodes();
  const [vat, setVat] = useState("");
  const [noVat, setNoVat] = useState("");

  if (isLoading || !status) return null;
  if (!status.connected) {
    return (
      <div className="rounded-lg border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        QuickBooks is not connected. An admin connects it in Settings → Integrations; then quotes on won deals can be sent as Estimates.
      </div>
    );
  }

  const taxCodes = status.taxCodes;
  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>
          QuickBooks: <span className="font-medium">{status.companyName ?? "connected"}</span>
          {status.environment === "sandbox" && (
            <Badge variant="outline" className="ml-2 border-amber-300 text-[10px] text-amber-700">
              sandbox
            </Badge>
          )}
        </span>
        <span className="text-muted-foreground">
          {taxCodes
            ? `VAT ${taxCodes.vatTaxCodeName} (${taxCodes.vatRate}%), no VAT ${taxCodes.noVatTaxCodeName}`
            : "VAT codes not chosen yet"}
        </span>
        {unlinkedCount > 0 && <span className="text-amber-700">{unlinkedCount} products not linked to QuickBooks</span>}
        {status.canManage && !editing && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              setVat(taxCodes?.vatTaxCodeId ?? "");
              setNoVat(taxCodes?.noVatTaxCodeId ?? "");
              setEditing(true);
            }}
          >
            {taxCodes ? "Change VAT codes" : "Choose VAT codes"}
          </Button>
        )}
      </div>
      {editing && (
        <div className="flex flex-wrap items-end gap-3 border-t pt-2">
          {isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          {error && <p className="text-xs text-destructive">{lookupError(error)}</p>}
          {!isFetching && !error && (
            <>
              <div className="space-y-1">
                <Label htmlFor="qbo-vat-code" className="text-xs">Quotes with VAT</Label>
                <TaxCodeSelect id="qbo-vat-code" value={vat} onChange={setVat} codes={codes.filter((c) => c.rate !== null && c.rate > 0)} placeholder="VAT code" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="qbo-novat-code" className="text-xs">Quotes without VAT</Label>
                <TaxCodeSelect id="qbo-novat-code" value={noVat} onChange={setNoVat} codes={codes} placeholder="No-VAT code" />
              </div>
              <Button
                type="button"
                size="sm"
                disabled={!vat || !noVat || save.isPending}
                onClick={() =>
                  save.mutate(
                    { vatTaxCodeId: vat, noVatTaxCodeId: noVat },
                    {
                      onSuccess: () => {
                        toast.success("VAT codes saved");
                        setEditing(false);
                      },
                    },
                  )
                }
              >
                {save.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Deal: send a quote ────────────────────────────────────────────────────────

/** Where the rep goes to fix each kind of problem. */
function fixLink(p: QuickBooksProblem, companyId: string | null): { href: string; label: string } | null {
  if (p.code === "CUSTOMER_NOT_LINKED" || p.code === "CURRENCY_MISMATCH") {
    return companyId ? { href: `/crm/accounts/${companyId}`, label: "Open the account" } : null;
  }
  if (p.code === "PRODUCT_NOT_LINKED" || p.code === "TAX_CODES_NOT_SET") return { href: "/crm/products", label: "Open Products" };
  return null;
}

function ProblemList({ problems, companyId }: { problems: Array<{ code: string; message: string }>; companyId: string | null }) {
  return (
    <ul className="space-y-1.5">
      {problems.map((p, i) => {
        const fix = fixLink(p as QuickBooksProblem, companyId);
        return (
          <li key={`${p.code}-${i}`} className="flex items-start gap-2 text-sm">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span>
              {p.message}
              {fix && (
                <Link href={fix.href} className="ml-1.5 text-primary hover:underline">
                  {fix.label}
                </Link>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function problemsFromError(err: unknown): Array<{ code: string; message: string }> | null {
  if (!(err instanceof ApiError) || err.code !== "QUOTE_NOT_READY") return null;
  const meta = err.data?.meta as { problems?: Array<{ code: string; message: string }> } | undefined;
  return meta?.problems ?? null;
}

function SendQuoteDialog({
  open,
  onOpenChange,
  dealId,
  quote,
  companyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dealId: string;
  quote: CrmQuoteRow;
  companyId: string | null;
}) {
  const { data: status, isLoading: statusLoading } = useCrmQuickBooksStatus(open);
  // Not connected is already known from the status: no state request to fail on.
  const connected = status?.connected === true;
  const { data: state, isLoading: stateLoading, error } = useQuoteQuickBooksState(dealId, quote.id, open && connected);
  const isLoading = statusLoading || (connected && stateLoading);
  const send = useSendQuoteToQuickBooks(dealId);
  const [sendProblems, setSendProblems] = useState<Array<{ code: string; message: string }> | null>(null);

  const problems = sendProblems ?? state?.problems ?? [];
  const ready = !!state && !state.sent && problems.length === 0;

  function handleSend() {
    setSendProblems(null);
    send.mutate(quote.id, {
      onSuccess: ({ estimate }) => {
        toast.success(
          estimate.adopted ? `Quote ${quote.number} was already in QuickBooks; linked it` : `Quote ${quote.number} sent to QuickBooks as an Estimate`,
          { description: estimate.totalWarning ?? undefined },
        );
        onOpenChange(false);
      },
      onError: (err) => {
        const listed = problemsFromError(err);
        if (listed) {
          setSendProblems(listed);
          return;
        }
        toast.error(err instanceof Error ? err.message : "Could not send the quote to QuickBooks");
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send {quote.number} to QuickBooks</DialogTitle>
          <DialogDescription>
            Creates an Estimate in {status?.companyName ?? "QuickBooks"}
            {status?.environment === "sandbox" ? " (sandbox)" : ""}, one line per product. Finance turns it into the invoice there.
            Once sent, this quote can no longer be edited or deleted here.
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking the quote…
          </p>
        )}
        {status && !connected && (
          <p className="text-sm text-destructive">QuickBooks is not connected. An admin connects it in Settings → Integrations.</p>
        )}
        {error && <p className="text-sm text-destructive">{lookupError(error)}</p>}
        {problems.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Before it can go:</p>
            <ProblemList problems={problems} companyId={companyId} />
          </div>
        )}
        {state?.unresolved && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            QuickBooks did not confirm the last send. Sending again first looks for that Estimate and links it if it exists, so
            it never makes a second one.
          </p>
        )}
        {ready && (
          <p className="text-sm">
            Ready: {quote.lines.length} {quote.lines.length === 1 ? "line" : "lines"}, total{" "}
            <span className="font-medium tabular-nums">{quote.total.toLocaleString(undefined, { minimumFractionDigits: 2 })} {quote.currency}</span>.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!ready || send.isPending} onClick={handleSend}>
            {send.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}
            Send to QuickBooks
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** On a quote row: the badge once sent, else the Send button on a won deal. */
export function QuoteQuickBooksControl({
  dealId,
  quote,
  dealWon,
  companyId,
  canWrite,
}: {
  dealId: string;
  quote: CrmQuoteRow;
  dealWon: boolean;
  companyId: string | null;
  canWrite: boolean;
}) {
  const [open, setOpen] = useState(false);
  const qb = quote.quickBooks;

  if (qb.estimateId) {
    const sentOn = qb.sentAt ? new Date(qb.sentAt).toLocaleDateString() : null;
    return (
      <Badge
        variant="outline"
        className="shrink-0 border-emerald-200 bg-emerald-50 text-[10px] font-normal text-emerald-700"
        title={[`Estimate ${qb.estimateNumber ?? qb.estimateId}`, sentOn && `sent ${sentOn}`, qb.sentByName && `by ${qb.sentByName}`, qb.lastError]
          .filter(Boolean)
          .join(", ")}
      >
        <Check className="mr-1 h-3 w-3" />
        In QuickBooks
        {qb.lastError && <CircleAlert className="ml-1 h-3 w-3 text-amber-600" />}
      </Badge>
    );
  }
  if (qb.sending) {
    return (
      <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
        <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Sending
      </Badge>
    );
  }
  if (!canWrite || !dealWon) {
    return qb.unresolved ? <UnresolvedBadge /> : null;
  }
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={`h-7 shrink-0 px-2 text-xs ${qb.unresolved ? "border-amber-300 text-amber-800" : ""}`}
        title={qb.lastError ?? "Send this quote to QuickBooks as an Estimate"}
        onClick={() => setOpen(true)}
      >
        {qb.unresolved ? <CircleAlert className="mr-1 h-3 w-3" /> : <Send className="mr-1 h-3 w-3" />}
        {qb.unresolved ? "Unconfirmed" : "QuickBooks"}
      </Button>
      {open && <SendQuoteDialog open={open} onOpenChange={setOpen} dealId={dealId} quote={quote} companyId={companyId} />}
    </>
  );
}

function UnresolvedBadge() {
  return (
    <Badge
      variant="outline"
      className="shrink-0 border-amber-300 bg-amber-50 text-[10px] font-normal text-amber-800"
      title="QuickBooks did not confirm the last send. Sending again settles whether the Estimate exists."
    >
      <CircleAlert className="mr-1 h-3 w-3" /> Unconfirmed in QuickBooks
    </Badge>
  );
}

/**
 * Whether a quote's Edit and Delete still apply: never once it is in
 * QuickBooks, on its way, or after a send whose answer was lost.
 */
export function quoteEditable(quote: CrmQuoteRow): boolean {
  const qb = quote.quickBooks;
  return !qb.estimateId && !qb.sending && !qb.unresolved;
}
