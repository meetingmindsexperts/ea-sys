import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit, getClientIp } from "@/lib/security";

/**
 * Per-speaker uploaded documents (July 16, 2026, owner request):
 *   - kind SIGNED_AGREEMENT — the signed agreement copy the organizer
 *     received back. ONE per speaker (per event): a new upload replaces the
 *     previous one (row + file), with a partial-unique index as the race
 *     backstop. Deliberately does NOT touch Speaker.agreementAcceptedAt
 *     (owner decision — storing the file is not accepting the agreement).
 *   - kind OTHER — any per-speaker file (bio doc, CV, ...), unlimited.
 *
 * PDF + DOC/DOCX only, magic-byte validated, 10MB per file.
 */

export const SPEAKER_DOCUMENT_MAX_SIZE = 10 * 1024 * 1024;

const ALLOWED: Record<string, { ext: string; magic: number[][] }> = {
  "application/pdf": { ext: "pdf", magic: [[0x25, 0x50, 0x44, 0x46, 0x2d]] }, // %PDF-
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    ext: "docx",
    magic: [[0x50, 0x4b, 0x03, 0x04]], // zip
  },
  "application/msword": {
    ext: "doc",
    magic: [[0xd0, 0xcf, 0x11, 0xe0]], // OLE compound file
  },
};

function magicMatches(buf: Buffer, magics: number[][]): boolean {
  return magics.some(
    (magic) => buf.length >= magic.length && magic.every((b, i) => buf[i] === b),
  );
}

interface RouteParams {
  params: Promise<{ eventId: string; speakerId: string }>;
}

const DOCUMENT_SELECT = {
  id: true,
  kind: true,
  url: true,
  filename: true,
  label: true,
  mimeType: true,
  size: true,
  createdAt: true,
  uploadedBy: { select: { firstName: true, lastName: true } },
} as const;

