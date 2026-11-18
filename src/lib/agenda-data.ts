/**
 * The data behind the public agenda page, read ONE way for its two doors:
 *
 *   - `GET /api/public/events/[slug]/agenda`: anyone, once the organiser has
 *     published the agenda and the event is Published or Live;
 *   - `GET /api/events/[eventId]/agenda-preview`: staff who may see the
 *     programme, before it is published and on a draft event (Nov 17, 2026),
 *     so an organiser sees exactly what attendees will see without opening it
 *     to the public first.
 *
 * Both call `loadAgendaEvent` and `agendaPayload`, so the preview can never
 * show a different programme from the one publishing would reveal. Server
 * only: it reads the database, and the caller must already be inside the
 * event's tenant lane (`runWithTenant`), since EventSession is policied.
 */
import { db } from "@/lib/db";
import { readAgendaTrackBorder } from "@/lib/agenda-display";
import { describeSessionRole, type SessionRoleDef } from "@/lib/session-roles";

export { isAgendaPublished } from "@/lib/agenda-display";

/** Sessions an attendee may see; draft and cancelled ones stay out of the preview too. */
const VISIBLE_SESSION_STATUSES = ["SCHEDULED", "LIVE", "COMPLETED"] as const;

export function loadAgendaEvent(eventId: string) {
  return db.event.findFirst({
    where: { id: eventId },
    select: {
      id: true,
      organizationId: true,
      name: true,
      slug: true,
      status: true,
      startDate: true,
      endDate: true,
      timezone: true,
      supportEmail: true,
      bannerImage: true,
      bannerImageMobile: true,
      settings: true,
      organization: { select: { name: true, logo: true } },
      tracks: {
        select: { id: true, name: true, color: true },
        orderBy: { sortOrder: "asc" },
      },
      eventSessions: {
        where: { status: { in: [...VISIBLE_SESSION_STATUSES] } },
        select: {
          id: true,
          name: true,
          description: true,
          startTime: true,
          endTime: true,
          location: true,
          capacity: true,
          status: true,
          type: true,
          track: { select: { id: true, name: true, color: true } },
          speakers: {
            select: {
              role: true,
              customRoleKey: true,
              speaker: {
                select: {
                  id: true,
                  title: true,
                  firstName: true,
                  lastName: true,
                  jobTitle: true,
                  organization: true,
                  photo: true,
                },
              },
            },
          },
          topics: {
            select: {
              id: true,
              title: true,
              duration: true,
              sortOrder: true,
              presenterLabel: true,
              speakers: {
                select: {
                  speaker: {
                    select: { id: true, title: true, firstName: true, lastName: true },
                  },
                },
              },
            },
            orderBy: { sortOrder: "asc" },
          },
        },
        orderBy: { startTime: "asc" },
      },
    },
  });
}

export type AgendaEvent = NonNullable<Awaited<ReturnType<typeof loadAgendaEvent>>>;

/**
 * The JSON the agenda page reads. Never carries `settings` or `status` itself.
 * `roles` is the organisation's session-role list (getSessionRoles): each
 * assignment is sent with its role's key and name, since the public page
 * cannot read the list.
 */
export function agendaPayload(event: AgendaEvent, roles: readonly SessionRoleDef[]) {
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    startDate: event.startDate,
    endDate: event.endDate,
    timezone: event.timezone,
    supportEmail: event.supportEmail,
    bannerImage: event.bannerImage,
    bannerImageMobile: event.bannerImageMobile,
    organization: event.organization,
    tracks: event.tracks,
    trackBorder: readAgendaTrackBorder(event.settings),
    // `?? []`: a caller's event without its sessions sends none, as it did before.
    sessions: (event.eventSessions ?? []).map(({ speakers, ...session }) => ({
      ...session,
      speakers: speakers.map(({ customRoleKey, ...assignment }) => ({
        ...assignment,
        ...describeSessionRole({ role: assignment.role, customRoleKey }, roles),
      })),
    })),
  };
}
