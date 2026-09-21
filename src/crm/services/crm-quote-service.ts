/**
 * CRM quotes, rebuilt Sep 15, 2026 as SAVED, EDITABLE quotes (owner request,
 * with a Freshsales quote as the layout sample).
 *
 *  - A quote is a row (CrmQuote + CrmQuoteLine) with its own lines, currency,
 *    tax, title, dates, terms and notes. Its PDF is a CrmDealDocument (kind
 *    QUOTE), so it still lands in the Documents card and attaches in Email.
 *  - Editing keeps the number, re-renders the PDF, replaces the document's file
 *    and bumps `version` (an optimistic lock: two reps editing at once cannot
 *    silently overwrite each other).
 *  - Numbers are yearly per organisation (Q-2026-0003) from CrmQuoteSequence,
 *    an atomic upsert-increment. A number is minted before the PDF renders, so
 *    a failed save leaves a gap, never a duplicate (the certificate rule).
 *  - Lines no longer have to come from the Products card: the draft offers the
 *    deal's products, and a rep can add, edit or remove lines freely. A product
 *    price pre-fills only when it is already in the quote's currency; there is
 *    no conversion (owner decision).
 *  - Every figure is computed once (computeQuoteTotals) and stored; the PDF
 *    prints the stored figures.
 *
 * Deleting a quote archives the row and removes its PDF document; the route
 * unlinks the file, the deal-document convention.
 */
import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { deleteStoredFile, uploadFile } from "@/lib/storage";
import { UPLOAD_PREFIX, UPLOAD_SEGMENT } from "@/lib/upload-prefixes";
import { updateOrganizationSettings } from "@/lib/event-settings";
import { loadLocalLogo, toAddressLines } from "@/lib/pdf/document-layout";
import { diffFields, recordCrmActivity } from "@/crm/lib/crm-activity";
import { renderQuotePdf, type QuotePdfInput } from "@/crm/lib/quote-pdf";
import {
  DEFAULT_QUOTE_TERMS,
  DEFAULT_QUOTE_VALIDITY_DAYS,
  MAX_QUOTE_AMOUNT,
  addDaysToDateString,
  computeQuoteTotals,
  formatQuoteNumber,
  isQuoteCurrency,
  quoteYear,
  readCrmQuoteDefaults,
  todayInQuoteTimezone,
  type CrmQuoteDraft,
  type CrmQuoteRow,
  type QuoteInput,
} from "@/crm/lib/quote-rules";

export type QuoteFailCode =
  | "DEAL_NOT_FOUND"
  | "DEAL_ARCHIVED"
  | "QUOTE_NOT_FOUND"
  | "QUOTE_ARCHIVED"
  | "STALE_WRITE"
  | "QUOTE_TOTAL_TOO_LARGE"
  | "UNKNOWN";

export interface QuoteFail {
  ok: false;
  code: QuoteFailCode;
  message: string;
  meta?: Record<string, unknown>;
}

interface Actor {
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "agent" | "api";
}

const QUOTE_SELECT = {
  id: true,
  number: true,
  title: true,
  currency: true,
  quoteDate: true,
  validUntil: true,
  preparedFor: true,
  attention: true,
  preparedByName: true,
  taxRate: true,
  taxLabel: true,
  subtotal: true,
  taxAmount: true,
  total: true,
  terms: true,
  notes: true,
  version: true,
  documentId: true,
  createdAt: true,
  updatedAt: true,
  lines: {
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      productCode: true,
      name: true,
      description: true,
      quantity: true,
      unitPrice: true,
      amount: true,
      crmProductId: true,
    },
  },
} satisfies Prisma.CrmQuoteSelect;

type QuoteRecord = Prisma.CrmQuoteGetPayload<{ select: typeof QUOTE_SELECT }>;

