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
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { RESIDENT_LETTER_MAX_SIZE } from "@/lib/resident-letter";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

const ALLOWED: Record<string, { ext: string; magic: number[][] }> = {
  "application/pdf": { ext: "pdf", magic: [[0x25, 0x50, 0x44, 0x46, 0x2d]] }, // %PDF-
  "image/jpeg": { ext: "jpg", magic: [[0xff, 0xd8, 0xff]] },
  "image/png": { ext: "png", magic: [[0x89, 0x50, 0x4e, 0x47]] },
};

function magicMatches(buf: Buffer, magics: number[][]): boolean {
  return magics.some((magic) => buf.length >= magic.length && magic.every((b, i) => buf[i] === b));
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
      apiLogger.warn({ msg: "public/resident-letter:rate-limited", slug, ip, retryAfterSeconds: rate.retryAfterSeconds });
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
      apiLogger.warn({ msg: "public/resident-letter:event-not-found", slug, ip });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      apiLogger.warn({ msg: "public/resident-letter:no-file", slug, eventId: event.id, ip });
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const allowed = ALLOWED[file.type];
    if (!allowed) {
      apiLogger.warn({ msg: "public/resident-letter:invalid-mime", slug, eventId: event.id, claimedType: file.type, ip });
      return NextResponse.json(
        { error: "Only PDF, JPG and PNG files are accepted" },
        { status: 400 },
      );
    }
    if (file.size > RESIDENT_LETTER_MAX_SIZE) {
      apiLogger.warn({ msg: "public/resident-letter:too-large", slug, eventId: event.id, size: file.size, ip });
      return NextResponse.json({ error: "File must be under 5MB" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (!magicMatches(buffer, allowed.magic)) {
      // The declared type and the actual bytes disagree — either a renamed file
      // or a deliberate attempt to store something else under a safe extension.
      apiLogger.warn({ msg: "public/resident-letter:invalid-magic-bytes", slug, eventId: event.id, claimedType: file.type, ip });
      return NextResponse.json(
        { error: "File content does not match its declared type" },
        { status: 400 },
      );
    }

    const dirRel = path.join("uploads", "resident-letters", event.id);
    const dirAbs = path.resolve(process.cwd(), "public", dirRel);
    await fs.mkdir(dirAbs, { recursive: true });
    // The stored name is a uuid, never the registrant's: their filename is
    // attacker-controlled and would otherwise reach the filesystem.
    const storedName = `${randomUUID()}.${allowed.ext}`;
    await fs.writeFile(path.join(dirAbs, storedName), buffer);
    const url = `/${dirRel.split(path.sep).join("/")}/${storedName}`;

    const filename = file.name.slice(0, 255);
    apiLogger.info({ msg: "public/resident-letter:uploaded", slug, eventId: event.id, size: file.size, mimeType: file.type });
    return NextResponse.json({ url, filename }, { status: 201 });
  } catch (err) {
    apiLogger.error({ err, msg: "public/resident-letter:failed", slug, ip });
    return NextResponse.json({ error: "Failed to upload the letter" }, { status: 500 });
  }
}
