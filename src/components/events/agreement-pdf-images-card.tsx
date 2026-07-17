"use client";

import { useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Upload, Trash2, ImageIcon } from "lucide-react";
import { toast } from "sonner";

type Scope = "speaker" | "presenter";
type Slot = "header" | "footer";

interface Props {
  eventId: string;
  /** Which agreement's letterhead pair this card manages. */
  scope: Scope;
  /** Current URLs from the already-loaded event row (null = not set). */
  initialHeaderUrl: string | null;
  initialFooterUrl: string | null;
}

const SCOPE_COPY: Record<Scope, { title: string; agreementLabel: string; docxNote: string }> = {
  speaker: {
    title: "Agreement PDF Letterhead",
    agreementLabel: "speaker agreement",
    docxNote: " An uploaded .docx template carries its own branding and ignores these.",
  },
  presenter: {
    title: "Agreement PDF Letterhead",
    agreementLabel: "presenter agreement",
    docxNote: "",
  },
};

const SLOT_COPY: Record<Slot, { title: string; hint: string }> = {
  header: {
    title: "PDF header image",
    hint: "Drawn edge-to-edge at the top of every page. Wide banner recommended (e.g. 2000×400px).",
  },
  footer: {
    title: "PDF footer image",
    hint: "Drawn edge-to-edge at the bottom of every page. Wide strip recommended (e.g. 2000×250px).",
  },
};

/**
 * Letterhead images for a generated agreement PDF. The speaker and presenter
 * agreements each have their own pair (`scope`). Applies to the inline
 * HTML→PDF path only — the public acceptance pages show the text without
 * them.
 */
export function AgreementPdfImagesCard({ eventId, scope, initialHeaderUrl, initialFooterUrl }: Props) {
  const [urls, setUrls] = useState<Record<Slot, string | null>>({
    header: initialHeaderUrl,
    footer: initialFooterUrl,
  });
  const [busy, setBusy] = useState<Slot | null>(null);
  const headerInputRef = useRef<HTMLInputElement | null>(null);
  const footerInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = (slot: Slot) => (slot === "header" ? headerInputRef : footerInputRef);

  const handleUpload = async (slot: Slot, file: File) => {
    setBusy(slot);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("scope", scope);
      formData.append("slot", slot);
      const res = await fetch(`/api/events/${eventId}/agreement-pdf-images`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Upload failed");
      setUrls((prev) => ({ ...prev, [slot]: data.url }));
      toast.success(`${SLOT_COPY[slot].title} uploaded`);
    } catch (err) {
      console.error("agreement-pdf-image:upload-failed", err);
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(null);
      const ref = inputRef(slot);
      if (ref.current) ref.current.value = "";
    }
  };

  const handleDelete = async (slot: Slot) => {
    if (!confirm(`Remove the ${slot} image? Future ${SCOPE_COPY[scope].agreementLabel} PDFs will render without it.`)) return;
    setBusy(slot);
    try {
      const res = await fetch(`/api/events/${eventId}/agreement-pdf-images?scope=${scope}&slot=${slot}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data?.error || "Delete failed");
      }
      setUrls((prev) => ({ ...prev, [slot]: null }));
      toast.success(`${SLOT_COPY[slot].title} removed`);
    } catch (err) {
      console.error("agreement-pdf-image:delete-failed", err);
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  };

  const renderSlot = (slot: Slot) => {
    const url = urls[slot];
    const isBusy = busy === slot;
    return (
      <div key={slot} className="space-y-2">
        <p className="text-sm font-medium">{SLOT_COPY[slot].title}</p>
        {url ? (
          <div className="rounded-lg border p-3 space-y-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- local upload preview, no next/image optimization needed */}
            <img src={url} alt={`${SCOPE_COPY[scope].agreementLabel} PDF ${slot} image`} className="max-h-32 w-full object-contain rounded bg-muted/30" />
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => inputRef(slot).current?.click()} disabled={isBusy}>
                {isBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                Replace
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleDelete(slot)} disabled={isBusy}>
                {isBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                Remove
              </Button>
            </div>
          </div>
        ) : (
          <div
            className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 cursor-pointer hover:bg-muted/30"
            onClick={() => inputRef(slot).current?.click()}
          >
            {isBusy ? (
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            ) : (
              <ImageIcon className="h-6 w-6 text-muted-foreground" />
            )}
            <p className="text-sm font-medium">{isBusy ? "Uploading..." : "Click to upload"}</p>
            <p className="text-xs text-muted-foreground text-center">PNG or JPEG, max 2MB</p>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{SLOT_COPY[slot].hint}</p>
        <input
          ref={inputRef(slot)}
          type="file"
          accept="image/png,image/jpeg"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleUpload(slot, file);
          }}
        />
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{SCOPE_COPY[scope].title}</CardTitle>
        <CardDescription>
          Optional header and footer banners drawn on every page of the generated{" "}
          {SCOPE_COPY[scope].agreementLabel} PDF, built from the agreement text above.
          {SCOPE_COPY[scope].docxNote} PNG or JPEG only (WebP is not supported in PDFs).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {renderSlot("header")}
          {renderSlot("footer")}
        </div>
      </CardContent>
    </Card>
  );
}
