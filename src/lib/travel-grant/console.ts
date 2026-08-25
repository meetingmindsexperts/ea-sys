/**
 * The organizer console's roster.
 *
 * ## Why this lists people we deliberately did not email (decision D7)
 *
 * Routing is purely the country on the author's profile, and that has two
 * failure directions which are NOT symmetric. An author wrongly classed as
 * overseas is self-correcting: they are asked to tick "I am not a UAE resident"
 * and can simply decline. An author wrongly classed as UAE gets **nothing** --
 * no block, no email, no row -- and has no way to know an offer existed.
 *
 * That second failure is invisible to both sides, so the console shows every
 * abstract author with the country we hold and the verdict we reached. An
 * author who emails saying "I should qualify" then becomes a one-click fix
 * instead of a support conversation.
 *
 * ## The consequence, and the guard it demands
 *
 * This deliberately puts people who must NOT be emailed into the same table as
 * a bulk send button. The remind action therefore keys off
 * `TravelGrant.status = PENDING` on rows that already exist -- see
 * `resolvePending` in travel-grant/send.ts, which is the ONLY implementation of
 * that query -- and never off the rows this function returns. A UAE author has no `TravelGrant` row at all, so a correct
 * implementation cannot reach them; one written against this roster would email
 * every one of them.
 */
import { db } from "@/lib/db";
import { classifyResidency, type ResidencyClass } from "@/lib/travel-grant/eligibility";

export interface TravelGrantRosterRow {
  speakerId: string;
  name: string;
  email: string | null;
  organization: string | null;
  /** The country we hold. Null is the case D4 refuses to guess about. */
  country: string | null;
  residency: ResidencyClass;
  /** How many non-draft abstracts this author has. D2: still one grant. */
  abstractCount: number;
  grant: {
    id: string;
    status: "PENDING" | "CONSENTED" | "DECLINED";
    token: string;
    invitedAt: Date | null;
    submittedAt: Date | null;
    signedName: string | null;
  } | null;
}

/**
 * Every author with a non-draft abstract on this event, deduped to one row per
 * person (D2), joined to their grant if they have one.
 *
 * A draft is not a submission, so draft-only authors are excluded: they have
 * not entered the process and listing them would make the chase list longer
 * than the work.
 */
