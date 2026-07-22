import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { apiLogger } from "@/lib/logger";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { removeDealDocument } from "@/crm/services/deal-document-service";

/**
 * DELETE /api/crm/deals/[dealId]/documents/[documentId] — remove a deal file
 * (row + best-effort disk unlink). Write-gated: removing a stale prospectus is
 * an ordinary correction, not an archive-class action.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ dealId: string; documentId: string }> },
) {
  const [{ error, ctx }, { dealId, documentId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const result = await removeDealDocument({
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
    dealId,
    documentId,
  });
  if (!result.ok) return crmErrorResponse(result);

  if (result.removedUrl.startsWith("/uploads/crm-deal-docs/")) {
    const abs = path.resolve(process.cwd(), "public", result.removedUrl.slice(1));
    await fs.unlink(abs).catch((err) =>
      apiLogger.warn({ err, msg: "crm/deal-documents:delete-unlink-failed", abs }),
    );
  }

  return NextResponse.json({ removed: true });
}
