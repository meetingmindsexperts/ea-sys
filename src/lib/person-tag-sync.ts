/**
 * Person-level tag sync between a Registration (its Attendee) and the same
 * person's Speaker facet, within one event.
 *
 * Tags live on separate rows (`Attendee.tags`, `Speaker.tags`) with no schema
 * link, so historically a tag added on one facet never showed on the other.
 * These helpers propagate a tag CHANGE (the add/remove delta) to the linked
 * facet, matched by **`Speaker.sourceRegistrationId`** (the explicit link) OR a
 * **shared email** (case-insensitive) within the same event — so the same human
 * carries the same tags whether you tag them as a registrant or as faculty.
 *
 * Design:
 *  - **Delta, not overwrite.** We propagate only what changed (added/removed),
 *    so each facet keeps any tags unique to it and an unrelated save (empty
 *    delta) is a no-op — never a clobber.
 *  - **Best-effort.** A sync failure logs (`person-tag-sync:*`) but never fails
 *    the primary tag update. Call it AFTER the primary write commits.
 *  - **No recursion.** It writes the counterpart row directly (not via the API
 *    routes), so it can't re-trigger itself.
 *
 * Contact tags are intentionally out of scope (a CRM snapshot — decided later).
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

export interface TagDelta {
  added: string[];
  removed: string[];
}

/** Compute the add/remove delta between old and new tag arrays. */
export function computeTagDelta(oldTags: string[], newTags: string[]): TagDelta {
  const oldSet = new Set(oldTags);
  const newSet = new Set(newTags);
  return {
    added: newTags.filter((t) => !oldSet.has(t)),
    removed: oldTags.filter((t) => !newSet.has(t)),
  };
}

/** Apply a delta to a tag array — remove first, then add, dedup, order-stable. */
export function applyTagDelta(current: string[], delta: TagDelta): string[] {
  const rm = new Set(delta.removed);
  const out = current.filter((t) => !rm.has(t));
  const seen = new Set(out);
  for (const t of delta.added) {
    if (!seen.has(t)) {
      out.push(t);
      seen.add(t);
    }
  }
  return out;
}

export function tagDeltaIsEmpty(d: TagDelta): boolean {
  return d.added.length === 0 && d.removed.length === 0;
}

const lc = (s: string) => s.trim().toLowerCase();
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;

export interface RegistrationTagChange {
  registrationId: string;
  email: string;
  delta: TagDelta;
}
export interface SpeakerTagChange {
  speakerId: string;
  email: string;
  sourceRegistrationId: string | null;
  delta: TagDelta;
}

/**
 * Propagate registration (attendee) tag changes to the person's Speaker facet.
 * Matched by `Speaker.sourceRegistrationId` OR shared email (same event).
 */
export async function syncRegistrationTagsToSpeakers(
  eventId: string,
  changes: RegistrationTagChange[],
): Promise<void> {
  try {
    const active = changes.filter((c) => !tagDeltaIsEmpty(c.delta));
    if (active.length === 0) return;

    const regIds = active.map((c) => c.registrationId);
    const emails = [...new Set(active.map((c) => lc(c.email)).filter(Boolean))];

    const speakers = await db.speaker.findMany({
      where: {
        eventId,
        OR: [
          { sourceRegistrationId: { in: regIds } },
          ...emails.map((e) => ({ email: { equals: e, mode: "insensitive" as const } })),
        ],
      },
      select: { id: true, tags: true, email: true, sourceRegistrationId: true },
    });

    for (const spk of speakers) {
      const matched = active.filter(
        (c) => spk.sourceRegistrationId === c.registrationId || lc(spk.email) === lc(c.email),
      );
      if (matched.length === 0) continue;
      let tags = spk.tags;
      for (const m of matched) tags = applyTagDelta(tags, m.delta);
      if (!sameSet(tags, spk.tags)) {
        await db.speaker.update({ where: { id: spk.id }, data: { tags } });
      }
    }
  } catch (err) {
    apiLogger.warn({ err, eventId, msg: "person-tag-sync:reg-to-speaker-failed" });
  }
}

/**
 * Propagate speaker tag changes to the person's Registration (attendee) facet.
 * Matched by the speaker's `sourceRegistrationId` OR shared email (same event).
 * De-dups by attendee (an attendee can back multiple registrations).
 */
export async function syncSpeakerTagsToRegistrations(
  eventId: string,
  changes: SpeakerTagChange[],
): Promise<void> {
  try {
    const active = changes.filter((c) => !tagDeltaIsEmpty(c.delta));
    if (active.length === 0) return;

    const sourceRegIds = active.map((c) => c.sourceRegistrationId).filter((v): v is string => !!v);
    const emails = [...new Set(active.map((c) => lc(c.email)).filter(Boolean))];

    const regs = await db.registration.findMany({
      where: {
        eventId,
        OR: [
          ...(sourceRegIds.length ? [{ id: { in: sourceRegIds } }] : []),
          ...emails.map((e) => ({ attendee: { email: { equals: e, mode: "insensitive" as const } } })),
        ],
      },
      select: { id: true, attendee: { select: { id: true, tags: true, email: true } } },
    });

    // Aggregate per attendee (shared attendees back multiple registrations).
    const acc = new Map<string, { original: string[]; tags: string[] }>();
    for (const reg of regs) {
      const a = reg.attendee;
      if (!a) continue;
      const matched = active.filter(
        (c) => c.sourceRegistrationId === reg.id || lc(c.email) === lc(a.email),
      );
      if (matched.length === 0) continue;
      const cur = acc.get(a.id) ?? { original: a.tags, tags: a.tags };
      for (const m of matched) cur.tags = applyTagDelta(cur.tags, m.delta);
      acc.set(a.id, cur);
    }

    for (const [attendeeId, { original, tags }] of acc) {
      if (!sameSet(tags, original)) {
        await db.attendee.update({ where: { id: attendeeId }, data: { tags } });
      }
    }
  } catch (err) {
    apiLogger.warn({ err, eventId, msg: "person-tag-sync:speaker-to-reg-failed" });
  }
}
