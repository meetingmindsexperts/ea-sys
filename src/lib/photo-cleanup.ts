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
import { dbOperator, operatorSeesEveryTenant } from "@/lib/db";
import { deletePhoto } from "@/lib/storage";
import { apiLogger } from "@/lib/logger";

export async function deletePhotoIfUnreferenced(url: string): Promise<void> {
  try {
    // Counted across EVERY organisation, on the privileged client (Nov 18,
    // 2026), not through the caller's tenant lane. The photos folder is one
    // folder for everybody, and a photo field is a string a caller supplies:
    // counted inside a lane, another organisation's rows naming the same file
    // are invisible under row security, and counted outside one, all rows are.
    // Either way "nothing references it" would be read off a partial view and
    // the file deleted from under rows that use it (INC-004 again). If the
    // privileged client is itself held by the row policies, nothing can be
    // concluded: leave the file, and say so.
    if (!(await Promise.all(["Attendee", "Speaker", "Contact"].map(operatorSeesEveryTenant))).every(Boolean)) {
      apiLogger.warn({ msg: "photo-cleanup:skipped-cannot-see-every-reference", photo: url });
      return;
    }
    const [attendees, speakers, contacts] = await Promise.all([
      dbOperator.attendee.count({ where: { photo: url } }),
      dbOperator.speaker.count({ where: { photo: url } }),
      dbOperator.contact.count({ where: { photo: url } }),
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
