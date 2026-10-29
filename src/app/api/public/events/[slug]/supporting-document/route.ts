/**
 * Public resident/trainee official-letter upload.
 *
 *   POST multipart { file } → stores the file, returns { url, filename }
 *
 * The registration form uploads here BEFORE it submits, then hands the returned
 * path to the register POST, which validates its shape and stores it on the
 * registration.
 *
 * ── This is the first genuinely UNAUTHENTICATED upload in the system ─────────
 * Every other public upload we run is token-gated (reimbursement, speaker
 * form), and the authenticated ones sit behind `auth()`. A registration form
 * has no token and no session, so nothing identifies the caller. That is not an
 * oversight in the design, it is the nature of a public registration form, so
 * the bounds have to come from somewhere else:
 *
 *   - PDF / JPG / PNG only, MAGIC-BYTE checked. A declared Content-Type is
 *     attacker-supplied and means nothing.
 *   - 5MB per file.
 *   - 10 uploads/hr/IP. An honest registrant uploads once and occasionally
 *     retries; this is loose enough to absorb that and tight enough to bound
 *     the disk an anonymous caller can consume to 50MB/hr.
 *   - The event must exist and be open to the public, so the endpoint is only
 *     live for real events.
 *   - Stored under a directory the public /uploads catch-all BLOCKS, so nobody
 *     can read back what anyone else uploaded even knowing the path.
 *
 * A file uploaded here and never claimed by a registration is an orphan (the
 * registrant abandoned the form). That is expected and bounded by the limits
 * above; the `resident-letter-prune` worker job removes unreferenced files.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { storeSupportingDocument } from "@/lib/supporting-document-upload";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  const { slug } = await params;
  const ip = getClientIp(req);

  try {
    const rate = checkRateLimit({
      key: `resident-letter-upload:${ip}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!rate.allowed) {
      apiLogger.warn({ msg: "public/supporting-document:rate-limited", slug, ip, retryAfterSeconds: rate.retryAfterSeconds });
      return NextResponse.json(
        { error: "Too many uploads. Please try again later." },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
      );
    }

    // Resolve the event BEFORE reading the body — a bad slug should cost us a
    // lookup, not 5MB of buffering.
    const event = await db.event.findFirst({
      where: await publicEventWhere(req, slug, { statuses: ["PUBLISHED", "LIVE"] }),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "public/supporting-document:event-not-found", slug, ip });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const formData = await req.formData();
    // The checks (type, size, magic bytes) and the storage path are shared with
    // the onsite desk's upload: src/lib/supporting-document-upload.ts.
    const stored = await storeSupportingDocument(formData.get("file") as File | null, event.id);
    if (!stored.ok) {
      apiLogger.warn({
        msg: `public/supporting-document:${stored.code.toLowerCase().replace(/_/g, "-")}`,
        slug,
        eventId: event.id,
        ...(stored.claimedType !== undefined && { claimedType: stored.claimedType }),
        ...(stored.size !== undefined && { size: stored.size }),
        ip,
      });
      return NextResponse.json({ error: stored.error }, { status: 400 });
    }
    const { url, filename, size, mimeType } = stored;

    apiLogger.info({ msg: "public/supporting-document:uploaded", slug, eventId: event.id, size, mimeType });
    return NextResponse.json({ url, filename }, { status: 201 });
  } catch (err) {
    apiLogger.error({ err, msg: "public/supporting-document:failed", slug, ip });
    return NextResponse.json({ error: "Failed to upload the letter" }, { status: 500 });
  }
}
