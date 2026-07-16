import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, denyFinance } from "@/lib/auth-guards";
import { checkRateLimit, getClientIp } from "@/lib/security";
import {
  mergeBillingAccounts,
  type MergeBillingAccountsErrorCode,
} from "@/services/billing-account-service";

/**
 * POST /api/billing-accounts/[billingAccountId]/merge
 *
 * Merge a DUPLICATE payer into this one (the URL id is the SURVIVOR). The
 * admin review action for `needsReview` payers minted by
 * `findOrCreateBillingAccount`'s near-duplicate detection: re-points every
 * registration + event attachment from the duplicate to the survivor inside
 * one transaction, deletes the duplicate, clears the survivor's review flag.
 *
 * Org-scoped, denyReviewer + denyFinance (same boundary as the other payer
 * writes), audited (action MERGE on the survivor).
 */

const bodySchema = z.object({
  duplicateId: z.string().min(1).max(100),
});

const HTTP_STATUS_FOR_CODE: Record<MergeBillingAccountsErrorCode, number> = {
  NOT_FOUND: 404,
  SAME_ACCOUNT: 400,
  UNKNOWN: 500,
};

interface RouteParams {
  params: Promise<{ billingAccountId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ billingAccountId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    const noFinance = denyFinance(session);
    if (noFinance) return noFinance;

    // A merge deletes a payer row — keep a modest ceiling on the operation.
    const rate = checkRateLimit({
      key: `billing-account-merge:${session.user.id}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    if (!rate.allowed) {
      apiLogger.warn({
        msg: "billing-account-merge:rate-limited",
        userId: session.user.id,
        retryAfterSeconds: rate.retryAfterSeconds,
      });
      return NextResponse.json(
        {
          error: "Too many merges. Please try again later.",
          retryAfterSeconds: rate.retryAfterSeconds,
          limit: 30,
          windowSeconds: 3600,
        },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
      );
    }

    const body = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({
        msg: "billing-account-merge:zod-validation-failed",
        billingAccountId,
        errors: parsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const result = await mergeBillingAccounts({
      survivorId: billingAccountId,
      duplicateId: parsed.data.duplicateId,
      organizationId: session.user.organizationId!,
      userId: session.user.id,
      source: "rest",
      requestIp: getClientIp(req),
    });

    if (!result.ok) {
      apiLogger.warn({
        msg: "billing-account-merge:rejected",
        billingAccountId,
        duplicateId: parsed.data.duplicateId,
        code: result.code,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: result.message, code: result.code },
        { status: HTTP_STATUS_FOR_CODE[result.code] ?? 500 },
      );
    }

    return NextResponse.json({ success: true, ...result.merge });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error merging billing accounts" });
    return NextResponse.json({ error: "Failed to merge billing accounts" }, { status: 500 });
  }
}
