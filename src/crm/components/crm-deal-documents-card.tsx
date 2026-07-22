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
import { Download, FileText, Loader2, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useCrmDealDocuments,
  useDeleteCrmDealDocument,
  useUploadCrmDealDocument,
} from "@/crm/hooks/use-crm-api";
import type { CrmDealDocumentRow } from "@/crm/lib/crm-types";

const MAX_SIZE = 10 * 1024 * 1024;

function DocRow({
  doc,
  canWrite,
  onDelete,
  deleting,
}: {
  doc: CrmDealDocumentRow;
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
      <Button asChild variant="ghost" size="icon" className="h-7 w-7 shrink-0">
        <a href={doc.url} target="_blank" rel="noopener noreferrer" title="Download">
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

export function CrmDealDocumentsCard({ dealId, canWrite }: { dealId: string; canWrite: boolean }) {
  const { data: documents = [], isLoading } = useCrmDealDocuments(dealId);
  const upload = useUploadCrmDealDocument(dealId);
  const remove = useDeleteCrmDealDocument(dealId);

  const prospectusInput = useRef<HTMLInputElement>(null);
  const otherInput = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState("");

  const prospectus = documents.find((d) => d.kind === "PROSPECTUS");
  const others = documents.filter((d) => d.kind === "OTHER");

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
    </div>
  );
}
