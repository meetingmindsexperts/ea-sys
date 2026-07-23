"use client";

/**
 * Files held BY the deal — the sponsorship prospectus (one, upload replaces)
 * + supporting PDFs. What lives here is offered as an opt-in attachment in the
 * deal's Email dialog, so the prospectus is uploaded once and sent many times.
 *
 * PDF only, 10MB (server-enforced with magic bytes; checked here too so the
 * rep gets an instant answer instead of a round trip).
 */
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Download, FileText, Loader2, ReceiptText, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  useCrmDealDocuments,
  useDeleteCrmDealDocument,
  useGenerateCrmDealQuote,
  useUploadCrmDealDocument,
} from "@/crm/hooks/use-crm-api";
import type { CrmDealDocumentRow } from "@/crm/lib/crm-types";

const MAX_SIZE = 10 * 1024 * 1024;

function DocRow({
  doc,
  dealId,
  canWrite,
  onDelete,
  deleting,
}: {
  doc: CrmDealDocumentRow;
  dealId: string;
  canWrite: boolean;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <li className="flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-sm">
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        {doc.label || doc.filename}
        <span className="ml-2 text-xs tabular-nums text-muted-foreground">
          {(doc.size / 1024).toFixed(0)} KB
        </span>
      </span>
      {/* Files are private (blocked on the public /uploads route) — download via
          the authed streaming endpoint, not the raw disk URL. */}
      <Button asChild variant="ghost" size="icon" className="h-7 w-7 shrink-0">
        <a
          href={`/api/crm/deals/${dealId}/documents/${doc.id}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Download"
        >
          <Download className="h-3.5 w-3.5" />
        </a>
      </Button>
      {canWrite && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
          disabled={deleting}
          onClick={() => {
            if (!confirm(`Remove "${doc.label || doc.filename}" from this deal?`)) return;
            onDelete();
          }}
          title="Remove"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </li>
  );
}

export function CrmDealDocumentsCard({
  dealId,
  canWrite,
  defaultTaxRate,
  defaultTaxLabel,
}: {
  dealId: string;
  canWrite: boolean;
  /** Pre-fill for the quote dialog — the linked event's tax config, if any. */
  defaultTaxRate?: string | number | null;
  defaultTaxLabel?: string | null;
}) {
  const { data: documents = [], isLoading } = useCrmDealDocuments(dealId);
  const upload = useUploadCrmDealDocument(dealId);
  const remove = useDeleteCrmDealDocument(dealId);
  const generateQuote = useGenerateCrmDealQuote(dealId);

  const prospectusInput = useRef<HTMLInputElement>(null);
  const otherInput = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState("");

  // Quote dialog state — tax pre-filled from the linked event.
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [taxRate, setTaxRate] = useState(defaultTaxRate != null ? String(defaultTaxRate) : "");
  const [taxLabel, setTaxLabel] = useState(defaultTaxLabel || "VAT");
  const [validityDays, setValidityDays] = useState("30");
  const [quoteNotes, setQuoteNotes] = useState("");

  const prospectus = documents.find((d) => d.kind === "PROSPECTUS");
  const quotes = documents.filter((d) => d.kind === "QUOTE");
  const others = documents.filter((d) => d.kind === "OTHER");

  async function handleGenerateQuote() {
    const rate = taxRate.trim() ? Number(taxRate) : null;
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
      toast.error("Tax rate must be between 0 and 100");
      return;
    }
    const days = Number(validityDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      toast.error("Validity must be between 1 and 365 days");
      return;
    }
    try {
      const res = await generateQuote.mutateAsync({
        taxRate: rate,
        taxLabel: taxLabel.trim() || undefined,
        validityDays: days,
        notes: quoteNotes.trim() || null,
      });
      toast.success(`Quote ${res.quoteNumber} generated`);
      setQuoteOpen(false);
      setQuoteNotes("");
    } catch {
      // Surfaced by the hook's onError toast (e.g. no products / mixed currencies).
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>, kind: "PROSPECTUS" | "OTHER") {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.type !== "application/pdf") {
      toast.error("Only PDF files are allowed");
      return;
    }
    if (file.size > MAX_SIZE) {
      toast.error("File must be under 10MB");
      return;
    }
    const replacing = kind === "PROSPECTUS" && !!prospectus;
    await upload.mutateAsync({ file, kind, label: kind === "OTHER" ? label.trim() || undefined : undefined });
    toast.success(
      kind === "PROSPECTUS" ? (replacing ? "Prospectus replaced" : "Prospectus uploaded") : "Document added",
    );
    setLabel("");
  }

  if (isLoading) {
    return <div className="h-16 animate-pulse rounded-md border bg-muted/30" />;
  }

  return (
    <div className="space-y-4">
      {/* ── Quotes (generated from the deal's Products — numbered, history kept) ── */}
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
          Quotes
          <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-[10px] font-normal normal-case text-emerald-700">
            from the Products card
          </Badge>
        </p>
        {quotes.length > 0 ? (
          <ul className="space-y-1">
            {quotes.map((d) => (
              <DocRow
                key={d.id}
                dealId={dealId}
                doc={d}
                canWrite={canWrite}
                deleting={remove.isPending}
                onDelete={() => remove.mutate(d.id)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No quotes yet — add products to the deal, then generate one.
          </p>
        )}
        {canWrite && (
          <Button size="sm" variant="outline" disabled={generateQuote.isPending} onClick={() => setQuoteOpen(true)}>
            {generateQuote.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <ReceiptText className="mr-2 h-3.5 w-3.5" />
            )}
            Generate quote
          </Button>
        )}
      </div>

      {/* ── The prospectus slot (one per deal — upload replaces) ──────────── */}
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
          Sponsorship prospectus
          <Badge variant="outline" className="border-sky-200 bg-sky-50 text-[10px] font-normal normal-case text-sky-700">
            attachable in Email
          </Badge>
        </p>
        {prospectus ? (
          <ul>
            <DocRow
              dealId={dealId}
              doc={prospectus}
              canWrite={canWrite}
              deleting={remove.isPending}
              onDelete={() => remove.mutate(prospectus.id)}
            />
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No prospectus uploaded yet.</p>
        )}
        {canWrite && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={upload.isPending}
              onClick={() => prospectusInput.current?.click()}
            >
              {upload.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-2 h-3.5 w-3.5" />}
              {prospectus ? "Replace prospectus" : "Upload prospectus"}
            </Button>
            <input
              ref={prospectusInput}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => handleFile(e, "PROSPECTUS")}
            />
          </>
        )}
      </div>

      {/* ── Other documents ───────────────────────────────────────────────── */}
      <div className="space-y-2">
        <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Other documents</p>
        {others.length > 0 ? (
          <ul className="space-y-1">
            {others.map((d) => (
              <DocRow
                key={d.id}
                dealId={dealId}
                doc={d}
                canWrite={canWrite}
                deleting={remove.isPending}
                onDelete={() => remove.mutate(d.id)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Contract drafts, rate cards… (PDF, 10MB)</p>
        )}
        {canWrite && (
          <div className="flex items-center gap-2">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (optional)"
              className="h-8 max-w-[14rem]"
            />
            <Button size="sm" variant="outline" disabled={upload.isPending} onClick={() => otherInput.current?.click()}>
              {upload.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-2 h-3.5 w-3.5" />}
              Add PDF
            </Button>
            <input
              ref={otherInput}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => handleFile(e, "OTHER")}
            />
          </div>
        )}
      </div>

      {/* ── Generate-quote dialog ─────────────────────────────────────────── */}
      <Dialog open={quoteOpen} onOpenChange={setQuoteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Generate a quote</DialogTitle>
            <DialogDescription asChild>
              <span>
                Line items come from the deal&apos;s Products card. The quote gets the next
                number, lands under Documents, and can be attached in Email.
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="quote-tax-rate">Tax rate %</Label>
                <Input
                  id="quote-tax-rate"
                  inputMode="decimal"
                  value={taxRate}
                  onChange={(e) => setTaxRate(e.target.value)}
                  placeholder="none"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="quote-tax-label">Tax label</Label>
                <Input id="quote-tax-label" value={taxLabel} onChange={(e) => setTaxLabel(e.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="quote-validity">Valid for (days)</Label>
              <Input
                id="quote-validity"
                inputMode="numeric"
                value={validityDays}
                onChange={(e) => setValidityDays(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="quote-notes">Notes (printed on the quote)</Label>
              <Textarea
                id="quote-notes"
                rows={3}
                value={quoteNotes}
                onChange={(e) => setQuoteNotes(e.target.value)}
                placeholder="Payment terms, inclusions…"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setQuoteOpen(false)} disabled={generateQuote.isPending}>
              Cancel
            </Button>
            <Button onClick={handleGenerateQuote} disabled={generateQuote.isPending}>
              {generateQuote.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
