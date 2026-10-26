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
 * Deleting an option people are attending is refused (the items DELETE
 * route), because the cascade would remove their yes and turn them Declined.
 *
 * Client-safe (no imports): rsvp.ts pulls in crypto. rsvp.ts re-exports
 * isAttendingAny from here, so the rule lives once.
 */

export type RsvpAnswer = "PENDING" | "ATTENDING" | "DECLINED";

export interface AnswerableInvite {
  status: string;
  respondedAt?: Date | string | null;
  responses: { itemId: string; attending: boolean; guestCount: number }[];
}

/** RESPONDED + attending at least one item. */
export function isAttendingAny(invite: AnswerableInvite): boolean {
  return invite.status === "RESPONDED" && invite.responses.some((r) => r.attending);
}

export function rsvpAnswer(invite: AnswerableInvite): RsvpAnswer {
  if (invite.status !== "RESPONDED") return "PENDING";
  return isAttendingAny(invite) ? "ATTENDING" : "DECLINED";
}

export const RSVP_ANSWER_LABELS: Record<RsvpAnswer, string> = {
  PENDING: "Pending",
  ATTENDING: "Attending",
  DECLINED: "Declined",
};

/** The item fields that decide whether the person was ever asked about it. */
export interface AnswerableItem {
  id: string;
  createdAt?: Date | string | null;
  isActive?: boolean;
  startsAt?: Date | string | null;
  rsvpDeadline?: Date | string | null;
}

const time = (d: Date | string | null | undefined): number | null => (d == null ? null : new Date(d).getTime());

/**
 * Was this item on the form when they last answered? It had to exist, be
 * switched on and still be open (its RSVP deadline, or its start when it has
 * none, the same close rule as the public form). Unknown dates count as
 * offered, so older data reads as before.
 */
function wasOffered(invite: AnswerableInvite, item: AnswerableItem): boolean {
  if (item.isActive === false) return false;
  const answered = time(invite.respondedAt);
  if (answered == null) return true;
  const created = time(item.createdAt);
  if (created != null && created > answered) return false;
  const closes = time(item.rsvpDeadline ?? item.startsAt);
  if (closes != null && closes < answered) return false;
  return true;
}

/**
 * One item's answer: "Yes" when attending; "No" when they answered and the
 * item was on their form; "" while pending, or for an item they never saw (added
 * after they answered, switched off, or already closed: review of 0ba8d492).
 */
export function rsvpItemAnswer(invite: AnswerableInvite, item: AnswerableItem): "Yes" | "No" | "" {
  if (invite.status !== "RESPONDED") return "";
  if (invite.responses.some((r) => r.itemId === item.id && r.attending)) return "Yes";
  return wasOffered(invite, item) ? "No" : "";
}
