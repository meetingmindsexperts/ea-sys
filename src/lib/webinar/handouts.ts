/**
 * Webinar handouts (Oct 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md §4): files
 * the producer attaches for the webinar's attendees (slides, a PDF, a reading
 * list). Owner decisions: private files, opened only by a signed-in
 * registrant of that webinar; PDF, PPTX and DOCX up to 8 MB each (under the
 * box's 10 MB nginx upload limit).
 *
 * Stored in `settings.webinar.handouts`, in display order; the bytes live
 * under the private `webinar-handouts/{eventId}/` prefix. Client-safe: pure
 * constants and helpers only, shared by the console, the routes and the
 * attendee card.
 */

export interface WebinarHandout {
  id: string;
  /** Display name, sanitised, with its extension. */
  name: string;
  /** `/uploads/webinar-handouts/{eventId}/…`; never sent to attendees. */
  storedPath: string;
  contentType: string;
  size: number;
  uploadedAt: string;
}

/** What an attendee's list carries: no storage path. */
export type PublicHandout = Pick<WebinarHandout, "id" | "name" | "contentType" | "size">;

export const MAX_HANDOUTS = 10;
export const MAX_HANDOUT_BYTES = 8 * 1024 * 1024;
export const MAX_HANDOUT_MB = 8;

/** contentType -> extension, also the allow-list. */
export const HANDOUT_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

export const HANDOUT_ACCEPT = ".pdf,.pptx,.docx," + Object.keys(HANDOUT_TYPES).join(",");

const EXT_TO_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(HANDOUT_TYPES).map(([type, ext]) => [ext, type]),
);

/**
 * The type to store for a picked file, from its extension (some systems report
 * an empty or generic type for Office files). Null when not allowed.
 */
export function resolveHandoutType(file: { name: string; type: string }): string | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const byExt = EXT_TO_TYPE[ext];
  if (!byExt) return null;
  // A reported type that names a different allowed type is a mismatch.
  if (file.type && HANDOUT_TYPES[file.type] && file.type !== byExt) return null;
  return byExt;
}

const MAGIC: Record<string, number[]> = {
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d], // "%PDF-"
  // PPTX and DOCX are ZIP containers.
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [0x50, 0x4b, 0x03, 0x04],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [0x50, 0x4b, 0x03, 0x04],
};

/** The file's first bytes match its type, so a renamed file cannot pass. */
export function handoutBytesMatch(bytes: Uint8Array, contentType: string): boolean {
  const magic = MAGIC[contentType];
  if (!magic || bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

/** Display name only: no path, no control or quote characters, the right extension, capped. */
export function sanitizeHandoutName(name: string, contentType: string): string {
  const ext = HANDOUT_TYPES[contentType] ?? "bin";
  const base = (name.split(/[\\/]/).pop() ?? "")
    .replace(/[\u0000-\u001f\u007f"<>]/g, "")
    .replace(/\.[^.]*$/, "")
    .trim()
    .slice(0, 150);
  return `${base || "handout"}.${ext}`;
}

/** The handouts in settings, ignoring anything malformed. */
export function readHandouts(webinar: { handouts?: unknown } | null | undefined): WebinarHandout[] {
  const list = webinar?.handouts;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (h): h is WebinarHandout =>
      !!h &&
      typeof h === "object" &&
      typeof (h as WebinarHandout).id === "string" &&
      typeof (h as WebinarHandout).name === "string" &&
      typeof (h as WebinarHandout).storedPath === "string" &&
      typeof (h as WebinarHandout).contentType === "string" &&
      typeof (h as WebinarHandout).size === "number",
  );
}

export function toPublicHandout(h: WebinarHandout): PublicHandout {
  return { id: h.id, name: h.name, contentType: h.contentType, size: h.size };
}

export function formatHandoutSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The general event-settings save (event PUT) replaces `settings.webinar`
 * wholesale when a caller sends it. Handouts are written only by the handouts
 * routes, so that save keeps the stored list whatever it was sent: a caller
 * can neither wipe it (orphaning the files) nor plant an entry pointing at
 * another event's file (review of handouts, Oct 6, 2026).
 */
export function keepStoredHandouts(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const nextWebinar = next.webinar;
  if (!nextWebinar || typeof nextWebinar !== "object" || Array.isArray(nextWebinar)) return next;
  const curWebinar = current.webinar && typeof current.webinar === "object" ? (current.webinar as { handouts?: unknown }) : {};
  const { handouts: _sent, ...rest } = nextWebinar as Record<string, unknown>;
  void _sent;
  return {
    ...next,
    webinar: curWebinar.handouts !== undefined ? { ...rest, handouts: curWebinar.handouts } : rest,
  };
}
