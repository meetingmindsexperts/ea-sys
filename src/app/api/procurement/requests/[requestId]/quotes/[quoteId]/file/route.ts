/**
 * The quote document on a draft's quote: POST a PDF or image (multipart,
 * magic-byte checked, 10 MB), GET it back, DELETE it. Stored under the
 * PRIVATE procurement-quotes prefix, which the public /uploads catch-all
 * refuses, and streamed only here, bound to the request row the caller may
 * read. Writes need the request grant or the admin role (the draft-write
 * rule); reads need "view".
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { deleteStoredFile, readStoredFile, uploadFile } from "@/lib/storage";
import { StorageError } from "@/lib/storage-errors";
import { UPLOAD_PREFIX, UPLOAD_SEGMENT } from "@/lib/upload-prefixes";
import { canAdminProcurement } from "@/lib/procurement-visibility";
import { QUOTE_FILE_MAX_BYTES, safeQuoteFileName, sniffQuoteFile } from "@/procurement/lib/quote-file";
import { HTTP_STATUS_FOR_SPEND_REQUEST_ERROR, denyUnlessRequestOrAdmin, guardedRead, procurementGuard, rejected } from "@/procurement/lib/route-helpers";
import { getSpendRequest, setQuoteFile } from "@/procurement/services/spend-request-service";

type Params = { params: Promise<{ requestId: string; quoteId: string }> };
const ROUTE = "procurement/requests/[requestId]/quotes/[quoteId]/file";

export async function POST(req: NextRequest, { params }: Params) {
  const [g, { requestId, quoteId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view", write: true }), params]);
  if (!g.ok) return g.response;
  const denied = denyUnlessRequestOrAdmin(ROUTE, g.user);
  if (denied) return denied;
  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    file = f instanceof File ? f : null;
  } catch (err) {
    apiLogger.warn({ msg: `${ROUTE}:bad-form`, err, userId: g.user.id, requestId, quoteId });
    return NextResponse.json({ error: "Send the file as multipart form data under 'file'.", code: "INVALID_FORM" }, { status: 400 });
  }
  if (!file) {
    apiLogger.warn({ msg: `${ROUTE}:no-file`, userId: g.user.id, requestId, quoteId });
    return NextResponse.json({ error: "No file was sent.", code: "NO_FILE" }, { status: 400 });
  }
  if (file.size > QUOTE_FILE_MAX_BYTES) {
    apiLogger.warn({ msg: `${ROUTE}:too-large`, size: file.size, userId: g.user.id, requestId, quoteId });
    return NextResponse.json({ error: "The file is over 10 MB.", code: "FILE_TOO_LARGE" }, { status: 400 });
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const kind = sniffQuoteFile(buf);
  if (!kind) {
    apiLogger.warn({ msg: `${ROUTE}:bad-type`, declared: file.type, userId: g.user.id, requestId, quoteId });
    return NextResponse.json({ error: "A quote is a PDF, PNG or JPEG.", code: "UNSUPPORTED_TYPE" }, { status: 400 });
  }
  return runWithTenant(g.orgId, async () => {
    const storedPath = await uploadFile(buf, `${quoteId}-${randomUUID()}.${kind.ext}`, kind.mime, `${UPLOAD_SEGMENT.procurementQuotes}/${g.orgId}`);
    const result = await setQuoteFile({ organizationId: g.orgId, actor: { id: g.user.id, isAdmin: canAdminProcurement(g.user) }, source: "ui", requestId, quoteId, fileUrl: storedPath, fileName: safeQuoteFileName(file.name), fileMimeType: kind.mime, fileSize: buf.length });
    if (!result.ok) {
      // The row refused the file (not a draft, not this person's): the bytes must not stay behind.
      await deleteStoredFile(storedPath, UPLOAD_PREFIX.procurementQuotes);
      return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_SPEND_REQUEST_ERROR);
    }
    if (result.replacedFileUrl) await deleteStoredFile(result.replacedFileUrl, UPLOAD_PREFIX.procurementQuotes);
    apiLogger.info({ msg: `${ROUTE}:attached`, requestId, quoteId, bytes: buf.length, mime: kind.mime, userId: g.user.id });
    return NextResponse.json({ request: result.request }, { status: 201 });
  });
}

export async function GET(_req: NextRequest, { params }: Params) {
  const [g, { requestId, quoteId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view" }), params]);
  if (!g.ok) return g.response;
  return runWithTenant(g.orgId, () => guardedRead(ROUTE, g.user.id, async () => {
    const detail = await getSpendRequest(g.orgId, requestId);
    if (!detail.ok) return rejected(ROUTE, g.user.id, detail, HTTP_STATUS_FOR_SPEND_REQUEST_ERROR);
    const quote = detail.request.quotes.find((q) => q.id === quoteId);
    if (!quote?.fileUrl) {
      apiLogger.warn({ msg: `${ROUTE}:no-file-on-quote`, requestId, quoteId, userId: g.user.id });
      return NextResponse.json({ error: "That quote has no file.", code: "QUOTE_NOT_FOUND" }, { status: 404 });
    }
    try {
      const bytes = await readStoredFile(quote.fileUrl, UPLOAD_PREFIX.procurementQuotes);
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          "Content-Type": quote.fileMimeType ?? "application/octet-stream",
          "Content-Disposition": `inline; filename="${safeQuoteFileName(quote.fileName)}"`,
          "Cache-Control": "private, no-store",
        },
      });
    } catch (err) {
      const reason = err instanceof StorageError ? err.reason : "unknown";
      apiLogger.warn({ msg: `${ROUTE}:read-failed`, reason, requestId, quoteId, userId: g.user.id });
      return NextResponse.json({ error: "The file could not be read.", code: "FILE_UNAVAILABLE" }, { status: 404 });
    }
  }));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const [g, { requestId, quoteId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view", write: true }), params]);
  if (!g.ok) return g.response;
  const denied = denyUnlessRequestOrAdmin(ROUTE, g.user);
  if (denied) return denied;
  return runWithTenant(g.orgId, async () => {
    const result = await setQuoteFile({ organizationId: g.orgId, actor: { id: g.user.id, isAdmin: canAdminProcurement(g.user) }, source: "ui", requestId, quoteId, fileUrl: null, fileName: null, fileMimeType: null, fileSize: null });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_SPEND_REQUEST_ERROR);
    if (result.replacedFileUrl) await deleteStoredFile(result.replacedFileUrl, UPLOAD_PREFIX.procurementQuotes);
    return NextResponse.json({ request: result.request });
  });
}
