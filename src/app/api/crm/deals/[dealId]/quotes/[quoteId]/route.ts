import { NextResponse } from "next/server";
import { z } from "zod";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { rateLimited, zodErrorResponse } from "@/lib/api-errors";
import { deleteStoredFile } from "@/lib/storage";
import { UPLOAD_PREFIX } from "@/lib/upload-prefixes";
import { requireCrmDelete, requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { canManageCrmQuoteDefaults } from "@/crm/lib/crm-visibility";
import { archiveDealQuote, updateDealQuote } from "@/crm/services/crm-quote-service";
import { quoteInputObject } from "@/crm/lib/quote-rules";

interface RouteParams {
  params: Promise<{ dealId: string; quoteId: string }>;
}

const EDIT_LIMIT = 120;
const EDIT_WINDOW_MS = 60 * 60 * 1000;

/** An edit sends the whole quote plus the version it was loaded at (optimistic lock). */
const updateBodySchema = quoteInputObject
  .extend({
    expectedVersion: z.number().int().min(1),
    saveTermsAsDefault: z.boolean().optional(),
  })
  .refine((v) => v.validUntil >= v.quoteDate, {
    message: "Valid until must be on or after the quote date",
    path: ["validUntil"],
  });

/** PATCH /api/crm/deals/[dealId]/quotes/[quoteId] — edit a quote in place (same number, new PDF). */
export async function PATCH(req: Request, { params }: RouteParams) {
  const [{ error, ctx }, { dealId, quoteId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const limit = checkRateLimit({
      key: `crm-quote-edit:org:${ctx.organizationId}`,
      limit: EDIT_LIMIT,
      windowMs: EDIT_WINDOW_MS,
    });
    if (!limit.allowed) {
      return rateLimited(limit, {
        route: "crm/deals/quotes:PATCH",
        limit: EDIT_LIMIT,
        windowSeconds: EDIT_WINDOW_MS / 1000,
        organizationId: ctx.organizationId,
      });
    }

    const body = await req.json().catch(() => ({}));
    const parsed = updateBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route: "crm/deals/quotes:PATCH", organizationId: ctx.organizationId, dealId, quoteId });
    }
    const { expectedVersion, saveTermsAsDefault, ...input } = parsed.data;

    if (saveTermsAsDefault && !canManageCrmQuoteDefaults(ctx.role, ctx.fromApiKey)) {
      apiLogger.warn({ msg: "crm/quote:default-terms-forbidden", role: ctx.role, userId: ctx.userId, dealId, quoteId });
      return NextResponse.json(
        { error: "Only an admin can change the default quote terms", code: "DEFAULT_TERMS_FORBIDDEN" },
        { status: 403 },
      );
    }

    const result = await updateDealQuote({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      source: ctx.fromApiKey ? "api" : "rest",
      dealId,
      quoteId,
      expectedVersion,
      input,
      saveTermsAsDefault,
    });
    if (!result.ok) return crmErrorResponse(result);

    return NextResponse.json({ quote: result.quote });
  });
}

/**
 * DELETE /api/crm/deals/[dealId]/quotes/[quoteId] — archive the quote and remove
 * its PDF from the deal.
 *
 * Delete-gated (admin and CRM user), like archiving any other CRM record: an
 * ORGANIZER may edit a quote but not delete it (owner decision, Sep 15 2026).
 */
export async function DELETE(req: Request, { params }: RouteParams) {
  const [{ error, ctx }, { dealId, quoteId }] = await Promise.all([requireCrmDelete(req), params]);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const result = await archiveDealQuote({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      source: ctx.fromApiKey ? "api" : "rest",
      dealId,
      quoteId,
    });
    if (!result.ok) return crmErrorResponse(result);

    if (result.removedUrl) await deleteStoredFile(result.removedUrl, UPLOAD_PREFIX.crmDealDocs);

    return NextResponse.json({ archived: true });
  });
}
