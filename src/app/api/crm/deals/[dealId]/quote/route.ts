import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { generateDealQuote } from "@/crm/services/crm-quote-service";

const bodySchema = z.object({
  /** Optional tax line — % on the subtotal, label like "VAT". */
  taxRate: z.number().min(0).max(100).nullable().optional(),
  taxLabel: z.string().max(30).optional(),
  /** "Valid for N days" — printed on the quote. */
  validityDays: z.number().int().min(1).max(365).default(30),
  notes: z.string().max(2000).nullable().optional(),
});

/**
 * POST /api/crm/deals/[dealId]/quote — generate a numbered quote PDF from the
 * deal's product line items and store it as a deal document (kind QUOTE), so
 * it lands in the Documents card and is tick-to-attach in the Email dialog.
 */
export async function POST(req: Request, { params }: { params: Promise<{ dealId: string }> }) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const limit = checkRateLimit({
    key: `crm-quote:org:${ctx.organizationId}`,
    limit: 30,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.allowed) {
    apiLogger.warn({ msg: "crm/quote:rate-limited", organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: "Too many quotes generated — try again shortly", code: "RATE_LIMITED", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/deals/quote:POST", organizationId: ctx.organizationId, dealId });
  }

  const result = await generateDealQuote({
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
    dealId,
    taxRate: parsed.data.taxRate ?? null,
    taxLabel: parsed.data.taxLabel,
    validityDays: parsed.data.validityDays,
    notes: parsed.data.notes ?? null,
  });
  if (!result.ok) return crmErrorResponse(result);

  return NextResponse.json({ document: result.document, quoteNumber: result.quoteNumber }, { status: 201 });
}
