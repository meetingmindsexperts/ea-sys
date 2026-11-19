/**
 * Speaker presentations: the rules both the server and the screens read
 * (Nov 19, 2026; docs/SPEAKER_PRESENTATIONS_PLAN.md).
 *
 * A speaker gives us slides or a video for a talk. The file goes from the
 * browser straight to storage, so these rules are checked twice on the
 * server: the type and size when the upload is allowed, and the file's own
 * signature once it has landed.
 *
 * CLIENT-SAFE: no Node built-ins and no server imports (the public speaker
 * form is a client component and imports this).
 */

export type PresentationKind = "slides" | "video";

export interface PresentationType {
  ext: string;
  /** Decided here from the extension. A browser's stated type is not trusted,
   *  and is often empty for .key and .pptx. */
  mimeType: string;
  kind: PresentationKind;
  label: string;
}

/** Owner, Nov 19, 2026: PPT, PDF or video. */
export const PRESENTATION_TYPES: readonly PresentationType[] = [
  { ext: "pdf", mimeType: "application/pdf", kind: "slides", label: "PDF" },
  { ext: "pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "slides", label: "PowerPoint" },
  { ext: "ppt", mimeType: "application/vnd.ms-powerpoint", kind: "slides", label: "PowerPoint (older)" },
  { ext: "key", mimeType: "application/vnd.apple.keynote", kind: "slides", label: "Keynote" },
  { ext: "mp4", mimeType: "video/mp4", kind: "video", label: "MP4 video" },
  { ext: "mov", mimeType: "video/quicktime", kind: "video", label: "QuickTime video" },
];

const MB = 1024 * 1024;

/**
 * Owner, Nov 19, 2026: 200 MB for slides and 500 MB for video. Video rises
 * when resumable uploads are built (plan phase 4): one 2 GB upload over hotel
 * Wi-Fi fails as a whole.
 */
export const PRESENTATION_MAX_BYTES: Record<PresentationKind, number> = {
  slides: 200 * MB,
  video: 500 * MB,
};

/**
 * How many files one talk can hold (owner, Nov 19, 2026: "can they upload
 * multiple if needed?"): slides and a separate video, or a deck and a backup
 * PDF. An upload adds a file beside the others, or replaces one of them.
 */
export const PRESENTATION_MAX_FILES_PER_TALK = 3;

/**
 * A rate limit alone lets a leaked link store tens of gigabytes an hour, so a
 * speaker's files are bounded too: this many kept (ready or uploading), and
 * this many bytes.
 */
export const PRESENTATION_MAX_FILES_PER_SPEAKER = 20;
export const PRESENTATION_MAX_BYTES_PER_SPEAKER = 3 * 1024 * MB;

/**
 * How long a signed upload is good for. Two hours, not minutes: 500 MB takes
 * over 15 minutes below about 4.4 Mbit/s, and whether S3 judges a POST
 * policy's expiry when the request starts or when the body has arrived is not
 * documented (review of be777c01). The policy is for one key, one type and
 * one exact size, and the version that is checked is pinned, so a long life
 * gives a holder nothing more.
 */
export const PRESENTATION_UPLOAD_SECONDS = 2 * 60 * 60;
/** How long a signed download is good for. */
export const PRESENTATION_DOWNLOAD_SECONDS = 5 * 60;
/**
 * An upload never finished is cleared after this long. Longer than the signed
 * upload's life, so one still in flight is never cleared under it.
 */
export const PRESENTATION_STALE_UPLOAD_MS = 3 * 60 * 60 * 1000;

/** For a file input's `accept`. */
export const PRESENTATION_ACCEPT = PRESENTATION_TYPES.map((t) => `.${t.ext}`).join(",");

/** "PDF, PowerPoint (.pptx, .ppt), Keynote, or a video (.mp4, .mov)". */
export const PRESENTATION_TYPES_TEXT = "PDF, PowerPoint (.pptx or .ppt), Keynote (.key), or a video (.mp4 or .mov)";

export function presentationExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

/** The type a file name stands for, or null when it is not one we take. */
export function presentationTypeFor(filename: string): PresentationType | null {
  const ext = presentationExtension(filename);
  return PRESENTATION_TYPES.find((t) => t.ext === ext) ?? null;
}

export type PresentationRefusal = { code: "TYPE_NOT_ALLOWED" | "FILE_TOO_LARGE" | "FILE_EMPTY"; message: string };

/** The check made before an upload is allowed. The server's answer; the screens say it early. */
export function presentationFileProblem(filename: string, size: number): PresentationRefusal | null {
  const type = presentationTypeFor(filename);
  if (!type) return { code: "TYPE_NOT_ALLOWED", message: `That file type is not accepted. Upload ${PRESENTATION_TYPES_TEXT}.` };
  if (!Number.isFinite(size) || size <= 0) return { code: "FILE_EMPTY", message: "That file is empty." };
  const max = PRESENTATION_MAX_BYTES[type.kind];
  if (size > max) {
    return { code: "FILE_TOO_LARGE", message: `That file is too large: ${type.kind === "video" ? "a video" : "slides"} can be up to ${Math.round(max / MB)} MB.` };
  }
  return null;
}

const startsWith = (bytes: Uint8Array, sig: number[], at = 0) => bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b);
const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** QuickTime's classic top-level atoms: an older .mov starts with one of these, with no `ftyp`. */
const QUICKTIME_ATOMS = ["ftyp", "moov", "mdat", "wide", "free", "skip"];

