"use client";

/**
 * Event Setup → Export Data (Sep 30, 2026): the whole event as one ZIP of
 * CSVs. The page only describes the file and starts the download; what goes
 * in, and who may take it, is decided by /api/events/[eventId]/export-bundle
 * (see src/lib/event-export/bundle.ts). The ZIP's README lists every file with
 * its row count, and anything left out with the reason.
 */
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Download, FileSpreadsheet, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useCan } from "@/hooks/use-can";
import { downloadExport } from "@/lib/export-download";
import { useEvent } from "@/hooks/use-api";

const GROUPS: { title: string; items: string[] }[] = [
  { title: "People", items: ["Registrations", "Speakers", "Accommodation bookings", "RSVP guest lists"] },
  { title: "Programme", items: ["Sessions", "Session topics", "Abstracts", "Session proposals"] },
  { title: "Money", items: ["Invoices and receipts", "Registration types and pricing tiers", "Promo codes", "Reimbursements", "Travel grants"] },
  { title: "Event", items: ["Event details", "Sponsors", "Hotels and room types", "Survey responses", "Webinar attendance (webinar and hybrid events)"] },
];

export default function ExportDataPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const { data: event } = useEvent(eventId);
  const [busy, setBusy] = useState(false);
  const allowed = useCan("events.export", eventId) === "allowed";
  const slug = (event as { slug?: string } | undefined)?.slug ?? "event";

  const run = async () => {
    setBusy(true);
    const result = await downloadExport({
      url: `/api/events/${eventId}/export-bundle`,
      filename: `${slug}-data-${new Date().toISOString().slice(0, 10)}.zip`,
      logKey: "event-export:download-failed",
      forbiddenMessage: "Only admins and organisers can export an event's data.",
    });
    setBusy(false);
    if (result.ok) toast.success("Export downloaded. Open README.txt in the ZIP for what is inside.");
    else toast.error(result.error);
  };

  return (
    <div className="container max-w-4xl py-8 space-y-6">
      <Link href={`/events/${eventId}/setup`} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3 w-3 mr-1" />
        Back to Event Setup
      </Link>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Export Data</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Everything for this event in one ZIP file: one spreadsheet (CSV) per area, plus a README listing every file and
          how many rows it holds. Each spreadsheet is the same as that page&rsquo;s own export.
        </p>
      </div>

      <Card className="overflow-hidden pt-0">
        <div className="bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border-b px-6 py-5 flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <FileSpreadsheet className="h-5 w-5" />
            </div>
            <div>
              <p className="font-semibold">{(event as { name?: string } | undefined)?.name ?? "This event"}</p>
              <p className="text-sm text-muted-foreground">ZIP of spreadsheets, opens in Excel, Numbers or Google Sheets</p>
            </div>
          </div>
          {allowed ? (
            <Button onClick={() => void run()} disabled={busy} size="lg">
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
              {busy ? "Preparing the file…" : "Export data"}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">Only admins and organisers can export an event&rsquo;s data.</p>
          )}
        </div>
        <CardContent className="p-6 space-y-5">
          {busy && <p className="text-sm text-muted-foreground">A large event can take a minute. Keep this page open.</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            {GROUPS.map((g) => (
              <div key={g.title} className="rounded-lg border bg-muted/40 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{g.title}</p>
                <ul className="space-y-1 text-sm">
                  {g.items.map((i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-primary/60" />
                      {i}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="text-sm text-muted-foreground space-y-1.5">
            <p>
              An area you may not export on its own page is left out here too, and the README says so. Areas with nothing in
              them still get a file with just the column headings.
            </p>
            <p>
              Not included: uploaded files (photos, documents, certificate PDFs) and the emails sent. Certificates download per
              run on the Certificates page.
            </p>
          </div>
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
            <p>This file holds personal data and payment details. Every export is recorded. Store and share it with care.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
