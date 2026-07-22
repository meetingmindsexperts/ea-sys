/**
 * CRM quotes — a numbered quote PDF generated from a deal's PRODUCT line items
 * (owner decisions, July 22 2026):
 *
 *  - Lines come from the deal's Products card (qty × unit price) — no products,
 *    no quote. All lines must share ONE currency (the never-sum-across rule):
 *    a mixed-currency deal is refused, not fudged.
 *  - Every generation mints an org-sequential number (Q-0001…, atomic
 *    upsert+increment on CrmQuoteCounter) and is SAVED as a deal document
 *    (kind QUOTE) — it shows in the Documents card, attaches in the Email
 *    dialog, and re-generating keeps history rather than replacing.
 *  - Tax is an optional per-generation rate/label (pre-filled from the linked
 *    event's taxRate in the dialog).
 *
 * Renders through the CORE pdf layout engine (crm→core is allowed) — the same
 * header/bill-to/line-items/totals the event quotes and invoices use, so CRM
 * quotes look like the rest of the company's paper.
 */
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import PDFDocument from "pdfkit";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordCrmActivity } from "@/crm/lib/crm-activity";
import { DEAL_DOCUMENT_SELECT } from "@/crm/services/deal-document-service";
import {
  PAGE_MARGIN,
  drawFooters,
  drawHeader,
  drawInfoBoxes,
  drawLineItemsTable,
  drawNotesAndDisclaimer,
  drawTotals,
  ensureSpace,
  formatDateShort,
  loadLocalLogo,
  type LineItemCategory,
} from "@/lib/pdf/document-layout";

type Fail = {
  ok: false;
  code: "DEAL_NOT_FOUND" | "DEAL_ARCHIVED" | "NO_PRODUCTS" | "MIXED_CURRENCIES" | "UNKNOWN";
  message: string;
  meta?: Record<string, unknown>;
};

export interface GenerateDealQuoteInput {
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
  dealId: string;
  /** Optional tax line — rate in %, label like "VAT". */
  taxRate?: number | null;
  taxLabel?: string;
  /** "Valid for N days" printed in the notes. */
  validityDays: number;
  notes?: string | null;
}

function quoteNumber(n: number): string {
  return `Q-${String(n).padStart(4, "0")}`;
}

