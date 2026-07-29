/**
 * Reference-checked photo-file cleanup — the fix for INC-004 (July 24, 2026:
 * 27 photo files destroyed on prod by a bulk entity cleanup).
 *
 * Photo PATHS are deliberately shared across rows: `syncToContact` copies a
 * speaker/attendee photo URL onto the org Contact, and every import flow
 * (registrations→speakers, contacts→registrations, EventsAir, companions)
 * carries the same `/uploads/photos/...` string onto the rows it creates.
 * The entity DELETE routes have unlinked `*.photo` from disk since March
 * 2026 — so deleting ONE row (e.g. cleaning up a duplicate import) destroyed
 * the file that its SIBLING rows still pointed at, and every surviving
 * speaker/attendee/contact with that path 404'd from then on.
 *
 * The rule now: the file is unlinked only when NO row in any photo-bearing
 * table (Attendee, Speaker, Contact — the three `photo` columns in the
 * schema) still references the URL. Callers run this AFTER their own delete
 * committed, so the deleted row no longer counts. Same shape as the
 * media-library's `findMediaReferences` guard, for the photos store.
 *
 * Never throws — cleanup is best-effort hygiene and must not turn a
 * committed delete into a user-facing failure. A skipped unlink is logged;
 * a leaked orphan file costs a few hundred KB and is mirrored to DR anyway,
 * while a wrongly-deleted shared file is data loss (INC-004's lesson).
 */
import { db } from "@/lib/db";
import { deletePhoto } from "@/lib/storage";
import { apiLogger } from "@/lib/logger";

export async function deletePhotoIfUnreferenced(url: string): Promise<void> {
  try {
    const [attendees, speakers, contacts] = await Promise.all([
      db.attendee.count({ where: { photo: url } }),
      db.speaker.count({ where: { photo: url } }),
      db.contact.count({ where: { photo: url } }),
    ]);
    const references = attendees + speakers + contacts;
    if (references > 0) {
      apiLogger.info({
        msg: "photo-cleanup:still-referenced",
        photo: url,
        references,
        attendees,
        speakers,
        contacts,
      });
      return;
    }
    await deletePhoto(url);
  } catch (err) {
    apiLogger.warn({ msg: "photo-cleanup:failed", photo: url, err });
  }
}
