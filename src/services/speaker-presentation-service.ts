/**
 * Speaker presentations: slides or a video a speaker gives us for a talk
 * (Nov 19, 2026; docs/SPEAKER_PRESENTATIONS_PLAN.md).
 *
 * ONE implementation for both doors: the speaker's own form link and the
 * staff's speaker page. The route decides who is asking (a token, or a
 * signed-in person with the documents permission) and enters the tenant
 * lane; everything about the file is decided here.
 *
 * The bytes never pass through the app on S3: `startPresentationUpload` hands
 * back a signed form for one key, and `completePresentationUpload` checks the
 * object that landed (it exists, its size, its signature) before the row
 * becomes READY. The version that was checked is recorded and every read
 * names it, because a POST policy can be used again until it expires.
 *
 * See src/services/README.md for the conventions (errors as values, no HTTP).
 */
import { randomUUID } from "crypto";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  deleteStoredFile,
  headStoredFile,
  readStoredFileStart,
  signDirectUpload,
  signStoredFileDownload,
  storageProvider,
  uploadFile,
  type DirectUploadTarget,
} from "@/lib/storage";
import { UPLOAD_PREFIX, UPLOAD_SEGMENT } from "@/lib/upload-prefixes";
import { contentDisposition, truncateFilename } from "@/lib/download-filename";
import { runsSession } from "@/lib/session-roles";
import { isSpeakerPresentationsEnabled } from "@/lib/module-flags";
import {
  GENERAL_PRESENTATION_SLOT,
  PRESENTATION_DOWNLOAD_SECONDS,
  PRESENTATION_MAX_BYTES,
  PRESENTATION_MAX_BYTES_PER_SPEAKER,
  PRESENTATION_MAX_FILES_PER_SPEAKER,
  PRESENTATION_SIGNATURE_BYTES,
  PRESENTATION_STALE_UPLOAD_MS,
  PRESENTATION_UPLOAD_SECONDS,
  presentationFileProblem,
  presentationSignatureMatches,
  presentationSlotKey,
  presentationTypeFor,
  type PresentationSlot,
  type PresentationView,
} from "@/lib/speaker-presentations";

const PREFIX = UPLOAD_PREFIX.presentations;

/**
 * Whether presentations are offered on this deployment. On S3 the owner
 * switches it on after preparing the bucket (`isSpeakerPresentationsEnabled`);
 * on the local provider there is nothing to prepare. Any other provider
 * cannot take a direct upload. While false, both doors hide the section and
 * an upload is refused.
 */
export function presentationsAvailable(): boolean {
  if (storageProvider === "local") return true;
  return storageProvider === "s3" && isSpeakerPresentationsEnabled();
}

export type PresentationSource = "speaker-form" | "staff";

/** Who is acting, for the audit trail. A speaker on their own link has no user id. */
export interface PresentationActor {
  source: PresentationSource;
  userId?: string | null;
}

interface SpeakerScope {
  eventId: string;
  organizationId: string;
  speakerId: string;
}

const VIEW_SELECT = {
  id: true,
  sessionId: true,
  topicId: true,
  filename: true,
  size: true,
  status: true,
  uploadedVia: true,
  createdAt: true,
  readyAt: true,
} as const;

type ViewRow = {
  id: string;
  sessionId: string | null;
  topicId: string | null;
  filename: string;
  size: bigint | null;
  status: PresentationView["status"];
  uploadedVia: string;
  createdAt: Date;
  readyAt: Date | null;
};

function toView(row: ViewRow): PresentationView {
  return {
    id: row.id,
    slotKey: presentationSlotKey(row),
    filename: row.filename,
    kind: presentationTypeFor(row.filename)?.kind ?? null,
    // BigInt stops here: no file comes near Number.MAX_SAFE_INTEGER bytes.
    size: row.size == null ? null : Number(row.size),
    status: row.status,
    uploadedVia: row.uploadedVia,
    createdAt: row.createdAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
  };
}

