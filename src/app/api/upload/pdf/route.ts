/**
 * Cert background upload endpoint — accepts the organizer-uploaded
 * cert visual for the canvas editor.
 *
 * Accepts three input formats, validated by magic bytes (Content-Type
 * header is not trusted):
 *   - PDF      (%PDF-                  = 0x25 0x50 0x44 0x46 0x2D)
 *   - JPEG     (FF D8 FF)
 *   - PNG      (89 50 4E 47 0D 0A 1A 0A)
 *
 * If the upload is an image, it's wrapped in a single-page PDF using
 * pdf-lib (page dimensions = image's intrinsic pixel dimensions, image
 * fills the page edge-to-edge). The conversion happens once at upload
 * time so downstream code (renderer, canvas editor) only ever sees PDF.
 *
 * Designers commonly export cert visuals as JPG/PNG from Photoshop /
 * Illustrator / Canva instead of PDF; the conversion removes that
 * friction. The stored URL always ends in `.pdf`; the original image
 * is discarded after the wrap.
 *
 * 10MB cap on the upload (PNG cert designs can be 5-8MB at full res).
 * Stored at `public/uploads/certificates/{eventId}/{uuid}.pdf` via the
 * existing storage provider. Same auth + rate-limit envelope as photo
 * upload (denyReviewer + 50/hr per user).
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { randomUUID } from "crypto";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { denyReviewer } from "@/lib/auth-guards";
import { uploadCertificatePdf } from "@/lib/storage";
import { db } from "@/lib/db";
import { PDFDocument } from "pdf-lib";

// cuid shape — Prisma's default id generator. Restrict eventId to this
// pattern BEFORE touching the filesystem so "../../media" style traversal
// attempts can't get past the front gate.
const CUID_RE = /^[a-z0-9]{20,40}$/i;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB (raised from 5MB to cover full-res PNG designs)
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

type DetectedFormat = "pdf" | "png" | "jpeg" | null;

function detectFormat(buf: Buffer): DetectedFormat {
  if (startsWith(buf, PDF_MAGIC)) return "pdf";
  if (startsWith(buf, PNG_MAGIC)) return "png";
  if (startsWith(buf, JPEG_MAGIC)) return "jpeg";
  return null;
}

function startsWith(buf: Buffer, magic: number[]): boolean {
  if (buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buf[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * Wrap a JPG/PNG image buffer in a single-page PDF. Page dimensions =
 * image's intrinsic pixel dimensions (in points; 1pt = 1/72"). The image
 * fills the page edge-to-edge with no scaling, so the canvas editor's
 * displayScale arithmetic stays correct regardless of image resolution.
 *
 * Returns the resulting PDF as a Buffer ready for `uploadCertificatePdf`.
 */
async function imageToPdf(
  buffer: Buffer,
  format: "png" | "jpeg",
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const image =
    format === "png"
      ? await pdfDoc.embedPng(buffer)
      : await pdfDoc.embedJpg(buffer);

  // page = image's intrinsic dimensions. pdf-lib's PDFImage exposes
  // .width and .height in image-pixel units which we map 1:1 to PDF
  // points — fine because the renderer + canvas editor use the page's
  // own dimensions consistently.
  const page = pdfDoc.addPage([image.width, image.height]);
  page.drawImage(image, {
    x: 0,
    y: 0,
    width: image.width,
    height: image.height,
  });

  pdfDoc.setTitle("Certificate background (converted from image)");
  pdfDoc.setCreator("EA-SYS cert upload");

  const out = await pdfDoc.save();
  return Buffer.from(out);
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;

    const rl = checkRateLimit({
      key: `pdf-upload:${session.user.id}`,
      limit: 50,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "upload/pdf:rate-limited", retryAfterSeconds: rl.retryAfterSeconds });
      return NextResponse.json(
        {
          error: "Too many uploads. Try again later.",
          code: "RATE_LIMITED",
          retryAfterSeconds: rl.retryAfterSeconds,
        },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    // Read body — multipart form data with a "file" field.
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      apiLogger.warn({
        msg: "cert-upload:missing-file",
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      apiLogger.warn({
        msg: "cert-upload:file-too-large",
        userId: session.user.id,
        size: file.size,
        max: MAX_FILE_SIZE,
      });
      return NextResponse.json(
        { error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` },
        { status: 400 },
      );
    }

    // eventId is REQUIRED — drives the storage subdir + org-membership
    // check. Reject anything outside the cuid shape BEFORE touching the
    // filesystem (defense-in-depth against `eventId=../../media` style
    // traversal even though the cuid regex would already reject it).
    // Then verify the event belongs to the caller's org — otherwise an
    // authenticated ORGANIZER in org A could dump PDFs into org B's
    // certificate directory tree.
    const eventIdRaw = form.get("eventId");
    const eventId = typeof eventIdRaw === "string" ? eventIdRaw : "";
    if (!eventId || !CUID_RE.test(eventId)) {
      apiLogger.warn({
        msg: "cert-upload:invalid-eventid",
        userId: session.user.id,
        eventIdRaw: typeof eventIdRaw === "string" ? eventIdRaw.slice(0, 40) : null,
      });
      return NextResponse.json(
        { error: "eventId is required and must be a valid event id", code: "INVALID_EVENT_ID" },
        { status: 400 },
      );
    }
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-upload:no-org", userId: session.user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId },
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({
        msg: "cert-upload:event-not-found-or-cross-tenant",
        userId: session.user.id,
        organizationId: session.user.organizationId,
        eventId,
      });
      // 404 not 403 — avoid leaking event existence across orgs.
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const inputBuffer = Buffer.from(await file.arrayBuffer());
    const format = detectFormat(inputBuffer);
    if (!format) {
      apiLogger.warn({
        msg: "cert-upload:invalid-magic",
        userId: session.user.id,
        firstBytes: inputBuffer.subarray(0, 8).toString("hex"),
        clientType: file.type,
      });
      return NextResponse.json(
        {
          error:
            "File must be a PDF, PNG, or JPEG (magic bytes mismatch). Re-export your cert from your designer tool.",
        },
        { status: 400 },
      );
    }

    // Convert image inputs to PDF; PDF inputs pass through.
    let pdfBuffer: Buffer;
    let convertedFrom: "png" | "jpeg" | null = null;
    if (format === "pdf") {
      pdfBuffer = inputBuffer;
    } else {
      try {
        pdfBuffer = await imageToPdf(inputBuffer, format);
        convertedFrom = format;
      } catch (e) {
        apiLogger.error({
          err: e,
          msg: "cert-upload:image-to-pdf-failed",
          userId: session.user.id,
          format,
          size: inputBuffer.length,
        });
        return NextResponse.json(
          {
            error: `Failed to convert ${format.toUpperCase()} to PDF. The image may be corrupt or in an unsupported encoding.`,
          },
          { status: 400 },
        );
      }
    }

    const filename = `${randomUUID()}.pdf`;
    const url = await uploadCertificatePdf(pdfBuffer, filename, eventId);

    apiLogger.info({
      msg: "cert-upload:ok",
      userId: session.user.id,
      eventId,
      inputFormat: format,
      convertedFrom,
      inputSize: inputBuffer.length,
      outputSize: pdfBuffer.length,
      url,
    });

    return NextResponse.json({
      url,
      size: pdfBuffer.length,
      // Surfaced so the editor can show a one-liner ("Converted from PNG")
      // when appropriate; harmless to ignore.
      convertedFrom,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-upload:failed" });
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
