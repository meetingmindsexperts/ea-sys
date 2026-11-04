/**
 * /api/crm/deals/[dealId]/quotes/[quoteId]/quickbooks (Nov 4, 2026).
 *
 * GET: whether the quote is in QuickBooks, else what still stops it.
 * POST: send it as an Estimate. The first EA-SYS write into QuickBooks, so it
 *   refuses API keys (a person decides what reaches the books) and carries its
 *   own tight bucket on top of the CRM write backstop.
 */
import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, crmCan, crmErrorResponse } from "@/crm/lib/crm-route";
import { getQuoteQuickBooksState, sendQuoteToQuickBooks } from "@/crm/services/crm-quickbooks-service";

interface RouteParams {
  params: Promise<{ dealId: string; quoteId: string }>;
}

const SEND_LIMIT = 30;
const SEND_WINDOW_MS = 60 * 60 * 1000;

export async function GET(req: Request, { params }: RouteParams) {
  const [{ error, ctx }, { dealId, quoteId }] = await Promise.all([requireCrmRead(req), params]);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const result = await getQuoteQuickBooksState({ organizationId: ctx.organizationId, dealId, quoteId });
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({ state: result.state });
  });
}

export async function POST(req: Request, { params }: RouteParams) {
  const [{ error, ctx }, { dealId, quoteId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    if (ctx.fromApiKey) {
      apiLogger.warn({ msg: "crm/quotes/quickbooks:api-key-refused", organizationId: ctx.organizationId, dealId, quoteId });
      return NextResponse.json(
        { error: "Sending to QuickBooks needs a signed-in person, not an API key", code: "API_KEY_NOT_ALLOWED" },
        { status: 403 },
      );
    }
    const limit = checkRateLimit({ key: `crm-quickbooks-send:org:${ctx.organizationId}`, limit: SEND_LIMIT, windowMs: SEND_WINDOW_MS });
    if (!limit.allowed) {
      return rateLimited(limit, {
        route: "crm/deals/quotes/quickbooks:POST",
        limit: SEND_LIMIT,
        windowSeconds: SEND_WINDOW_MS / 1000,
        organizationId: ctx.organizationId,
      });
    }

    const result = await sendQuoteToQuickBooks({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      source: ctx.fromMobile ? "api" : "rest",
      dealId,
      quoteId,
    });
    if (!result.ok) return crmErrorResponse(result);
    // The total warning names both totals: money, for those who may see it.
    const canSeeMoney = crmCan(ctx, "crm.dealValues.view");
    const estimate = canSeeMoney
      ? result.estimate
      : { ...result.estimate, totalWarning: result.estimate.totalWarning ? "QuickBooks' total differs from the quote's. Ask finance to check the Estimate." : null };
    return NextResponse.json({ estimate });
  });
}