function audit(scope: SpeakerScope, actor: PresentationActor, action: "CREATE" | "DELETE", entityId: string, changes: Record<string, unknown>) {
  db.auditLog
    .create({
      data: {
        eventId: scope.eventId,
        organizationId: scope.organizationId,
        userId: actor.userId ?? null,
        action,
        entityType: "SpeakerPresentation",
        entityId,
        changes: { source: actor.source, speakerId: scope.speakerId, ...changes },
      },
    })
    .catch((err) => apiLogger.error({ err, msg: "speaker-presentation:audit-log-failed", eventId: scope.eventId }));
}

// ── The talks a speaker can upload for ───────────────────────────────────────

/**
 * One slot per talk (owner, Nov 19, 2026): each topic the speaker is on, and
 * each session they present in without a topic of their own there. A role
 * that runs a session (moderator, chair) presents nothing, so it brings no
 * slot. Someone on no talk yet gets one general slot, so a deck that arrives
 * before the agenda does still has somewhere to go.
 */
export async function presentationSlotsForSpeaker(eventId: string, speakerId: string): Promise<PresentationSlot[]> {
  const [topics, sessions] = await Promise.all([
    db.topicSpeaker.findMany({
      where: { speakerId, topic: { session: { eventId } } },
      select: {
        topic: { select: { id: true, title: true, sortOrder: true, session: { select: { id: true, name: true, startTime: true } } } },
      },
    }),
    db.sessionSpeaker.findMany({
      where: { speakerId, session: { eventId } },
      select: { role: true, session: { select: { id: true, name: true, startTime: true } } },
    }),
  ]);

  const slots: (PresentationSlot & { order: number })[] = topics.map(({ topic }) => ({
    key: `topic:${topic.id}`,
    sessionId: topic.session.id,
    topicId: topic.id,
    title: topic.title,
    sessionName: topic.session.name,
    startTime: topic.session.startTime.toISOString(),
    order: topic.sortOrder,
  }));
  const sessionsWithTopic = new Set(slots.map((s) => s.sessionId));
  for (const { role, session } of sessions) {
    if (sessionsWithTopic.has(session.id) || runsSession(role)) continue;
    slots.push({
      key: `session:${session.id}`,
      sessionId: session.id,
      topicId: null,
      title: session.name,
      sessionName: session.name,
      startTime: session.startTime.toISOString(),
      order: 0,
    });
  }
  slots.sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? "") || a.order - b.order || a.title.localeCompare(b.title));
  if (slots.length === 0) {
    return [{ key: GENERAL_PRESENTATION_SLOT, sessionId: null, topicId: null, title: "Your presentation", sessionName: "", startTime: null }];
  }
  return slots.map((s) => ({ key: s.key, sessionId: s.sessionId, topicId: s.topicId, title: s.title, sessionName: s.sessionName, startTime: s.startTime }));
}

/** The speaker's talks and the files received for them (READY only: what the screens show). */
export async function listSpeakerPresentations(
  scope: Pick<SpeakerScope, "eventId" | "speakerId">,
): Promise<{ enabled: boolean; slots: PresentationSlot[]; presentations: PresentationView[] }> {
  // Off on this deployment: the screens hide the section, and nothing is read.
  if (!presentationsAvailable()) return { enabled: false, slots: [], presentations: [] };
  const [slots, rows] = await Promise.all([
    presentationSlotsForSpeaker(scope.eventId, scope.speakerId),
    db.speakerPresentation.findMany({
      where: { eventId: scope.eventId, speakerId: scope.speakerId, status: "READY" },
      select: VIEW_SELECT,
      orderBy: { readyAt: "desc" },
    }),
  ]);
  return { enabled: true, slots, presentations: rows.map(toView) };
}

// ── Starting an upload ───────────────────────────────────────────────────────

export type StartUploadErrorCode =
  | "UPLOADS_UNAVAILABLE"
  | "TYPE_NOT_ALLOWED"
  | "FILE_TOO_LARGE"
  | "FILE_EMPTY"
  | "INVALID_SLOT"
  | "TOO_MANY_FILES"
  | "QUOTA_EXCEEDED";

export type StartUploadResult =
  | { ok: true; presentationId: string; upload: DirectUploadTarget; contentType: string; maxBytes: number }
  | { ok: false; code: StartUploadErrorCode; message: string };

