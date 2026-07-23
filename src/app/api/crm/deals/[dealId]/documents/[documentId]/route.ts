import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { apiLogger } from "@/lib/logger";
import { db } from "@/lib/db";
import { requireCrmRead, requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { canViewDealValues } from "@/crm/lib/crm-visibility";
import { removeDealDocument } from "@/crm/services/deal-document-service";

/**
 * GET — authed stream of a deal document (multi-tenant prep, July 23 2026).
 *
 * Deal files (prospectus, quotes, contract drafts) live under
 * public/uploads/crm-deal-docs/ for the persistent-volume + DR-sync ride, but
 * the public /uploads catch-all BLOCKS that prefix — this route is the only
 * read path. Row bound document → deal → org; quote PDFs print deal money, so
 * a caller the dealValue redaction applies to doesn't get them at all (404,
 * same shape as the list GET's kind filter — no existence leak). Reimbursement
 * streaming is the reference pattern.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ dealId: string; documentId: string }> },
) {
  const [{ error, ctx }, { dealId, documentId }] = await Promise.all([requireCrmRead(req), params]);
  if (error) return error;

  try {
    const doc = await db.crmDealDocument.findFirst({
      where: { id: documentId, dealId, organizationId: ctx.organizationId },
      select: { url: true, filename: true, kind: true },
    });
    if (!doc || (doc.kind === "QUOTE" && !canViewDealValues(ctx.role, ctx.fromApiKey))) {
      apiLogger.warn({
        msg: "crm/deal-documents:stream-not-found",
        dealId,
        documentId,
        organizationId: ctx.organizationId,
        quoteBlocked: doc?.kind === "QUOTE",
      });
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const allowedRoot = path.resolve(process.cwd(), "public", "uploads", "crm-deal-docs");
    if (!doc.url.startsWith("/uploads/crm-deal-docs/")) {
      apiLogger.warn({ msg: "crm/deal-documents:url-outside-root", documentId, url: doc.url });
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }
    const abs = path.resolve(process.cwd(), "public", doc.url.slice(1));
    let resolved: string;
    try {
      resolved = await fs.realpath(abs);
    } catch {
      apiLogger.error({ msg: "crm/deal-documents:file-missing", documentId, abs });
      return NextResponse.json(
        {
          error:
            "The file is missing on this server. With local storage, files uploaded on another machine are not present here.",
          code: "FILE_MISSING",
        },
        { status: 404 },
      );
    }
    if (!resolved.startsWith(allowedRoot + path.sep)) {
      apiLogger.warn({ msg: "crm/deal-documents:traversal-blocked", documentId, resolved });
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const file = await fs.readFile(resolved);
    // ASCII-sanitized filename — a crafted filename must not inject header chars.
    const safeName = doc.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "document.pdf";
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${safeName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'",
      },
    });
  } catch (err) {
    apiLogger.error({
      msg: "crm/deal-documents:stream-failed",
      dealId,
      documentId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Failed to load document" }, { status: 500 });
  }
}

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