/** Raised inside the edit transaction when the version claim loses, so the whole write rolls back. */
class StaleQuoteError extends Error {}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dateFromString(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function toQuoteRow(q: QuoteRecord): CrmQuoteRow {
  return {
    id: q.id,
    number: q.number,
    title: q.title,
    currency: q.currency,
    quoteDate: dateOnly(q.quoteDate),
    validUntil: dateOnly(q.validUntil),
    preparedFor: q.preparedFor,
    attention: q.attention,
    preparedByName: q.preparedByName,
    taxRate: q.taxRate === null ? null : Number(q.taxRate),
    taxLabel: q.taxLabel,
    subtotal: Number(q.subtotal),
    taxAmount: Number(q.taxAmount),
    total: Number(q.total),
    terms: q.terms,
    notes: q.notes,
    version: q.version,
    documentId: q.documentId,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
    lines: q.lines.map((l) => ({
      id: l.id,
      productCode: l.productCode,
      name: l.name,
      description: l.description,
      quantity: l.quantity,
      unitPrice: Number(l.unitPrice),
      amount: Number(l.amount),
      crmProductId: l.crmProductId,
    })),
  };
}

// ── Deal context ──────────────────────────────────────────────────────────────

async function loadDealContext(organizationId: string, dealId: string) {
  return db.crmDeal.findFirst({
    where: { id: dealId, organizationId },
    select: {
      id: true,
      name: true,
      archivedAt: true,
      currency: true,
      company: { select: { name: true, city: true, country: true } },
      event: { select: { name: true, code: true, taxRate: true, taxLabel: true } },
      products: {
        orderBy: { createdAt: "asc" },
        select: { productName: true, sku: true, unitPrice: true, currency: true, quantity: true, crmProductId: true },
      },
      contacts: {
        where: { role: "PRIMARY", crmContact: { archivedAt: null } },
        take: 1,
        select: { crmContact: { select: { firstName: true, lastName: true } } },
      },
      org: {
        select: {
          name: true,
          logo: true,
          companyName: true,
          companyAddress: true,
          companyCity: true,
          companyState: true,
          companyZipCode: true,
          companyCountry: true,
          taxId: true,
          settings: true,
        },
      },
    },
  });
}

type DealContext = NonNullable<Awaited<ReturnType<typeof loadDealContext>>>;

async function openDeal(organizationId: string, dealId: string): Promise<{ ok: true; deal: DealContext } | QuoteFail> {
  const deal = await loadDealContext(organizationId, dealId);
  if (!deal) {
    apiLogger.warn({ msg: "crm-quote:deal-not-found", dealId, organizationId });
    return { ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" };
  }
  if (deal.archivedAt) {
    apiLogger.warn({ msg: "crm-quote:deal-archived", dealId, organizationId });
    return { ok: false, code: "DEAL_ARCHIVED", message: "This deal was archived. Restore it before quoting." };
  }
  return { ok: true, deal };
}

async function actorName(userId: string | null, fallback: string): Promise<string> {
  if (!userId) return fallback;
  const user = await db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
  const name = user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() : "";
  return name || fallback;
}

function companyName(deal: DealContext): string {
  return deal.org.companyName || deal.org.name;
}

// ── Draft ─────────────────────────────────────────────────────────────────────

export function buildQuoteDraft(deal: DealContext, preparedByName: string, now: Date): CrmQuoteDraft {
  const currency = isQuoteCurrency(deal.currency) ? deal.currency : "USD";
  const quoteDate = todayInQuoteTimezone(now);
  const forName = deal.company?.name ?? deal.name;
  const eventLabel = deal.event?.code || deal.event?.name || null;
  const primary = deal.contacts[0]?.crmContact ?? null;
  // Saved-empty default terms mean none; only an org that never saved any gets
  // the built-in wording (owner decision, Sep 15 2026).
  const defaults = readCrmQuoteDefaults(deal.org.settings);

  return {
    title: eventLabel ? `${forName} Quote - ${eventLabel}` : `${forName} Quote`,
    currency,
    quoteDate,
    validUntil: addDaysToDateString(quoteDate, DEFAULT_QUOTE_VALIDITY_DAYS),
    preparedFor: forName,
    attention: primary ? `${primary.firstName} ${primary.lastName}`.trim() || null : null,
    preparedByName,
    taxRate: deal.event?.taxRate != null ? Number(deal.event.taxRate) : null,
    taxLabel: deal.event?.taxLabel || "VAT",
    terms: defaults.configured ? defaults.terms : DEFAULT_QUOTE_TERMS,
    notes: null,
    eventName: deal.event?.name ?? null,
    lines: deal.products.map((p) => ({
      productCode: p.sku ?? null,
      name: p.productName,
      description: null,
      quantity: p.quantity,
      // No conversion: a price in another currency is left for the rep to type.
      unitPrice: p.currency === currency ? Number(p.unitPrice) : null,
      productCurrency: p.currency,
      cataloguePrice: Number(p.unitPrice),
      crmProductId: p.crmProductId ?? null,
    })),
  };
}

export async function getDealQuoteDraft(args: {
  organizationId: string;
  userId: string | null;
  dealId: string;
}): Promise<{ ok: true; draft: CrmQuoteDraft } | QuoteFail> {
  try {
    const opened = await openDeal(args.organizationId, args.dealId);
    if (!opened.ok) return opened;
    const preparedByName = await actorName(args.userId, companyName(opened.deal));
    return { ok: true, draft: buildQuoteDraft(opened.deal, preparedByName, new Date()) };
  } catch (err) {
    apiLogger.error({
      msg: "crm-quote:draft-failed",
      dealId: args.dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not prepare the quote" };
  }
}

// ── Shared write steps ────────────────────────────────────────────────────────

interface PreparedLine {
  sortOrder: number;
  productCode: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unitPrice: number;
  amount: number;
  crmProductId: string | null;
}

async function prepareQuote(organizationId: string, input: QuoteInput) {
  const totals = computeQuoteTotals(input.lines, input.taxRate);

  // A product link must point at THIS org's catalogue. A foreign or deleted id is
  // dropped to null rather than refusing the save: the line text is what prints.
  const requested = [...new Set(input.lines.map((l) => l.crmProductId).filter((id): id is string => !!id))];
  const owned =
    requested.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db.crmProduct.findMany({
              where: { id: { in: requested }, organizationId },
              select: { id: true },
            })
          ).map((p) => p.id),
        );

  const lines: PreparedLine[] = input.lines.map((l, i) => ({
    sortOrder: i,
    productCode: trimOrNull(l.productCode),
    name: l.name.trim(),
    description: trimOrNull(l.description),
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    amount: totals.amounts[i]!,
    crmProductId: l.crmProductId && owned.has(l.crmProductId) ? l.crmProductId : null,
  }));

  const tooLarge = totals.total > MAX_QUOTE_AMOUNT || lines.some((l) => l.amount > MAX_QUOTE_AMOUNT);
  return { totals, lines, tooLarge };
}

function tooLargeFail(organizationId: string, dealId: string): QuoteFail {
  apiLogger.warn({ msg: "crm-quote:total-too-large", organizationId, dealId });
  return {
    ok: false,
    code: "QUOTE_TOTAL_TOO_LARGE",
    message: "The quote total is larger than the system can store. Split it into smaller quotes.",
  };
}

function pdfInputFor(
  deal: DealContext,
  logoBuffer: Buffer | null,
  quote: {
    number: string;
    input: QuoteInput;
    preparedByName: string;
    lines: PreparedLine[];
    totals: ReturnType<typeof computeQuoteTotals>;
  },
  now: Date,
): QuotePdfInput {
  const org = deal.org;
  return {
    company: {
      name: companyName(deal),
      addressLines: toAddressLines(
        org.companyAddress,
        [org.companyCity, org.companyState, org.companyZipCode].filter(Boolean).join(" "),
        org.companyCountry,
      ),
      taxId: org.taxId,
      logoBuffer,
    },
    number: quote.number,
    title: quote.input.title.trim(),
    currency: quote.input.currency,
    quoteDate: quote.input.quoteDate,
    validUntil: quote.input.validUntil,
    preparedByName: quote.preparedByName,
    preparedFor: quote.input.preparedFor.trim(),
    attention: trimOrNull(quote.input.attention),
    locationLine: [deal.company?.city, deal.company?.country].filter(Boolean).join(", ") || null,
    eventName: deal.event?.name ?? null,
    lines: quote.lines,
    subtotal: quote.totals.subtotal,
    taxRate: quote.totals.taxRate,
    taxLabel: quote.input.taxLabel?.trim() || "VAT",
    taxAmount: quote.totals.taxAmount,
    total: quote.totals.total,
    terms: trimOrNull(quote.input.terms),
    notes: trimOrNull(quote.input.notes),
    generatedAt: now,
  };
}

function quoteFields(input: QuoteInput, totals: ReturnType<typeof computeQuoteTotals>) {
  return {
    title: input.title.trim(),
    currency: input.currency,
    quoteDate: dateFromString(input.quoteDate),
    validUntil: dateFromString(input.validUntil),
    preparedFor: input.preparedFor.trim(),
    attention: trimOrNull(input.attention),
    taxRate: totals.taxRate,
    taxLabel: input.taxLabel?.trim() || "VAT",
    subtotal: totals.subtotal,
    taxAmount: totals.taxAmount,
    total: totals.total,
    terms: trimOrNull(input.terms),
    notes: trimOrNull(input.notes),
  };
}

/** Failure-isolated: the quote is already saved, so a settings write must never undo it. */
async function saveDefaultTerms(organizationId: string, userId: string | null, terms: string | null | undefined) {
  try {
    await updateOrganizationSettings(organizationId, (current) => {
      const existing = current.crmQuote;
      const block =
        existing && typeof existing === "object" && !Array.isArray(existing)
          ? (existing as Record<string, unknown>)
          : {};
      return { ...current, crmQuote: { ...block, terms: trimOrNull(terms) } };
    });
    apiLogger.info({ msg: "crm-quote:default-terms-saved", organizationId, userId });
  } catch (err) {
    apiLogger.error({
      msg: "crm-quote:default-terms-save-failed",
      organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createDealQuote(
  args: Actor & { dealId: string; input: QuoteInput; saveTermsAsDefault?: boolean },
): Promise<{ ok: true; quote: CrmQuoteRow } | QuoteFail> {
  let pendingUrl: string | null = null;
  try {
    const opened = await openDeal(args.organizationId, args.dealId);
    if (!opened.ok) return opened;
    const { deal } = opened;

    const prepared = await prepareQuote(args.organizationId, args.input);
    if (prepared.tooLarge) return tooLargeFail(args.organizationId, deal.id);

    const now = new Date();
    const preparedByName = await actorName(args.userId, companyName(deal));
    const year = quoteYear(now);

    const sequence = await tenantTransaction(async (tx) => {
      const row = await tx.crmQuoteSequence.upsert({
        where: { organizationId_year: { organizationId: args.organizationId, year } },
        create: { organizationId: args.organizationId, year, lastNumber: 1 },
        update: { lastNumber: { increment: 1 } },
        select: { lastNumber: true },
      });
      return row.lastNumber;
    });
    const number = formatQuoteNumber(year, sequence);

    const logoBuffer = await loadLocalLogo(deal.org.logo);
    const pdf = await renderQuotePdf(
      pdfInputFor(deal, logoBuffer, { number, input: args.input, preparedByName, lines: prepared.lines, totals: prepared.totals }, now),
    );

    pendingUrl = await uploadFile(pdf, `quote-${randomUUID()}.pdf`, "application/pdf", `${UPLOAD_SEGMENT.crmDealDocs}/${deal.id}`);
    const url = pendingUrl;

    const quote = await tenantTransaction(async (tx) => {
      const document = await tx.crmDealDocument.create({
        data: {
          organizationId: args.organizationId,
          dealId: deal.id,
          kind: "QUOTE",
          url,
          filename: `${number}.pdf`,
          label: `Quote ${number}`,
          mimeType: "application/pdf",
          size: pdf.length,
          uploadedById: args.userId,
        },
        select: { id: true },
      });
      return tx.crmQuote.create({
        data: {
          organizationId: args.organizationId,
          dealId: deal.id,
          number,
          year,
          sequence,
          ...quoteFields(args.input, prepared.totals),
          preparedById: args.userId,
          preparedByName,
          documentId: document.id,
          lines: { create: prepared.lines.map((l) => ({ ...l, organizationId: args.organizationId })) },
        },
        select: QUOTE_SELECT,
      });
    });
    pendingUrl = null; // the row owns the file now

    if (args.saveTermsAsDefault) await saveDefaultTerms(args.organizationId, args.userId, args.input.terms);

    void recordCrmActivity({
      organizationId: args.organizationId,
      entityType: "DEAL",
      entityId: deal.id,
      action: "QUOTE_GENERATED",
      actorId: args.userId,
      changes: {
        source: args.source,
        quoteNumber: number,
        currency: args.input.currency,
        // quoteTotal, never `total`: the key name is what the MEMBER redaction strips.
        quoteTotal: prepared.totals.total,
        lineCount: prepared.lines.length,
      },
    });

    apiLogger.info({
      msg: "crm-quote:created",
      dealId: deal.id,
      quoteNumber: number,
      currency: args.input.currency,
      lineCount: prepared.lines.length,
      source: args.source,
    });
    return { ok: true, quote: toQuoteRow(quote) };
  } catch (err) {
    if (pendingUrl) await deleteStoredFile(pendingUrl, UPLOAD_PREFIX.crmDealDocs);
    apiLogger.error({
      msg: "crm-quote:create-failed",
      dealId: args.dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not save the quote" };
  }
}

// ── Update ────────────────────────────────────────────────────────────────────

/**
 * The quote fields an edit diffs onto History. The total is diffed under
 * `quoteTotal` (see historyView) because redaction strips by key NAME, and a
 * bare `total` is not, and must not be, a financial key.
 */
const DIFF_KEYS = [
  "title",
  "currency",
  "quoteDate",
  "validUntil",
  "preparedFor",
  "attention",
  "taxRate",
  "quoteTotal",
] as const;

function historyView(row: CrmQuoteRow): Record<(typeof DIFF_KEYS)[number], unknown> {
  return {
    title: row.title,
    currency: row.currency,
    quoteDate: row.quoteDate,
    validUntil: row.validUntil,
    preparedFor: row.preparedFor,
    attention: row.attention,
    taxRate: row.taxRate,
    quoteTotal: row.total,
  };
}

export async function updateDealQuote(
  args: Actor & {
    dealId: string;
    quoteId: string;
    expectedVersion: number;
    input: QuoteInput;
    saveTermsAsDefault?: boolean;
  },
): Promise<{ ok: true; quote: CrmQuoteRow } | QuoteFail> {
  let pendingUrl: string | null = null;
  try {
    const existing = await db.crmQuote.findFirst({
      where: { id: args.quoteId, dealId: args.dealId, organizationId: args.organizationId },
      select: { ...QUOTE_SELECT, archivedAt: true, document: { select: { id: true, url: true } } },
    });
    if (!existing) {
      apiLogger.warn({ msg: "crm-quote:update-not-found", quoteId: args.quoteId, dealId: args.dealId, organizationId: args.organizationId });
      return { ok: false, code: "QUOTE_NOT_FOUND", message: "Quote not found" };
    }
    if (existing.archivedAt) {
      apiLogger.warn({ msg: "crm-quote:update-archived", quoteId: args.quoteId });
      return { ok: false, code: "QUOTE_ARCHIVED", message: "This quote was deleted" };
    }
    if (existing.version !== args.expectedVersion) {
      apiLogger.warn({ msg: "crm-quote:stale-write", quoteId: args.quoteId, expected: args.expectedVersion, current: existing.version });
      return {
        ok: false,
        code: "STALE_WRITE",
        message: "Someone else changed this quote. Open it again to see the latest version.",
        meta: { currentVersion: existing.version },
      };
    }

    const opened = await openDeal(args.organizationId, args.dealId);
    if (!opened.ok) return opened;
    const { deal } = opened;

    const prepared = await prepareQuote(args.organizationId, args.input);
    if (prepared.tooLarge) return tooLargeFail(args.organizationId, deal.id);

    const now = new Date();
    const logoBuffer = await loadLocalLogo(deal.org.logo);
    // The original preparer stays on the paper; the History row records who edited.
    const pdf = await renderQuotePdf(
      pdfInputFor(
        deal,
        logoBuffer,
        { number: existing.number, input: args.input, preparedByName: existing.preparedByName, lines: prepared.lines, totals: prepared.totals },
        now,
      ),
    );

    pendingUrl = await uploadFile(pdf, `quote-${randomUUID()}.pdf`, "application/pdf", `${UPLOAD_SEGMENT.crmDealDocs}/${deal.id}`);
    const url = pendingUrl;

    const updated = await tenantTransaction(async (tx) => {
      const claim = await tx.crmQuote.updateMany({
        where: {
          id: args.quoteId,
          organizationId: args.organizationId,
          version: args.expectedVersion,
          archivedAt: null,
        },
        data: { ...quoteFields(args.input, prepared.totals), version: { increment: 1 } },
      });
      if (claim.count === 0) throw new StaleQuoteError();

      await tx.crmQuoteLine.deleteMany({ where: { quoteId: args.quoteId, organizationId: args.organizationId } });
      await tx.crmQuoteLine.createMany({
        data: prepared.lines.map((l) => ({ ...l, organizationId: args.organizationId, quoteId: args.quoteId })),
      });

      // Repoint the quote's document row at the new file. When that row is gone
      // (the PDF was removed from the deal meanwhile), mint a new one rather than
      // commit a quote whose new PDF nothing references (review L2).
      const repointed = existing.document
        ? await tx.crmDealDocument.updateMany({
            where: { id: existing.document.id, organizationId: args.organizationId },
            data: { url, size: pdf.length },
          })
        : { count: 0 };
      if (repointed.count === 0) {
        const document = await tx.crmDealDocument.create({
          data: {
            organizationId: args.organizationId,
            dealId: deal.id,
            kind: "QUOTE",
            url,
            filename: `${existing.number}.pdf`,
            label: `Quote ${existing.number}`,
            mimeType: "application/pdf",
            size: pdf.length,
            uploadedById: args.userId,
          },
          select: { id: true },
        });
        await tx.crmQuote.updateMany({
          where: { id: args.quoteId, organizationId: args.organizationId },
          data: { documentId: document.id },
        });
      }

      return tx.crmQuote.findFirstOrThrow({
        where: { id: args.quoteId, organizationId: args.organizationId },
        select: QUOTE_SELECT,
      });
    });
    pendingUrl = null;

    // The new file is live; the old one is now unreferenced.
    if (existing.document) await deleteStoredFile(existing.document.url, UPLOAD_PREFIX.crmDealDocs);

    if (args.saveTermsAsDefault) await saveDefaultTerms(args.organizationId, args.userId, args.input.terms);

    const before = toQuoteRow(existing);
    const after = toQuoteRow(updated);
    const changes = diffFields(historyView(before), historyView(after), DIFF_KEYS);

    void recordCrmActivity({
      organizationId: args.organizationId,
      entityType: "DEAL",
      entityId: deal.id,
      action: "QUOTE_UPDATED",
      actorId: args.userId,
      changes: {
        source: args.source,
        quoteNumber: existing.number,
        ...(changes ? { changes } : {}),
        ...(before.lines.length !== after.lines.length ? { lineCount: { from: before.lines.length, to: after.lines.length } } : {}),
        ...((before.terms ?? "") !== (after.terms ?? "") ? { termsChanged: true } : {}),
      },
    });

    apiLogger.info({ msg: "crm-quote:updated", quoteId: args.quoteId, quoteNumber: existing.number, version: after.version, source: args.source });
    return { ok: true, quote: after };
  } catch (err) {
    if (pendingUrl) await deleteStoredFile(pendingUrl, UPLOAD_PREFIX.crmDealDocs);
    if (err instanceof StaleQuoteError) {
      apiLogger.warn({ msg: "crm-quote:stale-write-race", quoteId: args.quoteId, expected: args.expectedVersion });
      return {
        ok: false,
        code: "STALE_WRITE",
        message: "Someone else changed this quote. Open it again to see the latest version.",
      };
    }
    apiLogger.error({
      msg: "crm-quote:update-failed",
      quoteId: args.quoteId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not update the quote" };
  }
}

// ── List + archive ────────────────────────────────────────────────────────────

export async function listDealQuotes(args: {
  organizationId: string;
  dealId: string;
}): Promise<{ ok: true; quotes: CrmQuoteRow[] } | QuoteFail> {
  try {
    const deal = await db.crmDeal.findFirst({
      where: { id: args.dealId, organizationId: args.organizationId },
      select: { id: true },
    });
    if (!deal) {
      apiLogger.warn({ msg: "crm-quote:list-deal-not-found", dealId: args.dealId, organizationId: args.organizationId });
      return { ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" };
    }
    const quotes = await db.crmQuote.findMany({
      where: { dealId: args.dealId, organizationId: args.organizationId, archivedAt: null },
      orderBy: { createdAt: "desc" },
      select: QUOTE_SELECT,
    });
    return { ok: true, quotes: quotes.map(toQuoteRow) };
  } catch (err) {
    apiLogger.error({
      msg: "crm-quote:list-failed",
      dealId: args.dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not load the quotes" };
  }
}

export async function archiveDealQuote(
  args: Actor & { dealId: string; quoteId: string },
): Promise<{ ok: true; removedUrl: string | null } | QuoteFail> {
  try {
    const existing = await db.crmQuote.findFirst({
      where: { id: args.quoteId, dealId: args.dealId, organizationId: args.organizationId },
      select: { id: true, number: true, archivedAt: true },
    });
    if (!existing) {
      apiLogger.warn({ msg: "crm-quote:archive-not-found", quoteId: args.quoteId, dealId: args.dealId, organizationId: args.organizationId });
      return { ok: false, code: "QUOTE_NOT_FOUND", message: "Quote not found" };
    }
    if (existing.archivedAt) return { ok: true, removedUrl: null };

    const outcome = await tenantTransaction(async (tx) => {
      const claim = await tx.crmQuote.updateMany({
        where: { id: args.quoteId, organizationId: args.organizationId, archivedAt: null },
        data: { archivedAt: new Date() },
      });
      if (claim.count === 0) return { claimed: false, removedUrl: null };

      // Read the document AFTER the claim, not before it: an edit that committed
      // first has already pointed it at its new file, and that is the file to
      // remove. The file read before the claim may be one the edit already deleted.
      const current = await tx.crmQuote.findFirst({
        where: { id: args.quoteId, organizationId: args.organizationId },
        select: { document: { select: { id: true, url: true } } },
      });
      const document = current?.document ?? null;
      if (!document) return { claimed: true, removedUrl: null };

      await tx.crmQuote.updateMany({
        where: { id: args.quoteId, organizationId: args.organizationId },
        data: { documentId: null },
      });
      await tx.crmDealDocument.deleteMany({ where: { id: document.id, organizationId: args.organizationId } });
      return { claimed: true, removedUrl: document.url };
    });

    // A concurrent delete won the claim and wrote the History row; this one did nothing.
    if (!outcome.claimed) {
      apiLogger.info({ msg: "crm-quote:archive-already-done", quoteId: args.quoteId });
      return { ok: true, removedUrl: null };
    }
    const removedUrl = outcome.removedUrl;

    void recordCrmActivity({
      organizationId: args.organizationId,
      entityType: "DEAL",
      entityId: args.dealId,
      action: "QUOTE_ARCHIVED",
      actorId: args.userId,
      changes: { source: args.source, quoteNumber: existing.number },
    });

    apiLogger.info({ msg: "crm-quote:archived", quoteId: args.quoteId, quoteNumber: existing.number, source: args.source });
    return { ok: true, removedUrl };
  } catch (err) {
    apiLogger.error({
      msg: "crm-quote:archive-failed",
      quoteId: args.quoteId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not delete the quote" };
  }
}