/** Uploads never finished (the browser closed): cleared, with whatever they left in storage. */
async function sweepStaleUploads(scope: Pick<SpeakerScope, "eventId" | "speakerId">): Promise<void> {
  const stale = await db.speakerPresentation.findMany({
    where: {
      eventId: scope.eventId,
      speakerId: scope.speakerId,
      status: "UPLOADING",
      createdAt: { lt: new Date(Date.now() - PRESENTATION_STALE_UPLOAD_MS) },
    },
    select: { id: true, url: true },
  });
  if (stale.length === 0) return;
  await db.speakerPresentation.updateMany({ where: { id: { in: stale.map((r) => r.id) }, status: "UPLOADING" }, data: { status: "FAILED" } });
  await Promise.all(stale.map((r) => deleteStoredFile(r.url, PREFIX)));
  apiLogger.info({ msg: "speaker-presentation:stale-uploads-cleared", eventId: scope.eventId, speakerId: scope.speakerId, count: stale.length });
}

export async function startPresentationUpload(
  input: SpeakerScope & { slotKey: string; filename: string; size: number; actor: PresentationActor },
): Promise<StartUploadResult> {
  const { eventId, organizationId, speakerId, slotKey, size, actor } = input;
  const filename = truncateFilename(input.filename.trim(), 200);
  const refuse = (code: StartUploadErrorCode, message: string): StartUploadResult => {
    apiLogger.warn({ msg: "speaker-presentation:start-refused", code, eventId, speakerId, source: actor.source });
    return { ok: false, code, message };
  };

  if (!presentationsAvailable()) return refuse("UPLOADS_UNAVAILABLE", "Presentation uploads are not available on this server.");
  const problem = presentationFileProblem(filename, size);
  if (problem) return refuse(problem.code, problem.message);
  const type = presentationTypeFor(filename)!;

  const slot = (await presentationSlotsForSpeaker(eventId, speakerId)).find((s) => s.key === slotKey);
  if (!slot) return refuse("INVALID_SLOT", "That talk is no longer on the agenda. Reload the page and try again.");

  await sweepStaleUploads({ eventId, speakerId });
  const held = await db.speakerPresentation.findMany({
    where: { eventId, speakerId, status: { in: ["READY", "UPLOADING"] } },
    select: { size: true },
  });
  if (held.length >= PRESENTATION_MAX_FILES_PER_SPEAKER) {
    return refuse("TOO_MANY_FILES", `At most ${PRESENTATION_MAX_FILES_PER_SPEAKER} files per speaker. Remove one, or contact the organisers.`);
  }
  const heldBytes = held.reduce((sum, r) => sum + Number(r.size ?? 0), 0);
  if (heldBytes + size > PRESENTATION_MAX_BYTES_PER_SPEAKER) {
    return refuse("QUOTA_EXCEEDED", "This would pass the storage allowed per speaker. Contact the organisers.");
  }

  const id = randomUUID().replace(/-/g, "");
  const url = `${PREFIX}${eventId}/${speakerId}/${id}.${type.ext}`;
  const maxBytes = PRESENTATION_MAX_BYTES[type.kind];
  const upload = await signDirectUpload({
    storedPath: url,
    requirePrefix: PREFIX,
    contentType: type.mimeType,
    maxBytes,
    expiresSeconds: PRESENTATION_UPLOAD_SECONDS,
  });
  await db.speakerPresentation.create({
    data: {
      id,
      eventId,
      organizationId,
      speakerId,
      sessionId: slot.sessionId,
      topicId: slot.topicId,
      url,
      filename,
      mimeType: type.mimeType,
      // The size the browser stated, for the quota; replaced by the real one on completion.
      size: BigInt(Math.floor(size)),
      uploadedVia: actor.source,
      uploadedById: actor.userId ?? null,
    },
  });
  apiLogger.info({ msg: "speaker-presentation:upload-started", eventId, speakerId, presentationId: id, ext: type.ext, size, via: upload.via, source: actor.source });
  return { ok: true, presentationId: id, upload, contentType: type.mimeType, maxBytes };
}

// ── The local provider's upload (development and the test server) ────────────

