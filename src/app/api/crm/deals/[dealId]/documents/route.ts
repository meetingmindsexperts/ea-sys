import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { requireCrmRead, requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { canViewDealValues } from "@/crm/lib/crm-visibility";
import { addDealDocument, DEAL_DOCUMENT_SELECT } from "@/crm/services/deal-document-service";

/**
 * Deal documents — the sponsorship prospectus (one per deal, upload replaces)
 * + supporting files (kind OTHER), attachable to the deal's outgoing email.
 *
 * PDF ONLY (owner decision, July 21 2026): what goes to a sponsor is a PDF.
 * Magic-byte validated — a spoofed Content-Type must not smuggle another file
 * type onto disk. 10MB cap.
 */

export const DEAL_DOCUMENT_MAX_SIZE = 10 * 1024 * 1024;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

function isPdf(buf: Buffer): boolean {
  return buf.length >= PDF_MAGIC.length && PDF_MAGIC.every((b, i) => buf[i] === b);
}

interface RouteParams {
  params: Promise<{ dealId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmRead(req), params]);
  if (error) return error;

  try {
    const deal = await db.crmDeal.findFirst({
      where: { id: dealId, organizationId: ctx.organizationId },
      select: { id: true },
    });
    if (!deal) {
      apiLogger.warn({ msg: "crm/deal-documents:deal-not-found", dealId, organizationId: ctx.organizationId });
      return NextResponse.json({ error: "Deal not found" }, { status: 404 });
    }

    const documents = await db.crmDealDocument.findMany({
      // A generated quote PDF PRINTS the deal's prices — the same money the
      // dealValue redaction hides from MEMBER. Key-based redaction can't reach
      // inside a PDF, so a money-blind caller doesn't get the pointer at all.
      where: {
        dealId,
        ...(canViewDealValues(ctx.role, ctx.fromApiKey) ? {} : { kind: { not: "QUOTE" as const } }),
      },
      select: DEAL_DOCUMENT_SELECT,
      orderBy: [{ kind: "asc" }, { createdAt: "desc" }],
    });
    return NextResponse.json({ documents });
  } catch (err) {
    apiLogger.error({
      msg: "crm/deal-documents:list-failed",
      dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load the documents" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const rl = checkRateLimit({
    key: `crm-deal-doc-upload:org:${ctx.organizationId}`,
    limit: 60,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    apiLogger.warn({ msg: "crm/deal-documents:rate-limited", organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: "Too many uploads — try again shortly", code: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const rawKind = String(formData.get("kind") ?? "OTHER");
    const label = String(formData.get("label") ?? "").trim().slice(0, 200) || null;

    if (!file) {
      apiLogger.warn({ msg: "crm/deal-documents:no-file", dealId, userId: ctx.userId });
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    if (rawKind !== "PROSPECTUS" && rawKind !== "OTHER") {
      apiLogger.warn({ msg: "crm/deal-documents:invalid-kind", kind: rawKind, userId: ctx.userId });
      return NextResponse.json({ error: "kind must be PROSPECTUS or OTHER" }, { status: 400 });
    }
    if (file.type !== "application/pdf") {
      apiLogger.warn({ msg: "crm/deal-documents:invalid-mime", claimedType: file.type, userId: ctx.userId });
      return NextResponse.json({ error: "Only PDF files are allowed" }, { status: 400 });
    }
    if (file.size > DEAL_DOCUMENT_MAX_SIZE) {
      apiLogger.warn({ msg: "crm/deal-documents:too-large", size: file.size, userId: ctx.userId });
      return NextResponse.json({ error: "File must be under 10MB" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (!isPdf(buffer)) {
      apiLogger.warn({ msg: "crm/deal-documents:invalid-magic-bytes", claimedType: file.type, userId: ctx.userId });
      return NextResponse.json({ error: "File content is not a PDF" }, { status: 400 });
    }

    const dirRel = path.join("uploads", "crm-deal-docs", dealId);
    const dirAbs = path.resolve(process.cwd(), "public", dirRel);
    await fs.mkdir(dirAbs, { recursive: true });
    const storedName = `${randomUUID()}.pdf`;
    await fs.writeFile(path.join(dirAbs, storedName), buffer);
    const url = `/${dirRel.split(path.sep).join("/")}/${storedName}`;

    const result = await addDealDocument({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      source: ctx.fromApiKey ? "api" : "rest",
      dealId,
      kind: rawKind,
      url,
      filename: file.name.slice(0, 255),
      label,
      mimeType: "application/pdf",
      size: file.size,
    });

    if (!result.ok) {
      // The row never landed — don't leave the just-written file orphaned.
      await fs.unlink(path.join(dirAbs, storedName)).catch((err) =>
        apiLogger.warn({ err, msg: "crm/deal-documents:orphan-unlink-failed", dealId }),
      );
      return crmErrorResponse(result);
    }

    // A replaced prospectus file is unlinked best-effort AFTER commit.
    if (result.replacedUrl?.startsWith("/uploads/crm-deal-docs/")) {
      const replacedAbs = path.resolve(process.cwd(), "public", result.replacedUrl.slice(1));
      await fs.unlink(replacedAbs).catch((err) =>
        apiLogger.warn({ err, msg: "crm/deal-documents:replace-unlink-failed", replacedAbs }),
      );
    }

    return NextResponse.json({ document: result.document }, { status: 201 });
  } catch (err) {
    apiLogger.error({
      msg: "crm/deal-documents:upload-failed",
      dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not upload the document" }, { status: 500 });
  }
}
