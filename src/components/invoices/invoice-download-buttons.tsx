"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FileText, Loader2, Receipt } from "lucide-react";

interface InvoiceItem {
  id: string;
  type: "INVOICE" | "RECEIPT" | "CREDIT_NOTE";
  invoiceNumber: string;
  status: string;
}

interface Props {
  registrationId: string;
  /**
   * When provided, the "Download Quote" fallback uses the unauthenticated
   * public route `/api/public/events/${eventSlug}/registrations/${id}/document`
   * — resilient to expired JWT sessions on stale tabs (the previous
   * `/api/registrant/.../quote` route returned JSON 401 which the browser
   * saved as `quote.json`).
   *
   * When NOT provided, falls back to the auth-required registrant quote
   * route. Pass this whenever the slug is available — i.e. always from
   * the registrant portal.
   */
  eventSlug?: string;
}

/**
 * Shows invoice/receipt download buttons for a registration.
 *
 * Precedence:
 *   - Real Invoice row → fetch-then-blob download. If the user's session
 *     has lapsed mid-tab the auth-required PDF route would otherwise
 *     return JSON 401 and the browser would save it as `pdf.json`. The
 *     fetch wrapper catches the 401/403 and toasts instead.
 *   - Real Receipt row → same fetch-then-blob path.
 *   - Neither → fall back to the Quote PDF, labeled honestly as "Download
 *     Quote". When `eventSlug` is provided this uses the public
 *     `/document` route which works regardless of session state; otherwise
 *     uses the auth-required registrant `/quote` route as a last resort.
 */
export function InvoiceDownloadButtons({ registrationId, eventSlug }: Props) {
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/registrant/registrations/${registrationId}/invoices`)
      .then(r => r.ok ? r.json() : [])
      .then(data => { setInvoices(data); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [registrationId]);

  if (!loaded) return null;

  const invoice = invoices.find(i => i.type === "INVOICE");
  const receipt = invoices.find(i => i.type === "RECEIPT");

  // No real invoice or receipt → quote fallback. Public `/document` route
  // when we have a slug; auth-required `/quote` otherwise.
  if (!invoice && !receipt) {
    const fallbackUrl = eventSlug
      ? `/api/public/events/${eventSlug}/registrations/${registrationId}/document`
      : `/api/registrant/registrations/${registrationId}/quote`;
    return (
      <Button variant="outline" size="sm" asChild>
        <a href={fallbackUrl} download>
          <FileText className="mr-2 h-3.5 w-3.5" /> Download Quote
        </a>
      </Button>
    );
  }

  return (
    <div className="flex gap-2">
      {invoice && (
        <Button
          variant="outline"
          size="sm"
          disabled={downloadingId === invoice.id}
          onClick={() =>
            downloadAuthPdf(
              `/api/registrant/registrations/${registrationId}/invoices/${invoice.id}/pdf`,
              `${invoice.invoiceNumber}.pdf`,
              setDownloadingId,
              invoice.id,
            )
          }
        >
          {downloadingId === invoice.id ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileText className="mr-2 h-3.5 w-3.5" />
          )}
          Invoice
        </Button>
      )}
      {receipt && (
        <Button
          variant="outline"
          size="sm"
          disabled={downloadingId === receipt.id}
          onClick={() =>
            downloadAuthPdf(
              `/api/registrant/registrations/${registrationId}/invoices/${receipt.id}/pdf`,
              `${receipt.invoiceNumber}.pdf`,
              setDownloadingId,
              receipt.id,
            )
          }
        >
          {downloadingId === receipt.id ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Receipt className="mr-2 h-3.5 w-3.5" />
          )}
          Receipt
        </Button>
      )}
    </div>
  );
}

/**
 * Fetches an auth-required PDF route and triggers a browser download.
 *
 * `<a href download>` would let the browser save 401/403 JSON responses
 * verbatim as `pdf.json` — confusing UX. This wrapper checks status,
 * surfaces auth failures via toast, and only saves the file on 2xx.
 */
async function downloadAuthPdf(
  url: string,
  filename: string,
  setDownloadingId: (id: string | null) => void,
  rowId: string,
): Promise<void> {
  setDownloadingId(rowId);
  try {
    const res = await fetch(url);
    if (res.status === 401 || res.status === 403) {
      toast.error("Session expired. Please log in again to download.");
      return;
    }
    if (!res.ok) {
      // Try to surface the server's error message; fall back to a generic.
      let message = "Download failed";
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        // Response wasn't JSON — keep the generic message.
      }
      console.error("[invoice-download] non-ok response", { url, status: res.status, message });
      toast.error(message);
      return;
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      // Defer revoke a tick so the browser actually starts the download
      // before we drop the reference. 100ms is plenty for the click event
      // to register.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
    }
  } catch (err) {
    console.error("[invoice-download] network error", err);
    toast.error("Download failed. Please try again.");
  } finally {
    setDownloadingId(null);
  }
}
