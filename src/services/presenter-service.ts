/**
 * "Make presenters" from the abstracts side (owner, Nov 20, 2026; plan
 * docs/ABSTRACT_AUTHOR_REGISTRATION_PLAN.md step 4, decision A1): when an
 * organiser accepts an abstract they may make the author's registration
 * Complimentary, with a Presenter badge, then and there.
 *
 * NOTHING NEW HAPPENS HERE. It finds each ACCEPTED abstract's author's live
 * registration and runs the general bulk action on those rows
 * (registration-bulk-service.ts), the same one the Registrations page runs:
 * a registration with money on it, a sponsor-paid one and a group member keep
 * their payment status and are named. Only an accepted abstract's author is
 * touched, so this is never a way to make anyone else free.
 *
 * The presenter rules themselves (an author on the Faculty type is left as
 * they are; a badge type set by hand is kept) are the bulk action's
 * "presenters" preset, so the Registrations page follows the same ones.
 *
 * Errors as values; never imports next/server.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { loadLiveRegistrationOf } from "@/lib/author-facts-server";
import { bulkUpdateRegistrations, isPresetAnswer, MAX_BULK_REGISTRATION_UPDATES } from "@/services/registration-bulk-service";

export interface MakePresentersInput {
  eventId: string;
  organizationId: string;
  actorUserId: string;
  abstractIds: string[];
  source: "rest" | "mcp" | "agent";
  requestIp?: string | null;
}

export type MakePresentersResult =
  | {
      ok: true;
      /** Abstracts whose author's registration is now Complimentary with the badge. */
      made: string[];
      /** Already Complimentary with the badge. */
      already: string[];
      /** The author's registration was left as it is, or only given the badge: why. */
      skipped: { abstractId: string; part: string; code: string; message: string; badgeKept?: string }[];
      /** Accepted, and the author holds no live registration on the event. */
      noRegistration: string[];
      /** The author is invited faculty (on the Faculty type): left exactly as it is. */
      faculty: string[];
      /** Made Complimentary, and the badge type someone had set was kept. */
      badgeKept: { abstractId: string; badgeType: string; made: boolean }[];
      /** Not accepted (or not on the event): nothing is done for these. */
      notAccepted: string[];
      /** Not reached in the time one call may take: send these again. */
      remaining: string[];
    }
  | { ok: false; code: "NOTHING_TO_CHANGE" | "TOO_MANY" | "UNKNOWN"; message: string };

export async function makePresenters(input: MakePresentersInput): Promise<MakePresentersResult> {
  const { eventId } = input;
  try {
    const ids = [...new Set(input.abstractIds)];
    if (ids.length === 0) return { ok: false, code: "NOTHING_TO_CHANGE", message: "Choose abstracts." };
    if (ids.length > MAX_BULK_REGISTRATION_UPDATES) {
      return { ok: false, code: "TOO_MANY", message: `Up to ${MAX_BULK_REGISTRATION_UPDATES} abstracts at a time.` };
    }

    const [accepted, liveRegistrationOf] = await Promise.all([
      db.abstract.findMany({
        where: { id: { in: ids }, eventId, status: "ACCEPTED" },
        select: { id: true, speaker: { select: { email: true, sourceRegistrationId: true } } },
      }),
      loadLiveRegistrationOf(eventId),
    ]);
    const acceptedIds = new Set(accepted.map((a) => a.id));
    const notAccepted = ids.filter((id) => !acceptedIds.has(id));

    // One author can hold several accepted abstracts: one registration, every abstract answered.
    const abstractsByRegistration = new Map<string, string[]>();
    const noRegistration: string[] = [];
    for (const a of accepted) {
      const registrationId = a.speaker ? liveRegistrationOf(a.speaker) : null;
      if (!registrationId) {
        noRegistration.push(a.id);
        continue;
      }
      abstractsByRegistration.set(registrationId, [...(abstractsByRegistration.get(registrationId) ?? []), a.id]);
    }
    const abstractsOf = (registrationIds: string[]) => registrationIds.flatMap((id) => abstractsByRegistration.get(id) ?? []);

    if (noRegistration.length > 0) {
      // The organiser is told in the answer; the line is for whoever reads the log later.
      apiLogger.warn({ msg: "make-presenters:no-registration", eventId, abstractIds: noRegistration });
    }
    const registrationIds = [...abstractsByRegistration.keys()];
    if (registrationIds.length === 0) {
      return { ok: true, made: [], already: [], skipped: [], noRegistration, faculty: [], badgeKept: [], notAccepted, remaining: [] };
    }

    const result = await bulkUpdateRegistrations({
      eventId,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      registrationIds,
      preset: "presenters",
      source: input.source,
      requestIp: input.requestIp ?? null,
    });
    if (!result.ok) return result;

    // Each registration is answered ONCE (review of 8eaa3550, MED: a paid row
    // with a kept badge was reported as "Made Complimentary" and as left
    // alone, both at once). In this order: on Faculty; refused in any part;
    // a kept badge; made; already as it should be.
    const changed = new Set(result.changed);
    const faculty = new Set(result.skipped.filter((s) => s.code === "FACULTY").map((s) => s.registrationId));
    const keptBadgeOf = new Map(result.skipped.filter((s) => s.code === "BADGE_KEPT").map((s) => [s.registrationId, s.badgeType ?? ""]));
    const refusals = result.skipped.filter((s) => !isPresetAnswer(s.code));
    const refused = new Set(refusals.map((s) => s.registrationId));
    const settled = (id: string) => !refused.has(id) && !faculty.has(id);
    return {
      ok: true,
      made: abstractsOf(result.changed.filter((id) => settled(id) && !keptBadgeOf.has(id))),
      already: abstractsOf(result.unchanged),
      skipped: refusals.flatMap((s) =>
        (abstractsByRegistration.get(s.registrationId) ?? []).map((abstractId) => ({
          abstractId,
          part: s.part,
          code: s.code,
          message: s.message,
          // The badge was not set either, where one someone chose was kept.
          ...(keptBadgeOf.has(s.registrationId) && { badgeKept: keptBadgeOf.get(s.registrationId) }),
        })),
      ),
      noRegistration,
      faculty: abstractsOf([...faculty]),
      // `made`: its payment status was set to Complimentary now; false: it already was.
      badgeKept: [...keptBadgeOf].filter(([id]) => settled(id)).flatMap(([id, badgeType]) =>
        (abstractsByRegistration.get(id) ?? []).map((abstractId) => ({ abstractId, badgeType, made: changed.has(id) })),
      ),
      notAccepted,
      remaining: abstractsOf(result.remaining),
    };
  } catch (err) {
    apiLogger.error({ err, msg: "make-presenters:failed", eventId });
    return { ok: false, code: "UNKNOWN", message: "The registrations could not be changed." };
  }
}