async function loadSpeakerInEvent(
  user: { id: string; role: string; organizationId?: string | null },
  eventId: string,
  speakerId: string,
) {
  const event = await db.event.findFirst({
    where: buildEventAccessWhere(user, eventId),
    select: { id: true },
  });
  if (!event) return null;
  return db.speaker.findFirst({
    where: { id: speakerId, eventId },
    select: { id: true },
  });
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, speakerId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Documents (a signed agreement is quasi-legal paperwork) are a STAFF
    // surface; MEMBER — the org-bound read-only viewer — may read. The
    // org-null attendee roles (SUBMITTER could reach the event via their own
    // speaker linkage) must not browse other speakers' files.
    const denied = denyReviewer(session, { allow: ["MEMBER"] });
    if (denied) return denied;

    const speaker = await loadSpeakerInEvent(session.user, eventId, speakerId);
    if (!speaker) {
      apiLogger.warn({ msg: "speaker-documents:not-found", eventId, speakerId, userId: session.user.id });
      return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
    }

    const documents = await db.speakerDocument.findMany({
      where: { speakerId },
      select: DOCUMENT_SELECT,
      orderBy: [{ kind: "asc" }, { createdAt: "desc" }],
    });
    return NextResponse.json({ documents });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching speaker documents" });
    return NextResponse.json({ error: "Failed to fetch documents" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, speakerId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const rl = checkRateLimit({
      key: `speaker-document-upload:${session.user.id}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "speaker-documents:rate-limited", userId: session.user.id, retryAfterSeconds: rl.retryAfterSeconds });
      return NextResponse.json(
        { error: "Upload rate limit reached. Maximum 30 uploads per hour." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const speaker = await loadSpeakerInEvent(session.user, eventId, speakerId);
    if (!speaker) {
      apiLogger.warn({ msg: "speaker-documents:not-found-on-upload", eventId, speakerId, userId: session.user.id });
      return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const rawKind = String(formData.get("kind") ?? "OTHER");
    const label = String(formData.get("label") ?? "").trim().slice(0, 200) || null;

    if (!file) {
      apiLogger.warn({ msg: "speaker-documents:no-file", eventId, speakerId, userId: session.user.id });
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    if (rawKind !== "SIGNED_AGREEMENT" && rawKind !== "OTHER") {
      apiLogger.warn({ msg: "speaker-documents:invalid-kind", kind: rawKind, userId: session.user.id });
      return NextResponse.json({ error: "kind must be SIGNED_AGREEMENT or OTHER" }, { status: 400 });
    }
    const kind = rawKind as "SIGNED_AGREEMENT" | "OTHER";

    const allowed = ALLOWED[file.type];
    if (!allowed) {
      apiLogger.warn({ msg: "speaker-documents:invalid-mime", claimedType: file.type, userId: session.user.id });
      return NextResponse.json(
        { error: "Only PDF and DOC/DOCX files are allowed" },
        { status: 400 },
      );
    }
    if (file.size > SPEAKER_DOCUMENT_MAX_SIZE) {
      apiLogger.warn({ msg: "speaker-documents:too-large", size: file.size, userId: session.user.id });
      return NextResponse.json({ error: "File must be under 10MB" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (!magicMatches(buffer, allowed.magic)) {
      // A spoofed Content-Type must not smuggle another file type onto disk.
      apiLogger.warn({ msg: "speaker-documents:invalid-magic-bytes", claimedType: file.type, userId: session.user.id });
      return NextResponse.json(
        { error: "File content does not match its declared type" },
        { status: 400 },
      );
    }

    const dirRel = path.join("uploads", "speaker-docs", eventId);
    const dirAbs = path.resolve(process.cwd(), "public", dirRel);
    await fs.mkdir(dirAbs, { recursive: true });
    const storedName = `${randomUUID()}.${allowed.ext}`;
    await fs.writeFile(path.join(dirAbs, storedName), buffer);
    const url = `/${dirRel.split(path.sep).join("/")}/${storedName}`;

    // SIGNED_AGREEMENT is one-per-speaker: replace the previous row inside
    // the transaction (the partial unique index backstops a race), then
    // unlink the replaced file best-effort after commit.
    const { document, replacedUrl } = await db.$transaction(async (tx) => {
      let replaced: string | null = null;
      if (kind === "SIGNED_AGREEMENT") {
        const previous = await tx.speakerDocument.findFirst({
          where: { speakerId, kind: "SIGNED_AGREEMENT" },
          select: { id: true, url: true },
        });
        if (previous) {
          replaced = previous.url;
          await tx.speakerDocument.delete({ where: { id: previous.id } });
        }
      }
      const created = await tx.speakerDocument.create({
        data: {
          speakerId,
          kind,
          url,
          filename: file.name.slice(0, 255),
          label,
          mimeType: file.type,
          size: file.size,
          uploadedById: session.user.id,
        },
        select: DOCUMENT_SELECT,
      });
      return { document: created, replacedUrl: replaced };
    });

    if (replacedUrl?.startsWith("/uploads/speaker-docs/")) {
      const replacedAbs = path.resolve(process.cwd(), "public", replacedUrl.slice(1));
      await fs.unlink(replacedAbs).catch((err) =>
        apiLogger.warn({ err, msg: "speaker-documents:replace-unlink-failed", replacedAbs }),
      );
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "CREATE",
          entityType: "SpeakerDocument",
          entityId: document.id,
          changes: {
            speakerId,
            kind,
            filename: document.filename,
            label,
            size: file.size,
            ...(replacedUrl ? { replacedPrevious: true } : {}),
            ip: getClientIp(req),
          },
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "speaker-documents:audit-log-failed", eventId, speakerId }));

    apiLogger.info({ msg: "speaker-documents:uploaded", eventId, speakerId, kind, userId: session.user.id });
    return NextResponse.json({ document }, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error uploading speaker document" });
    return NextResponse.json({ error: "Failed to upload document" }, { status: 500 });
  }
}
