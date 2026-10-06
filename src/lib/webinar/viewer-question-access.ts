/**
 * Who may use the Q&A box on a webinar's custom-stream page, and which session
 * takes questions. Shared by the ask/list route and the vote route (Oct 6,
 * 2026), so the two can never gate differently.
 *
 * Same gate as the presence heartbeat and zoom-join: signed in, and either a
 * non-cancelled registrant of the event or org staff testing the page. The
 * asker's name comes from the registration, never from the request body.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { isEventOrgStaff } from "@/lib/permissions/org-staff";
import { readWebinarSettings, type WebinarSettings } from "@/lib/webinar";

export type Asker =
  | { kind: "staff"; name: string }
  | { kind: "attendee"; name: string; registrationId: string };

export async function resolveAsker(
  userId: string,
  eventId: string,
  user: { role?: string | null; organizationId?: string | null; firstName?: string | null; lastName?: string | null },
  eventOrgId: string,
): Promise<Asker | null> {
  if (isEventOrgStaff(user, eventOrgId)) {
    return { kind: "staff", name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || "Staff" };
  }
  const registration = await db.registration.findFirst({
    where: { eventId, userId, status: { not: "CANCELLED" } },
    // Oldest first, so someone holding two registrations always votes and asks
    // as the same one.
    orderBy: { createdAt: "asc" },
    select: { id: true, attendee: { select: { firstName: true, lastName: true } } },
  });
  if (!registration?.attendee) return null;
  return {
    kind: "attendee",
    name: `${registration.attendee.firstName} ${registration.attendee.lastName}`.trim() || "Attendee",
    registrationId: registration.id,
  };
}

/**
 * The event, if this session takes viewer questions: only the anchor session
 * of a WEBINAR event, the one session whose questions the producers' console
 * lists (code review, Oct 1, 2026: questions accepted elsewhere reached
 * nobody).
 */
export async function loadQuestionContext(
  req: Request,
  slug: string,
  sessionId: string,
  /** Handouts stay downloadable after the event is marked COMPLETED. */
  opts: { includeCompleted?: boolean } = {},
): Promise<{ id: string; organizationId: string; webinar: WebinarSettings | null } | null> {
  const statuses: ("DRAFT" | "PUBLISHED" | "LIVE" | "COMPLETED")[] = ["DRAFT", "PUBLISHED", "LIVE"];
  if (opts.includeCompleted) statuses.push("COMPLETED");
  const event = await db.event.findFirst({
    where: await publicEventWhere(req, slug, { statuses }),
    select: { id: true, organizationId: true, eventType: true, settings: true },
  });
  if (!event) return null;
  const webinar = readWebinarSettings(event.settings);
  if (event.eventType !== "WEBINAR" || webinar?.sessionId !== sessionId) {
    apiLogger.warn({ slug, sessionId, eventType: event.eventType }, "webinar-question:not-the-webinar-room");
    return null;
  }
  return { id: event.id, organizationId: event.organizationId, webinar };
}