export type ReceiveFileResult = { ok: true } | { ok: false; code: "NOT_AVAILABLE" | "NOT_FOUND" | "FILE_TOO_LARGE"; message: string };

/**
 * Take the file itself, on the LOCAL provider only: there is no bucket to
 * sign a form for. On S3 this answers NOT_AVAILABLE, so the app can never be
 * made to carry a large body.
 */
export async function receiveLocalPresentationFile(
  input: Pick<SpeakerScope, "eventId" | "speakerId"> & { presentationId: string; bytes: Buffer },
): Promise<ReceiveFileResult> {
  if (storageProvider !== "local") return { ok: false, code: "NOT_AVAILABLE", message: "Not found" };
  const row = await db.speakerPresentation.findFirst({
    where: { id: input.presentationId, eventId: input.eventId, speakerId: input.speakerId, status: "UPLOADING" },
    select: { id: true, url: true, filename: true, mimeType: true },
  });
  if (!row) return { ok: false, code: "NOT_FOUND", message: "Upload not found" };
  const type = presentationTypeFor(row.filename);
  if (!type || input.bytes.length > PRESENTATION_MAX_BYTES[type.kind]) {
    return { ok: false, code: "FILE_TOO_LARGE", message: "That file is too large." };
  }
  await uploadFile(input.bytes, `${row.id}.${type.ext}`, row.mimeType, `${UPLOAD_SEGMENT.presentations}/${input.eventId}/${input.speakerId}`);
  return { ok: true };
}

// ── Completing an upload ─────────────────────────────────────────────────────

export type CompleteUploadErrorCode = "NOT_FOUND" | "UPLOAD_NOT_FOUND" | "FILE_TOO_LARGE" | "SIGNATURE_MISMATCH";

export type CompleteUploadResult =
  | { ok: true; presentation: PresentationView }
  | { ok: false; code: CompleteUploadErrorCode; message: string };

export async function completePresentationUpload(
  input: SpeakerScope & { presentationId: string; actor: PresentationActor },
): Promise<CompleteUploadResult> {
  const { eventId, speakerId, presentationId, actor } = input;
  const row = await db.speakerPresentation.findFirst({
    where: { id: presentationId, eventId, speakerId },
    select: { ...VIEW_SELECT, url: true },
  });
  if (!row || row.status === "FAILED" || row.status === "REPLACED") {
    apiLogger.warn({ msg: "speaker-presentation:complete-not-found", eventId, speakerId, presentationId, source: actor.source });
    return { ok: false, code: "NOT_FOUND", message: "Upload not found" };
  }
  // A second call (a retried request) answers as the first did.
  if (row.status === "READY") return { ok: true, presentation: toView(row) };

  const type = presentationTypeFor(row.filename);
  const head = await headStoredFile(row.url, PREFIX);
  if (!head || !type) {
    apiLogger.warn({ msg: "speaker-presentation:object-missing", eventId, speakerId, presentationId, source: actor.source });
    return { ok: false, code: "UPLOAD_NOT_FOUND", message: "The file did not arrive. Try the upload again." };
  }

  const fail = async (code: "FILE_TOO_LARGE" | "SIGNATURE_MISMATCH", message: string): Promise<CompleteUploadResult> => {
    await db.speakerPresentation.updateMany({ where: { id: presentationId, status: "UPLOADING" }, data: { status: "FAILED" } });
    await deleteStoredFile(row.url, PREFIX);
    apiLogger.warn({ msg: "speaker-presentation:rejected", code, eventId, speakerId, presentationId, ext: type.ext, size: head.size, source: actor.source });
    return { ok: false, code, message };
  };

  // S3's own policy already refuses a larger file; this is the same rule for the local provider.
  if (head.size > PRESENTATION_MAX_BYTES[type.kind]) return fail("FILE_TOO_LARGE", "That file is too large.");
  // The version just measured is the one read, recorded and served from here on.
  const start = await readStoredFileStart(row.url, PREFIX, PRESENTATION_SIGNATURE_BYTES, head.versionId);
  if (!presentationSignatureMatches(type.ext, start)) {
    return fail("SIGNATURE_MISMATCH", `That file is not a real .${type.ext} file. Export it again and upload the new copy.`);
  }

  // One file per talk: the file this one replaces steps aside, in the same
  // transaction that makes this one READY.
  const replaced = await tenantTransaction(async (tx) => {
    const older = await tx.speakerPresentation.findMany({
      where: { eventId, speakerId, sessionId: row.sessionId, topicId: row.topicId, status: "READY", id: { not: presentationId } },
      select: { id: true, url: true },
    });
    if (older.length > 0) {
      await tx.speakerPresentation.updateMany({ where: { id: { in: older.map((o) => o.id) } }, data: { status: "REPLACED" } });
    }
    await tx.speakerPresentation.update({
      where: { id: presentationId },
      data: { status: "READY", size: BigInt(head.size), s3VersionId: head.versionId, etag: head.etag, readyAt: new Date() },
    });
    return older;
  });
  // After the commit, best effort: on a versioned bucket this hides the old
  // object; the bucket's lifecycle rule is what finally removes it.
  await Promise.all(replaced.map((o) => deleteStoredFile(o.url, PREFIX)));

  const ready = await db.speakerPresentation.findUniqueOrThrow({ where: { id: presentationId }, select: VIEW_SELECT });
  audit(input, actor, "CREATE", presentationId, { filename: row.filename, size: head.size, slot: presentationSlotKey(row), replaced: replaced.length });
  apiLogger.info({ msg: "speaker-presentation:ready", eventId, speakerId, presentationId, ext: type.ext, size: head.size, replaced: replaced.length, source: actor.source });
  return { ok: true, presentation: toView(ready) };
}

