/**
 * WHAT A DEAL IS FOR, AND WHICH EVENT IT COUNTS UNDER (Nov 12, 2026). Pure.
 *
 * A deal is for an event OR a corporate project (CrmProject), never both and
 * never neither (owner). A corporate project is work that is not an event in
 * EA-SYS: a client's own meeting, an advisory board.
 *
 * A project can be LINKED to an event. That is only ever a correction: someone
 * created a project for something that was already an event or a webinar in
 * the system. From then on its deals count under that event everywhere money
 * or sponsors are counted (owner: "under the event", reversible, nothing is
 * moved): the reports, the board's event filter, the export, the event's
 * Budget revenue, the event's sponsor email. Clearing the link puts them back.
 *
 * So "the deals of event X" is never `where: { eventId: X }`. It is
 * dealsOfEventWhere(X), and a deal's event is attributedEventId(deal). A new
 * surface that counts deals per event asks here, or a linked project's deals
 * silently go missing from it.
 *
 * NOT covered, on purpose: how ONE deal presents itself (the branding of an
 * email sent from that deal, its {{event…}} tokens, its quote's tax rate, its
 * QuickBooks class) still reads the deal's own event. A linked project is a
 * rare correction. (The event's sponsor email DOES reach a linked project's
 * contacts, under the event's branding: they are that event's sponsors now.)
 */
import type { Prisma } from "@prisma/client";

/**
 * The deals that count under one event: its own, and those of a project linked
 * to it.
 *
 * `eventId: null` on the second arm keeps this and attributedEventId saying the
 * same thing about a deal that holds BOTH an event and a project. The service
 * never writes one, but the image before Nov 12, 2026 can after a rollback (it
 * sets an event on a deal without knowing the project column). Such a deal
 * counts under its own event, once, and never also under its project's.
 */
export function dealsOfEventWhere(eventId: string): Prisma.CrmDealWhereInput {
  return { OR: [{ eventId }, { eventId: null, project: { eventId } }] };
}

/** What a deal read must select for attributedEventId. */
export const DEAL_ATTRIBUTION_SELECT = {
  eventId: true,
  projectId: true,
  project: { select: { eventId: true } },
} as const;

/** The event a deal counts under: its own, else its project's linked event, else none. */
export function attributedEventId(deal: { eventId: string | null; project?: { eventId: string | null } | null }): string | null {
  return deal.eventId ?? deal.project?.eventId ?? null;
}

export type DealTargetFail = { ok: false; code: "EVENT_REQUIRED" | "EVENT_AND_PROJECT"; message: string };
export type DealTarget = { ok: true; eventId: string | null; projectId: string | null } | DealTargetFail;

const NEITHER: DealTargetFail = {
  ok: false,
  code: "EVENT_REQUIRED",
  message: "Select the event or the corporate project this deal is for",
};
const BOTH: DealTargetFail = {
  ok: false,
  code: "EVENT_AND_PROJECT",
  message: "A deal is for an event or a corporate project, not both",
};

/**
 * The event and project a deal holds after a write.
 *
 * `undefined` means "not sent", `null` means "clear". Naming one side moves
 * the deal there and clears the other, so a form can switch a deal from an
 * event to a project in one request. Naming both, or ending with neither, is
 * refused. `before` is the stored deal (omit on create).
 */
export function resolveDealTarget(
  input: { eventId?: string | null; projectId?: string | null },
  before?: { eventId: string | null; projectId: string | null },
): DealTarget {
  if (input.eventId && input.projectId) return BOTH;
  if (input.eventId) return { ok: true, eventId: input.eventId, projectId: null };
  if (input.projectId) return { ok: true, eventId: null, projectId: input.projectId };

  const eventId = input.eventId === undefined ? (before?.eventId ?? null) : null;
  const projectId = input.projectId === undefined ? (before?.projectId ?? null) : null;
  // A stored deal holding both (never written by this service) is not made worse here.
  if (!eventId && !projectId) return NEITHER;
  return { ok: true, eventId, projectId };
}
