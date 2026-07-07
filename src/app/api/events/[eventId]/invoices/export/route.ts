import { NextResponse } from "next/server";
import JSZip from "jszip";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { denyFinance } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { generatePDFForInvoice } from "@/lib/invoice-service";
import {
  INVOICE_EXPORT_SELECT,
  buildInvoiceCsv,
  buildInvoiceQuickBooksCsv,
  type InvoiceExportRow,
} from "@/lib/invoice-export";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

// Generating PDFs is CPU-bound (pdfkit) + sequential, so bound the batch to
// keep the request well under proxy timeouts. If a finance user needs more
// than this in one file they narrow the filter (or export in chunks).
const MAX_EXPORT = 300;

/**
 * GET /api/events/[eventId]/invoices/export?type=&status=
 * Bundle every matching invoice PDF into a single ZIP (finance-only).
 * Honors the same type/status filters as the invoices list — e.g.
 * `?status=PAID` downloads all paid invoices at once.
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const noFinance = denyFinance(session);
    if (noFinance) return noFinance;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, code: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const url = new URL(req.url);
    // Backward-compat: no `format` → the original ZIP-of-PDFs behavior.
    const format = (url.searchParams.get("format") || "pdf").toLowerCase();
    const type = url.searchParams.get("type") || undefined;
    const status = url.searchParams.get("status") || undefined;

    const where: Prisma.InvoiceWhereInput = {
      eventId,
      ...(type && { type: type as "INVOICE" | "RECEIPT" | "CREDIT_NOTE" }),
      ...(status && {
        status: status as "DRAFT" | "SENT" | "PAID" | "OVERDUE" | "CANCELLED" | "REFUNDED",
      }),
    };

    // CSV / QuickBooks — shared formatters, byte-identical to the org-level
    // export. Honor the same type/status filters as the PDF ZIP.
    if (format === "csv" || format === "quickbooks") {
      const invoices = (await db.invoice.findMany({
        where,
        select: INVOICE_EXPORT_SELECT,
        orderBy: { issueDate: "desc" },
        take: 10000,
      })) as unknown as InvoiceExportRow[];
      const csv = format === "quickbooks" ? buildInvoiceQuickBooksCsv(invoices) : buildInvoiceCsv(invoices);
      const name = format === "quickbooks" ? "invoices-quickbooks" : "invoices";
      const stamp = new Date().toISOString().slice(0, 10);
      apiLogger.info({ msg: `invoices:export-${format}`, eventId, count: invoices.length });
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${name}-${event.code || eventId}-${stamp}.csv"`,
        },
      });
    }

    const count = await db.invoice.count({ where });
    if (count === 0) {
      return NextResponse.json({ error: "No invoices match the current filter." }, { status: 404 });
    }
    if (count > MAX_EXPORT) {
      apiLogger.warn({ msg: "invoices:export-too-large", eventId, count, type, status });
      return NextResponse.json(
        {
          error: `Too many invoices to export at once (${count}). Narrow the filter — max ${MAX_EXPORT} per export.`,
          code: "EXPORT_TOO_LARGE",
        },
        { status: 400 },
      );
    }

    const invoices = await db.invoice.findMany({
      where,
      select: { id: true, invoiceNumber: true },
      orderBy: { createdAt: "desc" },
    });

    const zip = new JSZip();
    const usedNames = new Set<string>();
    let ok = 0;
    let failed = 0;

    for (const inv of invoices) {
      try {
        const buf = await generatePDFForInvoice(inv.id);
        // Sanitize + dedupe the entry name (invoice numbers are unique, but
        // guard against separators / collisions defensively).
        const base = `${inv.invoiceNumber}`.replace(/[/\\]/g, "-");
        let name = `${base}.pdf`;
        let n = 1;
        while (usedNames.has(name)) name = `${base}-${n++}.pdf`;
        usedNames.add(name);
        zip.file(name, buf);
        ok++;
      } catch (err) {
        failed++;
        apiLogger.warn({ msg: "invoices:export-pdf-failed", eventId, invoiceId: inv.id, err });
      }
    }

    if (ok === 0) {
      return NextResponse.json({ error: "Failed to generate any invoice PDFs." }, { status: 500 });
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    apiLogger.info({ msg: "invoices:export", eventId, count, ok, failed, type, status });

    const label = (status || type || "all").toLowerCase();
    const filename = `invoices-${event.code || eventId}-${label}.zip`;

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, max-age=0",
      },
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error exporting invoices ZIP" });
    return NextResponse.json({ error: "Failed to export invoices" }, { status: 500 });
  }
}
