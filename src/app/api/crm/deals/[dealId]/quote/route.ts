import { NextResponse } from "next/server";
import { z } from "zod";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { rateLimited, zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { canManageCrmQuoteDefaults, canViewDealValues } from "@/crm/lib/crm-visibility";
import { createDealQuote, getDealQuoteDraft } from "@/crm/services/crm-quote-service";
import {
  addDaysToDateString,
  quoteInputObject,
  quoteInputSchema,
  type CrmQuoteDraft,
  type QuoteInput,
} from "@/crm/lib/quote-rules";

interface RouteParams {
  params: Promise<{ dealId: string }>;
}

const CREATE_LIMIT = 30;
const CREATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Every field is optional on create: anything the caller leaves out comes from
 * the draft (the deal's company, products, event tax and the org's default
 * terms). That keeps a minimal API call working and lets a client still running
 * the pre-editor bundle (it sends only tax, validity and notes) keep generating
 * quotes through a deploy.
 */
const createBodySchema = quoteInputObject.partial().extend({
  saveTermsAsDefault: z.boolean().optional(),
  /** Pre-editor clients sent "valid for N days" instead of a date. */
  validityDays: z.number().int().min(1).max(365).optional(),
});

export function mergeQuoteInputWithDraft(
  draft: CrmQuoteDraft,
  provided: Partial<QuoteInput>,
  validityDays?: number,
): Record<string, unknown> {
  const quoteDate = provided.quoteDate ?? draft.quoteDate;
  const validUntil =
    provided.validUntil ?? (validityDays ? addDaysToDateString(quoteDate, validityDays) : draft.validUntil);
  return {
    title: provided.title ?? draft.title,
    currency: provided.currency ?? draft.currency,
    quoteDate,
    validUntil,
    preparedFor: provided.preparedFor ?? draft.preparedFor,
    attention: provided.attention !== undefined ? provided.attention : draft.attention,
    taxRate: provided.taxRate !== undefined ? provided.taxRate : draft.taxRate,
    taxLabel: provided.taxLabel ?? draft.taxLabel,
    terms: provided.terms !== undefined ? provided.terms : draft.terms,
    notes: provided.notes !== undefined ? provided.notes : draft.notes,
    // A draft line priced in another currency carries a null price, which the
    // full schema refuses: the caller is told to price it, never given a guess.
    lines:
      provided.lines ??
      draft.lines.map((l) => ({
        productCode: l.productCode,
        name: l.name,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        crmProductId: l.crmProductId,
      })),
  };
}

/**
 * GET /api/crm/deals/[dealId]/quote — the draft a new quote starts from, plus
 * whether this caller may save the terms as the organisation default. A quote
 * prints deal money, so a caller the deal-value redaction applies to is refused.
 */
export async function GET(req: Request, { params }: RouteParams) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmRead(req), params]);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    if (!canViewDealValues(ctx.role, ctx.fromApiKey)) {
      apiLogger.warn({ msg: "crm/quote:draft-forbidden", role: ctx.role, userId: ctx.userId, dealId });
      return NextResponse.json(
        { error: "Quotes are not available to your role", code: "QUOTE_FORBIDDEN" },
        { status: 403 },
      );
    }

    const result = await getDealQuoteDraft({ organizationId: ctx.organizationId, userId: ctx.userId, dealId });
    if (!result.ok) return crmErrorResponse(result);

    return NextResponse.json({
      draft: result.draft,
      canSaveDefaultTerms: canManageCrmQuoteDefaults(ctx.role, ctx.fromApiKey),
    });
  });
}

/**
 * POST /api/crm/deals/[dealId]/quote — save a new quote, render its PDF and
 * store it as a deal document (kind QUOTE).
 */
export async function POST(req: Request, { params }: RouteParams) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const limit = checkRateLimit({
      key: `crm-quote:org:${ctx.organizationId}`,
      limit: CREATE_LIMIT,
      windowMs: CREATE_WINDOW_MS,
    });
    if (!limit.allowed) {
      return rateLimited(limit, {
        route: "crm/deals/quote:POST",
        limit: CREATE_LIMIT,
        windowSeconds: CREATE_WINDOW_MS / 1000,
        organizationId: ctx.organizationId,
      });
    }

    const body = await req.json().catch(() => ({}));
    const parsed = createBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route: "crm/deals/quote:POST", organizationId: ctx.organizationId, dealId });
    }
    const { saveTermsAsDefault, validityDays, ...provided } = parsed.data;

    if (saveTermsAsDefault && !canManageCrmQuoteDefaults(ctx.role, ctx.fromApiKey)) {
      apiLogger.warn({ msg: "crm/quote:default-terms-forbidden", role: ctx.role, userId: ctx.userId, dealId });
      return NextResponse.json(
        { error: "Only an admin can change the default quote terms", code: "DEFAULT_TERMS_FORBIDDEN" },
        { status: 403 },
      );
    }

    const draft = await getDealQuoteDraft({ organizationId: ctx.organizationId, userId: ctx.userId, dealId });
    if (!draft.ok) return crmErrorResponse(draft);

    const full = quoteInputSchema.safeParse(mergeQuoteInputWithDraft(draft.draft, provided, validityDays));
    if (!full.success) {
      return zodErrorResponse(full, { route: "crm/deals/quote:POST", organizationId: ctx.organizationId, dealId });
    }

    const result = await createDealQuote({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      source: ctx.fromApiKey ? "api" : "rest",
      dealId,
      input: full.data,
      saveTermsAsDefault,
    });
    if (!result.ok) return crmErrorResponse(result);

    return NextResponse.json({ quote: result.quote, quoteNumber: result.quote.number }, { status: 201 });
  });
}
