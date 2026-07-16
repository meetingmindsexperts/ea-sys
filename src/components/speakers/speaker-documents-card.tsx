"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  FileText,
  FileSignature,
  Download,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

/**
 * Per-speaker documents (July 16, 2026, owner request):
 *   - ONE signed-agreement copy (replace on re-upload) — the file an
 *     organizer received back after the speaker signed. Stored for future
 *     reference; deliberately independent of the "Mark as Accepted" state.
 *   - Any number of other documents (bio doc, CV, ...), with an optional
 *     label.
 * PDF + DOC/DOCX, 10MB — enforced server-side (magic bytes); the file
 * inputs mirror it with an `accept` filter.
 */

interface SpeakerDocumentRow {
  id: string;
  kind: "SIGNED_AGREEMENT" | "OTHER";
  url: string;
  filename: string;
  label: string | null;
  mimeType: string;
  size: number;
  createdAt: string;
  uploadedBy: { firstName: string; lastName: string } | null;
}

const ACCEPT =
  "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SpeakerDocumentsCard({
  eventId,
  speakerId,
}: {
  eventId: string;
  speakerId: string;
}) {
  const [documents, setDocuments] = useState<SpeakerDocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadingKind, setUploadingKind] = useState<"SIGNED_AGREEMENT" | "OTHER" | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [otherLabel, setOtherLabel] = useState("");
  const agreementInputRef = useRef<HTMLInputElement>(null);
  const otherInputRef = useRef<HTMLInputElement>(null);

  const baseUrl = `/api/events/${eventId}/speakers/${speakerId}/documents`;

  const fetchDocuments = useCallback(async () => {
    try {
      const res = await fetch(baseUrl);
      if (!res.ok) {
        console.error("[speaker-documents] load failed:", res.status);
        toast.error("Couldn't load speaker documents");
        return;
      }
      const data = await res.json();
      setDocuments(data.documents ?? []);
    } catch (err) {
      console.error("[speaker-documents] load failed:", err);
      toast.error("Couldn't load speaker documents");
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    void fetchDocuments();
  }, [fetchDocuments]);

  const handleUpload = async (kind: "SIGNED_AGREEMENT" | "OTHER", file: File) => {
    setUploadingKind(kind);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("kind", kind);
      if (kind === "OTHER" && otherLabel.trim()) {
        formData.append("label", otherLabel.trim());
      }
      const res = await fetch(baseUrl, { method: "POST", body: formData });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error || "Failed to upload document");
        return;
      }
      toast.success(
        kind === "SIGNED_AGREEMENT" ? "Signed agreement saved" : "Document uploaded",
      );
      setOtherLabel("");
      await fetchDocuments();
    } catch (err) {
      console.error("[speaker-documents] upload failed:", err);
      toast.error("Failed to upload document");
    } finally {
      setUploadingKind(null);
    }
  };

  const handleDelete = async (doc: SpeakerDocumentRow) => {
    if (!confirm(`Delete "${doc.label || doc.filename}"? This cannot be undone.`)) return;
    setDeletingId(doc.id);
    try {
      const res = await fetch(`${baseUrl}/${doc.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error || "Failed to delete document");
        return;
      }
      toast.success("Document deleted");
      await fetchDocuments();
    } catch (err) {
      console.error("[speaker-documents] delete failed:", err);
      toast.error("Failed to delete document");
    } finally {
      setDeletingId(null);
    }
  };

  const signedAgreement = documents.find((d) => d.kind === "SIGNED_AGREEMENT") ?? null;
  const otherDocs = documents.filter((d) => d.kind === "OTHER");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          Documents
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Signed agreement — one per speaker, replace on re-upload */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Signed agreement
              </p>
              {signedAgreement ? (
                <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <FileSignature className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{signedAgreement.filename}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatSize(signedAgreement.size)} ·{" "}
                      {new Date(signedAgreement.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                      {signedAgreement.uploadedBy
                        ? ` · by ${signedAgreement.uploadedBy.firstName} ${signedAgreement.uploadedBy.lastName}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <a href={signedAgreement.url} target="_blank" rel="noopener noreferrer">
                      <Button variant="ghost" size="icon" className="h-7 w-7" title="Download">
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                    </a>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-red-500 hover:text-red-600"
                      title="Delete"
                      disabled={deletingId === signedAgreement.id}
                      onClick={() => handleDelete(signedAgreement)}
                    >
                      {deletingId === signedAgreement.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground mb-2">
                  Upload the signed copy the speaker returned (kept for future reference —
                  this does not change the agreement status above).
                </p>
              )}
              <input
                ref={agreementInputRef}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleUpload("SIGNED_AGREEMENT", file);
                  e.target.value = "";
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="w-full mt-2"
                disabled={uploadingKind !== null}
                onClick={() => agreementInputRef.current?.click()}
              >
                {uploadingKind === "SIGNED_AGREEMENT" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                {signedAgreement ? "Replace signed agreement" : "Upload signed agreement"}
              </Button>
            </div>

            {/* Other documents — bio doc, CV, ... */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Other documents
              </p>
              {otherDocs.length === 0 ? (
                <p className="text-xs text-muted-foreground mb-2">
                  No documents yet — attach a bio doc, CV, or any PDF/DOC.
                </p>
              ) : (
                <div className="space-y-2 mb-2">
                  {otherDocs.map((doc) => (
                    <div
                      key={doc.id}
                      className="flex items-start gap-2 rounded-lg border border-slate-200 p-2.5"
                    >
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {doc.label || doc.filename}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {doc.label ? `${doc.filename} · ` : ""}
                          {formatSize(doc.size)} ·{" "}
                          {new Date(doc.createdAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </p>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <a href={doc.url} target="_blank" rel="noopener noreferrer">
                          <Button variant="ghost" size="icon" className="h-7 w-7" title="Download">
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                        </a>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-red-500 hover:text-red-600"
                          title="Delete"
                          disabled={deletingId === doc.id}
                          onClick={() => handleDelete(doc)}
                        >
                          {deletingId === doc.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <Input
                value={otherLabel}
                onChange={(e) => setOtherLabel(e.target.value)}
                placeholder="Label (optional, e.g. Bio)"
                className="h-8 text-sm mb-2"
                maxLength={200}
              />
              <input
                ref={otherInputRef}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleUpload("OTHER", file);
                  e.target.value = "";
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={uploadingKind !== null}
                onClick={() => otherInputRef.current?.click()}
              >
                {uploadingKind === "OTHER" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                Add document
              </Button>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                PDF or DOC/DOCX, up to 10MB.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