// ── Reading and removing ─────────────────────────────────────────────────────

export type PresentationDownload =
  | { ok: true; redirectUrl: string }
  /** The local provider: the caller streams the (small) file itself. */
  | { ok: true; local: { storedPath: string; requirePrefix: string; filename: string; mimeType: string } }
  | { ok: false; code: "NOT_FOUND"; message: string };

export async function presentationDownload(
  input: Pick<SpeakerScope, "eventId" | "speakerId"> & { presentationId: string },
): Promise<PresentationDownload> {
  const row = await db.speakerPresentation.findFirst({
    where: { id: input.presentationId, eventId: input.eventId, speakerId: input.speakerId, status: "READY" },
    select: { url: true, filename: true, mimeType: true, s3VersionId: true },
  });
  if (!row) return { ok: false, code: "NOT_FOUND", message: "Presentation not found" };
  const filename = truncateFilename(row.filename) || "presentation";
  const redirectUrl = await signStoredFileDownload({
    storedPath: row.url,
    requirePrefix: PREFIX,
    versionId: row.s3VersionId,
    expiresSeconds: PRESENTATION_DOWNLOAD_SECONDS,
    contentDisposition: contentDisposition(filename, "attachment"),
    contentType: row.mimeType,
  });
  if (redirectUrl) return { ok: true, redirectUrl };
  return { ok: true, local: { storedPath: row.url, requirePrefix: PREFIX, filename, mimeType: row.mimeType } };
}

export type DeletePresentationResult = { ok: true } | { ok: false; code: "NOT_FOUND"; message: string };

/** Staff only: remove a file that should not be there. The row goes; the object is hidden (see above). */
export async function deleteSpeakerPresentation(
  input: SpeakerScope & { presentationId: string; actor: PresentationActor },
): Promise<DeletePresentationResult> {
  const row = await db.speakerPresentation.findFirst({
    where: { id: input.presentationId, eventId: input.eventId, speakerId: input.speakerId },
    select: { id: true, url: true, filename: true, sessionId: true, topicId: true },
  });
  if (!row) return { ok: false, code: "NOT_FOUND", message: "Presentation not found" };
  await db.speakerPresentation.delete({ where: { id: row.id } });
  await deleteStoredFile(row.url, PREFIX);
  audit(input, input.actor, "DELETE", row.id, { filename: row.filename, slot: presentationSlotKey(row) });
  apiLogger.info({ msg: "speaker-presentation:deleted", eventId: input.eventId, speakerId: input.speakerId, presentationId: row.id, source: input.actor.source });
  return { ok: true };
}