export async function buildTravelGrantRoster(eventId: string): Promise<TravelGrantRosterRow[]> {
  const [abstracts, grants] = await Promise.all([
    db.abstract.findMany({
      where: { eventId, status: { not: "DRAFT" } },
      select: {
        speaker: {
          select: {
            id: true,
            title: true,
            firstName: true,
            lastName: true,
            email: true,
            organization: true,
            country: true,
          },
        },
      },
    }),
    db.travelGrant.findMany({
      where: { eventId },
      select: {
        id: true,
        speakerId: true,
        status: true,
        token: true,
        invitedAt: true,
        submittedAt: true,
        signedName: true,
        // Selected so a grant-holder with no CURRENT abstract can still be
        // listed. See the union below.
        speaker: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            organization: true,
            country: true,
          },
        },
      },
    }),
  ]);

  const grantBySpeaker = new Map(grants.map((g) => [g.speakerId, g]));
  const bySpeaker = new Map<string, TravelGrantRosterRow>();

  for (const a of abstracts) {
    // Abstract.speakerId is a required FK, so every abstract has an author.
    const sp = a.speaker;
    const existing = bySpeaker.get(sp.id);
    if (existing) {
      existing.abstractCount += 1;
      continue;
    }
    const g = grantBySpeaker.get(sp.id);
    bySpeaker.set(sp.id, {
      speakerId: sp.id,
      name: [sp.firstName, sp.lastName].filter(Boolean).join(" ").trim(),
      email: sp.email ?? null,
      organization: sp.organization ?? null,
      country: sp.country ?? null,
      residency: classifyResidency(sp.country),
      abstractCount: 1,
      grant: g
        ? {
            id: g.id,
            status: g.status as "PENDING" | "CONSENTED" | "DECLINED",
            token: g.token,
            invitedAt: g.invitedAt,
            submittedAt: g.submittedAt,
            signedName: g.signedName,
          }
        : null,
    });
  }

  // A grant can exist for someone with no CURRENT non-draft abstract: the
  // per-row send mints one for a corrected country before they resubmit, and
  // an abstract can later be withdrawn or deleted. Building the roster from
  // abstracts alone would make those rows INVISIBLE, so a person who has
  // already consented could silently disappear from the console. The roster is
  // therefore the union, and a grant is never unlisted.
  for (const g of grants) {
    if (bySpeaker.has(g.speakerId) || !g.speaker) continue;
    bySpeaker.set(g.speakerId, {
      speakerId: g.speakerId,
      name: [g.speaker.firstName, g.speaker.lastName].filter(Boolean).join(" ").trim(),
      email: g.speaker.email ?? null,
      organization: g.speaker.organization ?? null,
      country: g.speaker.country ?? null,
      residency: classifyResidency(g.speaker.country),
      abstractCount: 0,
      grant: {
        id: g.id,
        status: g.status as "PENDING" | "CONSENTED" | "DECLINED",
        token: g.token,
        invitedAt: g.invitedAt,
        submittedAt: g.submittedAt,
        signedName: g.signedName,
      },
    });
  }

  // Consented first (the list an organizer acts on), then still-pending, then
  // everyone else. Alphabetical within each group.
  const rank = (r: TravelGrantRosterRow) =>
    r.grant?.status === "CONSENTED" ? 0 : r.grant?.status === "PENDING" ? 1 : 2;
  return [...bySpeaker.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * One speaker's row, for the card on their profile page.
 *
 * Deliberately NOT `buildTravelGrantRoster(...).find(...)`. The roster is built
 * from abstract authors, so a speaker with no abstract and no grant is simply
 * absent from it -- and the profile card still has to say something about them
 * ("eligible, not invited", or "UAE, not eligible"). Reusing the roster here
 * would render an empty card for exactly the speakers an organizer is most
 * likely to be looking at when they open the profile.
 */
export async function getTravelGrantForSpeaker(
  eventId: string,
  speakerId: string,
): Promise<TravelGrantRosterRow | null> {
  const sp = await db.speaker.findFirst({
    // eventId is load-bearing, not decorative: without it an organizer of event
    // A could read another event's speaker by id, including the grant `token`
    // that the public consent URL is built from.
    where: { id: speakerId, eventId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      organization: true,
      country: true,
      // FILTERED to match the contract on TravelGrantRosterRow.abstractCount and
      // what buildTravelGrantRoster counts. An unfiltered _count includes DRAFTs,
      // so the same person would report a different number depending on which
      // caller asked, and a draft-only author would show "1 abstract" here while
      // being absent from the console entirely.
      _count: { select: { abstracts: { where: { status: { not: "DRAFT" } } } } },
      travelGrant: {
        select: {
          id: true,
          status: true,
          token: true,
          invitedAt: true,
          submittedAt: true,
          signedName: true,
        },
      },
    },
  });
  if (!sp) return null;
  return {
    speakerId: sp.id,
    name: [sp.firstName, sp.lastName].filter(Boolean).join(" ").trim(),
    email: sp.email ?? null,
    organization: sp.organization ?? null,
    country: sp.country ?? null,
    residency: classifyResidency(sp.country),
    abstractCount: sp._count.abstracts,
    grant: sp.travelGrant
      ? {
          id: sp.travelGrant.id,
          status: sp.travelGrant.status as "PENDING" | "CONSENTED" | "DECLINED",
          token: sp.travelGrant.token,
          invitedAt: sp.travelGrant.invitedAt,
          submittedAt: sp.travelGrant.submittedAt,
          signedName: sp.travelGrant.signedName,
        }
      : null,
  };
}
