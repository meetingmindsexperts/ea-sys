import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireCrmRead } from "@/crm/lib/crm-route";
import { canViewCrmInbox } from "@/crm/lib/crm-visibility";

/**
 * GET — authed stream of an inbound email attachment (by index into the
 * message's attachments JSON).
 *
 * Files live under the PRIVATE crm-email-attachments prefix (blocked on the
 * public /uploads catch-all); this route is the only read path. Row bound
 * message → org; the inbox staff gate applies. Sponsor-sent files are
 * UNTRUSTED: only PDFs and images stream inline — everything else downloads
 * (`attachment` disposition) so an HTML/SVG payload can't execute in-origin.
 */
const INLINE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"]);

interface AttachmentMeta {
  filename?: string;
  mimeType?: string;
  path?: string;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ messageId: string; index: string }> },
) {
  const [{ error, ctx }, { messageId, index }] = await Promise.all([requireCrmRead(req), params]);
  if (error) return error;
  if (!canViewCrmInbox(ctx.role, ctx.fromApiKey)) {
    apiLogger.warn({ msg: "crm/inbox:attachment-forbidden", role: ctx.role, userId: ctx.userId });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx > 50) {
      apiLogger.warn({ msg: "crm/inbox:attachment-bad-index", messageId, index });
      return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
    }

    const message = await db.crmEmailMessage.findFirst({
      where: { id: messageId, organizationId: ctx.organizationId },
      select: { attachments: true },
    });
    const meta = (message?.attachments as AttachmentMeta[] | null)?.[idx];
    if (!meta?.path) {
      apiLogger.warn({ msg: "crm/inbox:attachment-not-found", messageId, index: idx });
      return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
    }

    const allowedRoot = path.resolve(process.cwd(), "public", "uploads", "crm-email-attachments");
    if (!meta.path.startsWith("/uploads/crm-email-attachments/")) {
      apiLogger.warn({ msg: "crm/inbox:attachment-outside-root", messageId, path: meta.path });
      return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
    }
    const abs = path.resolve(process.cwd(), "public", meta.path.slice(1));
    let resolved: string;
    try {
      resolved = await fs.realpath(abs);
    } catch {
      apiLogger.error({ msg: "crm/inbox:attachment-file-missing", messageId, abs });
      return NextResponse.json(
        {
          error:
            "The file is missing on this server. With local storage, files stored on another machine are not present here.",
          code: "FILE_MISSING",
        },
        { status: 404 },
      );
    }
    if (!resolved.startsWith(allowedRoot + path.sep)) {
      apiLogger.warn({ msg: "crm/inbox:attachment-traversal-blocked", messageId, resolved });
      return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
    }

    const file = await fs.readFile(resolved);
    const mimeType = meta.mimeType ?? "application/octet-stream";
    const disposition = INLINE_TYPES.has(mimeType) ? "inline" : "attachment";
    const safeName = (meta.filename ?? "attachment").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "attachment";
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `${disposition}; filename="${safeName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'",
      },
    });
  } catch (err) {
    apiLogger.error({
      msg: "crm/inbox:attachment-stream-failed",
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Failed to load attachment" }, { status: 500 });
  }
}
