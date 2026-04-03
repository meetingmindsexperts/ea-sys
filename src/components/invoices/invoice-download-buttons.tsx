"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, FileText, Receipt } from "lucide-react";

interface InvoiceItem {
  id: string;
  type: "INVOICE" | "RECEIPT" | "CREDIT_NOTE";
  invoiceNumber: string;
  status: string;
}

/**
 * Shows invoice/receipt download buttons for a registration.
 * Falls back to the existing quote download if no invoices exist.
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

  // No invoices → fall back to existing quote
  if (invoices.length === 0) {
    return (
      <Button variant="outline" size="sm" asChild>
        <a href={`/api/registrant/registrations/${registrationId}/quote`} download>
          <Download className="mr-2 h-3.5 w-3.5" /> Invoice
        </a>
      </Button>
    );
  }

  const invoice = invoices.find(i => i.type === "INVOICE");
  const receipt = invoices.find(i => i.type === "RECEIPT");

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
      {!invoice && !receipt && (
        <Button variant="outline" size="sm" asChild>
          <a href={`/api/registrant/registrations/${registrationId}/quote`} download>
            <Download className="mr-2 h-3.5 w-3.5" /> Invoice
          </a>
        </Button>
      )}
    </div>
  );
}
