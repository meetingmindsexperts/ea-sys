"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { FileText, Receipt } from "lucide-react";

interface InvoiceItem {
  id: string;
  type: "INVOICE" | "RECEIPT" | "CREDIT_NOTE";
  invoiceNumber: string;
  status: string;
}

/**
 * Shows invoice/receipt download buttons for a registration.
 *
 * If the registration has an Invoice row, the button downloads the real
 * invoice PDF. If it only has a Receipt, shows the receipt PDF. If neither
 * exists (typical pre-payment or when invoice creation hasn't run yet),
 * falls back to the Quote PDF — labeled **Quote**, not Invoice, so the
 * registrant knows what document they're actually receiving.
 */
export function InvoiceDownloadButtons({ registrationId }: { registrationId: string }) {
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch(`/api/registrant/registrations/${registrationId}/invoices`)
      .then(r => r.ok ? r.json() : [])
      .then(data => { setInvoices(data); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [registrationId]);

  if (!loaded) return null;

  const invoice = invoices.find(i => i.type === "INVOICE");
  const receipt = invoices.find(i => i.type === "RECEIPT");

  // No real invoice or receipt → the quote PDF is the only thing we can
  // hand back. Label the button honestly.
  if (!invoice && !receipt) {
    return (
      <Button variant="outline" size="sm" asChild>
        <a href={`/api/registrant/registrations/${registrationId}/quote`} download>
          <FileText className="mr-2 h-3.5 w-3.5" /> Download Quote
        </a>
      </Button>
    );
  }

  return (
    <div className="flex gap-2">
      {invoice && (
        <Button variant="outline" size="sm" asChild>
          <a href={`/api/registrant/registrations/${registrationId}/invoices/${invoice.id}/pdf`} download>
            <FileText className="mr-2 h-3.5 w-3.5" /> Invoice
          </a>
        </Button>
      )}
      {receipt && (
        <Button variant="outline" size="sm" asChild>
          <a href={`/api/registrant/registrations/${registrationId}/invoices/${receipt.id}/pdf`} download>
            <Receipt className="mr-2 h-3.5 w-3.5" /> Receipt
          </a>
        </Button>
      )}
    </div>
  );
}
