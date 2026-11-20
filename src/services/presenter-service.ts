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
import { bulkUpdateRegistrations, MAX_BULK_REGISTRATION_UPDATES } from "@/services/registration-bulk-service";

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
      skipped: { abstractId: string; part: string; code: string; message: string }[];
      /** Accepted, and the author holds no live registration on the event. */
      noRegistration: string[];
      /** The author is invited faculty (on the Faculty type): left exactly as it is. */
      faculty: string[];
      /** Made Complimentary, and the badge type someone had set was kept. */
      badgeKept: { abstractId: string; badgeType: string }[];
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

    // The preset's two own answers are not failures: they are said in their own words.
    const facultySkips = result.skipped.filter((s) => s.code === "FACULTY");
    const badgeSkips = result.skipped.filter((s) => s.code === "BADGE_KEPT");
    const refusals = result.skipped.filter((s) => s.code !== "FACULTY" && s.code !== "BADGE_KEPT");
    const refused = new Set(refusals.map((s) => s.registrationId));
    return {
      ok: true,
      // A row whose payment status was refused is reported as skipped, not made.
      made: abstractsOf(result.changed.filter((id) => !refused.has(id))),
      already: abstractsOf(result.unchanged),
      skipped: refusals.flatMap((s) =>
        (abstractsByRegistration.get(s.registrationId) ?? []).map((abstractId) => ({ abstractId, part: s.part, code: s.code, message: s.message })),
      ),
      noRegistration,
      faculty: abstractsOf(facultySkips.map((s) => s.registrationId)),
      badgeKept: badgeSkips.flatMap((s) =>
        (abstractsByRegistration.get(s.registrationId) ?? []).map((abstractId) => ({ abstractId, badgeType: s.badgeType ?? "" })),
      ),
      notAccepted,
      remaining: abstractsOf(result.remaining),
    };
  } catch (err) {
    apiLogger.error({ err, msg: "make-presenters:failed", eventId });
    return { ok: false, code: "UNKNOWN", message: "The registrations could not be changed." };
  }
}
