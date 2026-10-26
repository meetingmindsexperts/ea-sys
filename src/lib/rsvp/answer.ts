/**
 * What an invitee answered, as the roster and the CSV show it (Oct 26, 2026).
 *
 * The public form stores a row only for the items someone is ATTENDING
 * (rsvp/[token] route), so a "No" is an invite marked RESPONDED with no
 * attending row. The roster used to show that as "Responded" with a dash,
 * exactly like someone who has not answered, and the CSV wrote "No" for every
 * item of a PENDING invite. One reading, used by both:
 *  - PENDING: has not answered; per item: blank.
 *  - ATTENDING: answered yes to at least one item; per item: Yes / No.
 *  - DECLINED: answered, yes to nothing; per item: No.
 *
 * Client-safe (no imports): rsvp.ts pulls in crypto.
 */

export type RsvpAnswer = "PENDING" | "ATTENDING" | "DECLINED";

export interface AnswerableInvite {
  status: string;
  responses: { itemId: string; attending: boolean; guestCount: number }[];
}

export function rsvpAnswer(invite: AnswerableInvite): RsvpAnswer {
  if (invite.status !== "RESPONDED") return "PENDING";
  return invite.responses.some((r) => r.attending) ? "ATTENDING" : "DECLINED";
}

export const RSVP_ANSWER_LABELS: Record<RsvpAnswer, string> = {
  PENDING: "Pending",
  ATTENDING: "Attending",
  DECLINED: "Declined",
};

/** One item's answer: "Yes" / "No" once answered, "" while pending. */
export function rsvpItemAnswer(invite: AnswerableInvite, itemId: string): "Yes" | "No" | "" {
  if (invite.status !== "RESPONDED") return "";
  return invite.responses.some((r) => r.itemId === itemId && r.attending) ? "Yes" : "No";
}