export async function generateDealQuote(
  input: GenerateDealQuoteInput,
): Promise<{ ok: true; document: Record<string, unknown> & { id: string }; quoteNumber: string } | Fail> {
  try {
    const deal = await db.crmDeal.findFirst({
      where: { id: input.dealId, organizationId: input.organizationId },
      select: {
        id: true,
        name: true,
        archivedAt: true,
        company: { select: { name: true, city: true, country: true } },
        event: { select: { name: true } },
        products: {
          orderBy: { createdAt: "asc" },
          select: { productName: true, category: true, unitPrice: true, currency: true, quantity: true },
        },
        contacts: {
          where: { role: "PRIMARY" },
          take: 1,
          select: { crmContact: { select: { firstName: true, lastName: true } } },
        },
        org: {
          select: {
            name: true, logo: true, companyName: true, companyAddress: true, companyCity: true,
            companyState: true, companyZipCode: true, companyCountry: true, taxId: true,
          },
        },
      },
    });
    if (!deal) {
      apiLogger.warn({ msg: "crm-quote:deal-not-found", dealId: input.dealId, organizationId: input.organizationId });
      return { ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" };
    }
    if (deal.archivedAt) {
      apiLogger.warn({ msg: "crm-quote:deal-archived", dealId: input.dealId });
      return { ok: false, code: "DEAL_ARCHIVED", message: "This deal was archived — restore it before quoting" };
    }
    if (deal.products.length === 0) {
      apiLogger.warn({ msg: "crm-quote:no-products", dealId: input.dealId });
      return {
        ok: false,
        code: "NO_PRODUCTS",
        message: "Add products to the deal first — the quote's line items come from the Products card",
      };
    }
    const currencies = [...new Set(deal.products.map((p) => p.currency))];
    if (currencies.length > 1) {
      // Adding AED to USD and stamping one symbol on it is a fabricated number
      // (the H2 rule everywhere money is summed in this module).
      apiLogger.warn({ msg: "crm-quote:mixed-currencies", dealId: input.dealId, currencies });
      return {
        ok: false,
        code: "MIXED_CURRENCIES",
        message: `The deal's products span ${currencies.join(" + ")} — a quote must be in one currency`,
        meta: { currencies },
      };
    }
    const currency = currencies[0]!;

    // ── Mint the org-sequential number (atomic — two reps can't collide) ────
    const counter = await db.$transaction(async (tx) => {
      await tx.crmQuoteCounter.upsert({
        where: { organizationId: input.organizationId },
        create: { organizationId: input.organizationId, lastNumber: 1 },
        update: { lastNumber: { increment: 1 } },
      });
      return tx.crmQuoteCounter.findUniqueOrThrow({
        where: { organizationId: input.organizationId },
        select: { lastNumber: true },
      });
    });
    const number = quoteNumber(counter.lastNumber);

    // ── Compute + render ────────────────────────────────────────────────────
    const lines = deal.products.map((p) => ({
      name: p.productName,
      category: p.category || "Services",
      quantity: p.quantity,
      unitPrice: Number(p.unitPrice),
      amount: Number(p.unitPrice) * p.quantity,
    }));
    const subtotal = lines.reduce((s, l) => s + l.amount, 0);

    const now = new Date();
    const validUntil = new Date(now.getTime() + input.validityDays * 24 * 60 * 60 * 1000);
    const primary = deal.contacts[0]?.crmContact ?? null;

    const categories: LineItemCategory[] = [];
    for (const line of lines) {
      let cat = categories.find((c) => c.name === line.category);
      if (!cat) {
        cat = { name: line.category, items: [] };
        categories.push(cat);
      }
      cat.items.push({
        description:
          line.quantity > 1 ? `${line.name} — ${line.quantity} × ${line.unitPrice.toFixed(2)}` : line.name,
        amount: line.amount,
      });
    }

    const org = deal.org;
    const logoBuffer = await loadLocalLogo(org.logo);
    const taxRate = input.taxRate && input.taxRate > 0 ? input.taxRate : null;

    const pdf = await new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
        const chunks: Buffer[] = [];
        doc.on("data", (c: Buffer) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));

        let y = drawHeader(doc, {
          companyBlock: {
            companyName: org.companyName || org.name,
            addressLines: [
              org.companyAddress,
              [org.companyCity, org.companyState, org.companyZipCode].filter(Boolean).join(" "),
              org.companyCountry,
            ].filter((l): l is string => !!l && l.trim() !== ""),
            taxId: org.taxId,
          },
          centerTitle: deal.event?.name ?? deal.name,
          documentTitle: "QUOTE",
          logoBuffer,
        });

        y = drawInfoBoxes(doc, y, {
          billTo: {
            nameLine: deal.company?.name ?? deal.name,
            secondLine: primary ? `Attn: ${primary.firstName} ${primary.lastName}` : null,
            locationLine:
              [deal.company?.city, deal.company?.country].filter(Boolean).join(", ") || null,
          },
          meta: [
            { label: "Quote #", value: number },
            { label: "Date", value: formatDateShort(now) },
            { label: "Valid until", value: formatDateShort(validUntil) },
            ...(deal.event ? [{ label: "Event", value: deal.event.name }] : []),
          ],
        });

        y = drawLineItemsTable(doc, y, currency, categories);

        y = drawTotals(doc, y, {
          currency,
          subtotal,
          discountAmount: 0,
          discountLabel: null,
          taxRate,
          taxLabel: input.taxLabel || "VAT",
          totalLabel: "TOTAL",
        });

        const notes = [
          `This quotation is valid until ${formatDateShort(validUntil)} (${input.validityDays} days).`,
          ...(input.notes?.trim() ? [input.notes.trim()] : []),
        ];
        y = ensureSpace(doc, y, 120);
        drawNotesAndDisclaimer(doc, y, notes, !!taxRate);

        drawFooters(doc, now);
        doc.end();
      } catch (err) {
        reject(err);
      }
    });

    // ── Store as a deal document (kind QUOTE — history kept, never replaced) ─
    const dirRel = path.join("uploads", "crm-deal-docs", deal.id);
    const dirAbs = path.resolve(process.cwd(), "public", dirRel);
    await fs.mkdir(dirAbs, { recursive: true });
    const storedName = `quote-${randomUUID()}.pdf`;
    await fs.writeFile(path.join(dirAbs, storedName), pdf);
    const url = `/${dirRel.split(path.sep).join("/")}/${storedName}`;

    let document: Record<string, unknown> & { id: string };
    try {
      document = await db.crmDealDocument.create({
        data: {
          organizationId: input.organizationId,
          dealId: deal.id,
          kind: "QUOTE",
          url,
          filename: `${number}.pdf`,
          label: `Quote ${number}`,
          mimeType: "application/pdf",
          size: pdf.length,
          uploadedById: input.userId,
        },
        select: DEAL_DOCUMENT_SELECT,
      });
    } catch (err) {
      // The row never landed — don't leave the just-written file orphaned.
      await fs.unlink(path.join(dirAbs, storedName)).catch(() => undefined);
      throw err;
    }

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "DEAL",
      entityId: deal.id,
      action: "QUOTE_GENERATED",
      actorId: input.userId,
      changes: {
        source: input.source,
        quoteNumber: number,
        currency,
        lineCount: lines.length,
        ...(taxRate ? { taxRate } : {}),
      },
    });

    apiLogger.info({
      msg: "crm-quote:generated",
      dealId: deal.id,
      quoteNumber: number,
      currency,
      lineCount: lines.length,
      source: input.source,
    });
    return { ok: true, document, quoteNumber: number };
  } catch (err) {
    apiLogger.error({
      msg: "crm-quote:generate-failed",
      dealId: input.dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not generate the quote" };
  }
}
