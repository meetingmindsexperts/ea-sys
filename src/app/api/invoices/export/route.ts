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

/**
 * GET /api/invoices/export?format=csv|pdf|quickbooks & (same filters as the list)
 *
 * Org-wide invoice export, finance-gated + org-scoped, honoring the same
 * year/month/event/type/status filters as GET /api/invoices:
 *   - csv        → one row per invoice (metadata + amounts) for reconciliation
 *   - pdf        → every matching invoice PDF bundled into a single ZIP
 *   - quickbooks → CSV in the QuickBooks invoice-import template
 * CSV/QuickBooks formatting is shared with the per-event export via
 * src/lib/invoice-export.ts so the output is byte-identical at both levels.
 */
const MAX_CSV = 10000;
// PDF generation is CPU-bound (pdfkit) + sequential; bound the batch so the
// request stays under proxy timeouts. Narrow the filter for more.
const MAX_PDF = 300;

function csvResponse(csv: string, name: string): NextResponse {
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}-${stamp}.csv"`,
    },
  });
}

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const noFinance = denyFinance(session);
    if (noFinance) return noFinance;

    const organizationId = session.user.organizationId;
    if (!organizationId) {
      return NextResponse.json({ error: "No organization" }, { status: 403 });
    }

    const url = new URL(req.url);
    const format = (url.searchParams.get("format") || "csv").toLowerCase();
    const year = url.searchParams.get("year") ? Number(url.searchParams.get("year")) : undefined;
    const month = url.searchParams.get("month") ? Number(url.searchParams.get("month")) : undefined;
    const eventId = url.searchParams.get("eventId") || undefined;
    const type = url.searchParams.get("type") || undefined;
    const status = url.searchParams.get("status") || undefined;

    let issueDate: Prisma.DateTimeFilter | undefined;
    if (year && Number.isFinite(year)) {
      if (month && month >= 1 && month <= 12) {
        issueDate = { gte: new Date(Date.UTC(year, month - 1, 1)), lt: new Date(Date.UTC(year, month, 1)) };
      } else {
        issueDate = { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) };
      }
    }

    const where: Prisma.InvoiceWhereInput = {
      organizationId,
      ...(eventId && { eventId }),
      ...(type && { type: type as Prisma.EnumInvoiceTypeFilter["equals"] }),
      ...(status && { status: status as Prisma.EnumInvoiceStatusFilter["equals"] }),
      ...(issueDate && { issueDate }),
    };

    // ── PDF (ZIP of invoice PDFs) ──────────────────────────────────────────
    if (format === "pdf") {
      const count = await db.invoice.count({ where });
      if (count === 0) {
        return NextResponse.json({ error: "No invoices match the current filter." }, { status: 404 });
      }
      if (count > MAX_PDF) {
        apiLogger.warn({ msg: "org-invoices:export-pdf-too-large", organizationId, count });
        return NextResponse.json(
          { error: `Too many invoices to bundle as PDF at once (${count}). Narrow the filter — max ${MAX_PDF}.`, code: "EXPORT_TOO_LARGE" },
          { status: 400 },
        );
      }
      const list = await db.invoice.findMany({ where, select: { id: true, invoiceNumber: true }, orderBy: { issueDate: "desc" } });
      const zip = new JSZip();
      const used = new Set<string>();
      let ok = 0, failed = 0;
      for (const inv of list) {
        try {
          const buf = await generatePDFForInvoice(inv.id);
          const base = `${inv.invoiceNumber}`.replace(/[/\\]/g, "-");
          let name = `${base}.pdf`, n = 1;
          while (used.has(name)) name = `${base}-${n++}.pdf`;
          used.add(name);
          zip.file(name, buf);
          ok++;
        } catch (err) {
          failed++;
          apiLogger.warn({ msg: "org-invoices:export-pdf-failed", invoiceId: inv.id, err });
        }
      }
      if (ok === 0) return NextResponse.json({ error: "Failed to generate any invoice PDFs." }, { status: 500 });
      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      apiLogger.info({ msg: "org-invoices:export-pdf", organizationId, count, ok, failed });
      const stamp = new Date().toISOString().slice(0, 10);
      return new NextResponse(new Uint8Array(zipBuffer), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="invoices-${stamp}.zip"`,
          "Cache-Control": "private, max-age=0",
        },
      });
    }

    // ── CSV / QuickBooks (shared formatters) ───────────────────────────────
    const invoices = (await db.invoice.findMany({
      where,
      select: INVOICE_EXPORT_SELECT,
      orderBy: { issueDate: "desc" },
      take: MAX_CSV,
    })) as unknown as InvoiceExportRow[];

    if (format === "quickbooks") {
      apiLogger.info({ msg: "org-invoices:export-quickbooks", organizationId, count: invoices.length });
      return csvResponse(buildInvoiceQuickBooksCsv(invoices), "invoices-quickbooks");
    }
    apiLogger.info({ msg: "org-invoices:export-csv", organizationId, count: invoices.length });
    return csvResponse(buildInvoiceCsv(invoices), "invoices");
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error exporting organization invoices" });
    return NextResponse.json({ error: "Failed to export invoices" }, { status: 500 });
  }
}
