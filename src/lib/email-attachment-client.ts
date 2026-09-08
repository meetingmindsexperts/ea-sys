/**
 * Browser-side half of email attachments (Sep 8, 2026): upload each picked
 * file to POST /api/events/[eventId]/email-attachments (multipart, so it gets
 * the upload body ceiling on its own) and hand back the storage REFERENCES
 * the send body carries. Never base64 in a JSON body again: that path was
 * capped at 1 MB by the middleware while the picker advertised 10.
 *
 * Client-safe: fetch + FormData only, no Node imports. Throws with the
 * server's own message so the caller's existing catch → toast shows it.
 */
import type { StoredAttachmentRef } from "./email-attachment-limits";

export async function uploadEmailAttachments(eventId: string, files: File[]): Promise<StoredAttachmentRef[]> {
  const refs: StoredAttachmentRef[] = [];
  for (const file of files) {
    const body = new FormData();
    body.append("file", file);
    const res = await fetch(`/api/events/${eventId}/email-attachments`, { method: "POST", body });
    const json = (await res.json().catch(() => null)) as
      | (StoredAttachmentRef & { size?: number })
      | { error?: string }
      | null;
    if (!res.ok || !json || !("storedPath" in json)) {
      const message = json && "error" in json && json.error ? json.error : `Failed to upload "${file.name}".`;
      throw new Error(message);
    }
    refs.push({ storedPath: json.storedPath, name: json.name, contentType: json.contentType });
  }
  return refs;
}