/** How many leading bytes `presentationSignatureMatches` needs. */
export const PRESENTATION_SIGNATURE_BYTES = 16;

/**
 * Whether a file's first bytes are what its extension says.
 *
 * For .pptx and .key this proves a zip and no more (a renamed .docx would
 * pass): good enough to refuse an executable or a text file under a slide's
 * name, which is the point, and the type shown stays the extension's.
 */
export function presentationSignatureMatches(ext: string, bytes: Uint8Array): boolean {
  switch (ext) {
    case "pdf":
      return startsWith(bytes, ascii("%PDF-"));
    case "pptx":
      // A zip; or OLE2 when the deck is password-protected (Office wraps an
      // encrypted .pptx in a compound file).
      return startsWith(bytes, ZIP) || startsWith(bytes, OLE2);
    case "key":
      return startsWith(bytes, ZIP);
    case "ppt":
      // Legacy PowerPoint is an OLE2 compound file, not a zip.
      return startsWith(bytes, OLE2);
    case "mp4":
      return startsWith(bytes, ascii("ftyp"), 4);
    case "mov":
      return QUICKTIME_ATOMS.some((atom) => startsWith(bytes, ascii(atom), 4));
    default:
      return false;
  }
}

/**
 * A talk a speaker can upload files for (up to
 * `PRESENTATION_MAX_FILES_PER_TALK` each): each topic they are on, each
 * session they present in without a topic, or, while they are on no talk
 * yet, one general slot.
 */
export interface PresentationSlot {
  /** `topic:{id}`, `session:{id}` or `general`. */
  key: string;
  sessionId: string | null;
  topicId: string | null;
  /** The topic's title, the session's name, or "Your presentation". */
  title: string;
  /** The session the talk is in; empty for the general slot. */
  sessionName: string;
  startTime: string | null;
}

export const GENERAL_PRESENTATION_SLOT = "general";

export function presentationSlotKey(slot: { sessionId: string | null; topicId: string | null }): string {
  if (slot.topicId) return `topic:${slot.topicId}`;
  if (slot.sessionId) return `session:${slot.sessionId}`;
  return GENERAL_PRESENTATION_SLOT;
}

/** What the screens show for one file. `size` is a number here: BigInt stops at the JSON edge. */
export interface PresentationView {
  id: string;
  slotKey: string;
  filename: string;
  kind: PresentationKind | null;
  size: number | null;
  status: "UPLOADING" | "READY" | "FAILED" | "REPLACED";
  uploadedVia: string;
  createdAt: string;
  readyAt: string | null;
}

export function formatPresentationSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}
