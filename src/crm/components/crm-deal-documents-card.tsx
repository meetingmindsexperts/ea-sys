"use client";

/**
 * Files held BY the deal: saved quotes, the sponsorship prospectus (one, upload
 * replaces) and supporting PDFs. Everything here is offered as an opt-in
 * attachment in the deal's Email dialog.
 *
 * Quotes (Sep 15 2026) are SAVED and editable: the list shows the quote rows
 * with Open PDF / Edit / Delete, and the editor dialog holds every option.
 * Deleting a quote needs the CRM delete permission (admin or CRM user), like
 * archiving any other CRM record; editing needs write. Quote PDFs generated
 * before that date have no saved row; they stay listed underneath as PDF-only
 * files.
 *
 * PDF only, 10MB for uploads (server-enforced with magic bytes; checked here too
 * so the rep gets an instant answer instead of a round trip).
 */
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Download, FileText, Loader2, Pencil, Plus, ReceiptText, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useArchiveCrmDealQuote,
  useCrmDealDocuments,
  useCrmDealQuotes,
  useDeleteCrmDealDocument,
  useUploadCrmDealDocument,
} from "@/crm/hooks/use-crm-api";
import { QuoteEditorDialog } from "@/crm/components/crm-quote-editor-dialog";
import { formatQuoteDate, formatQuoteMoney, type CrmQuoteRow } from "@/crm/lib/quote-rules";
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
      {/* Files are private (blocked on the public /uploads route): download via
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

function QuoteRow({
  quote,
  dealId,
  canWrite,
  canDelete,
  deleting,
  onEdit,
  onDelete,
}: {
  quote: CrmQuoteRow;
  dealId: string;
  canWrite: boolean;
  canDelete: boolean;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-sm">
      <ReceiptText className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate">
          <span className="font-medium tabular-nums">{quote.number}</span>
          <span className="mx-1.5 text-muted-foreground">·</span>
          {quote.title}
        </p>
        <p className="truncate text-xs tabular-nums text-muted-foreground">
          {formatQuoteMoney(quote.total, quote.currency)} · valid till {formatQuoteDate(quote.validUntil)} ·{" "}
          {quote.lines.length} {quote.lines.length === 1 ? "line" : "lines"}
        </p>
      </div>
      {quote.documentId && (
        <Button asChild variant="ghost" size="icon" className="h-7 w-7 shrink-0">
          <a
            href={`/api/crm/deals/${dealId}/documents/${quote.documentId}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open PDF"
          >
            <Download className="h-3.5 w-3.5" />
          </a>
        </Button>
      )}
      {canWrite && (
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onEdit} title="Edit quote">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      )}
      {canDelete && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
          disabled={deleting}
          onClick={() => {
            if (!confirm(`Delete quote ${quote.number}? Its PDF is removed from this deal.`)) return;
            onDelete();
          }}
          title="Delete quote"
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
  canDelete,
}: {
  dealId: string;
  canWrite: boolean;
  /** The CRM delete permission (admin or CRM user): deleting a quote needs it. */
  canDelete: boolean;
}) {
  const { data: documents = [], isLoading } = useCrmDealDocuments(dealId);
  const { data: quotes = [] } = useCrmDealQuotes(dealId);
  const upload = useUploadCrmDealDocument(dealId);
  const remove = useDeleteCrmDealDocument(dealId);
  const archiveQuote = useArchiveCrmDealQuote(dealId);

  const prospectusInput = useRef<HTMLInputElement>(null);
  const otherInput = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState("");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingQuote, setEditingQuote] = useState<CrmQuoteRow | null>(null);
  // Each open mounts a fresh editor. The dialog stays mounted between opens, and
  // its form seeds its fields once, so without this a quick Edit on another quote
  // could keep the previous quote's values under the new quote's version (review M3).
  const [editorSession, setEditorSession] = useState(0);

  const prospectus = documents.find((d) => d.kind === "PROSPECTUS");
  const others = documents.filter((d) => d.kind === "OTHER");
  // A saved quote's PDF is shown on its quote row; only PDFs with no saved quote
  // (generated before quotes became editable) are listed on their own.
  const linkedDocumentIds = new Set(quotes.map((q) => q.documentId).filter(Boolean));
  const earlierQuotePdfs = documents.filter((d) => d.kind === "QUOTE" && !linkedDocumentIds.has(d.id));

  function openEditor(quote: CrmQuoteRow | null) {
    setEditingQuote(quote);
    setEditorSession((n) => n + 1);
    setEditorOpen(true);
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
      {/* ── Quotes ─────────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
          Quotes
          <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-[10px] font-normal normal-case text-emerald-700">
            saved and editable
          </Badge>
        </p>
        {quotes.length > 0 ? (
          <ul className="space-y-1">
            {quotes.map((q) => (
              <QuoteRow
                key={q.id}
                quote={q}
                dealId={dealId}
                canWrite={canWrite}
                canDelete={canDelete}
                deleting={archiveQuote.isPending}
                onEdit={() => openEditor(q)}
                onDelete={() =>
                  archiveQuote.mutate(q.id, { onSuccess: () => toast.success(`Quote ${q.number} deleted`) })
                }
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No quotes yet. Start one from the deal&apos;s products or add lines by hand.
          </p>
        )}
        {earlierQuotePdfs.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Earlier quote PDFs (not editable)</p>
            <ul className="space-y-1">
              {earlierQuotePdfs.map((d) => (
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
          </div>
        )}
        {canWrite && (
          <Button size="sm" variant="outline" onClick={() => openEditor(null)}>
            <Plus className="mr-2 h-3.5 w-3.5" />
            New quote
          </Button>
        )}
      </div>

      {/* ── The prospectus slot (one per deal, upload replaces) ────────────── */}
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

      {/* ── Other documents ─────────────────────────────────────────────────── */}
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

      <QuoteEditorDialog
        key={editorSession}
        dealId={dealId}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        quote={editingQuote}
      />
    </div>
  );
}
