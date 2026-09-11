/**
 * {{rsvpLink}} for ONE person (Sep 11, 2026).
 *
 * The bulk pipeline resolves the token from the RSVP the organiser picks in
 * the send dialog; the RSVP console resolves it from the invite it is mailing.
 * The per-registration and per-speaker single sends had neither, so a saved
 * template carrying {{rsvpLink}} went out with the literal token in the body
 * (organiser report, OOPVF2026, the day before the forum). Those two sends now
 * resolve it here, from the invite the person already holds on this event.
 *
 * Nothing is minted: a person with no invite is a refusal the organiser can
 * act on (add them on the console, or send from Communications), never a
 * blank link and never an auto-invite. That is the bulk pipeline's rule too.
 */
import { db } from "@/lib/db";

const RSVP_LINK_TOKEN = /\{\{rsvpLink\}\}/;

/** True when any part carries the token exactly as renderTemplate matches it. */
export function templateUsesRsvpLink(...parts: Array<string | null | undefined>): boolean {
  return parts.some((p) => typeof p === "string" && RSVP_LINK_TOKEN.test(p));
}

export type RsvpLinkResolution =
  | { ok: true; rsvpLink: string; rsvpName: string; campaignId: string }
  | {
      ok: false;
      code: "NO_INVITE" | "CLOSED" | "AMBIGUOUS";
      message: string;
      campaignNames: string[];
    };

export interface ResolveRsvpLinkInput {
  eventId: string;
  eventSlug: string;
  email: string;
  registrationId?: string | null;
  speakerId?: string | null;
}

function publicAppUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/$/, "");
}

/**
 * The person's own link on this event. Matches the invite by the normalised
 * email (the invite's unique key) and, when known, by the registration or
 * speaker id the invite was imported from. Exactly one OPEN RSVP resolves;
 * several open ones cannot be chosen between here (that is what the bulk
 * dialog's picker is for); only closed ones or none is a refusal too.
 */
export async function resolveRsvpLinkForPerson(input: ResolveRsvpLinkInput): Promise<RsvpLinkResolution> {
  const email = input.email.trim();
  const or: Array<Record<string, unknown>> = [{ inviteeEmail: { equals: email, mode: "insensitive" } }];
  if (input.registrationId) or.push({ registrationId: input.registrationId });
  if (input.speakerId) or.push({ speakerId: input.speakerId });

  const invites = await db.rsvpInvite.findMany({
    where: { eventId: input.eventId, OR: or },
    select: { token: true, campaign: { select: { id: true, name: true, isActive: true } } },
    orderBy: { createdAt: "asc" },
  });

  // One invite per campaign; the email arm and the id arms can match the same row.
  const byCampaign = new Map<string, (typeof invites)[number]>();
  for (const inv of invites) if (!byCampaign.has(inv.campaign.id)) byCampaign.set(inv.campaign.id, inv);
  const all = [...byCampaign.values()];
  const open = all.filter((i) => i.campaign.isActive);

  if (open.length === 1) {
    const inv = open[0];
    return {
      ok: true,
      rsvpLink: `${publicAppUrl()}/e/${input.eventSlug}/rsvp/${inv.token}`,
      rsvpName: inv.campaign.name,
      campaignId: inv.campaign.id,
    };
  }
  if (open.length > 1) {
    const names = open.map((i) => i.campaign.name);
    return {
      ok: false,
      code: "AMBIGUOUS",
      campaignNames: names,
      message:
        `This template uses {{rsvpLink}}, but this person is invited to more than one open RSVP (${names.map((n) => `"${n}"`).join(", ")}). ` +
        "Send it from Communications, where you pick which RSVP the link is for.",
    };
  }
  if (all.length > 0) {
    const names = all.map((i) => i.campaign.name);
    return {
      ok: false,
      code: "CLOSED",
      campaignNames: names,
      message:
        `This template uses {{rsvpLink}}, but the only RSVP this person is invited to (${names.map((n) => `"${n}"`).join(", ")}) is closed. ` +
        "Reopen it on the RSVP console, then send again.",
    };
  }
  return {
    ok: false,
    code: "NO_INVITE",
    campaignNames: [],
    message:
      "This template uses {{rsvpLink}}, but this person is not on any RSVP guest list for the event. " +
      "Add them on the RSVP console (Add invitees or Import), then send again.",
  };
}
