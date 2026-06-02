/**
 * PDF upload endpoint — accepts the organizer-uploaded background PDF
 * for the certificate template editor.
 *
 * Validates via magic bytes (PDF files start with `%PDF-` = 0x25 0x50
 * 0x44 0x46 0x2D). Server-validates the actual file content rather than
 * trusting the Content-Type header. 5MB cap — designer PDFs are
 * vector + small images, rarely exceed 1-2MB.
 *
 * Stored at `public/uploads/certificates/{year}/{month}/{uuid}.pdf` via
 * the existing storage provider (local or Supabase). Returns the URL.
 * Same auth + rate-limit envelope as photo upload (denyReviewer + 50/hr
 * per user).
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { randomUUID } from "crypto";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { denyReviewer } from "@/lib/auth-guards";
import { uploadCertificatePdf } from "@/lib/storage";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2D]; // "%PDF-"

function isPdfBuffer(buf: Buffer): boolean {
  if (buf.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (buf[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
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
      return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` },
        { status: 400 },
      );
    }
    // Optional eventId for storage path scoping — uses "shared" if absent.
    const eventId = (form.get("eventId") as string) || "shared";

    const buffer = Buffer.from(await file.arrayBuffer());
    if (!isPdfBuffer(buffer)) {
      apiLogger.warn({
        msg: "pdf-upload:invalid-magic",
        userId: session.user.id,
        firstBytes: buffer.slice(0, 8).toString("hex"),
        clientType: file.type,
      });
      return NextResponse.json(
        { error: "File is not a valid PDF (magic bytes mismatch)" },
        { status: 400 },
      );
    }

    const filename = `${randomUUID()}.pdf`;
    const url = await uploadCertificatePdf(buffer, filename, eventId);

    apiLogger.info({
      msg: "pdf-upload:ok",
      userId: session.user.id,
      eventId,
      size: buffer.length,
      url,
    });

    return NextResponse.json({ url, size: buffer.length });
  } catch (error) {
    apiLogger.error({ err: error, msg: "pdf-upload:failed" });
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
