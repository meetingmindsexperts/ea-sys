/**
 * Where a webinar's video comes from, and the rule that keeps a session to ONE
 * source (Nov 12, 2026; external streams step 4,
 * docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md §4.1).
 *
 *   zoom       our own Zoom webinar (the default, and every webinar before this)
 *   external   a partner pushes video to us from their own platform. No Zoom
 *              webinar of ours exists: no host link, no panelists, no licence.
 *
 * The source is `Event.settings.webinar.source`, chosen when the webinar is
 * created. It has to be known THEN: the provisioner makes the Zoom webinar
 * within seconds of the event, so a choice offered afterwards comes too late.
 *
 * A session streams from our Zoom OR from a partner, never both. A reader that
 * found both would have to guess which one attendees are watching, and a Zoom
 * webinar beside a partner's stream is a host link nobody should press. Two
 * halves enforce it:
 *
 *   zoomMeetingRefusal     asked BEFORE Zoom is called, by every door that
 *                          creates a Zoom meeting on an existing session (the
 *                          session's Zoom form, "Run provisioner", the agent).
 *   createZoomMeetingRow   the row write itself, and issueExternalStream's,
 *                          take one per-session lock and look again, so a key
 *                          issued and a Zoom meeting created in the same
 *                          instant cannot both land (review of 15f219c0: a
 *                          check on one side only, with no lock, could).
 */
import type { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { readWebinarSettings } from "@/lib/webinar";

export type WebinarVideoSource = "zoom" | "external";

export const WEBINAR_VIDEO_SOURCES: readonly WebinarVideoSource[] = ["zoom", "external"];

/** The webinar's source. Anything but an explicit "external" is our Zoom, as before the choice existed. */
export function webinarVideoSource(eventSettings: unknown): WebinarVideoSource {
  return readWebinarSettings(eventSettings)?.source === "external" ? "external" : "zoom";
}

export type ZoomMeetingRefusalCode = "EXTERNAL_VIDEO_SOURCE" | "PARTNER_STREAM_EXISTS";

export interface ZoomMeetingRefusal {
  code: ZoomMeetingRefusalCode;
  message: string;
}

export const ZOOM_REFUSAL_MESSAGE: Record<ZoomMeetingRefusalCode, string> = {
  EXTERNAL_VIDEO_SOURCE:
    "This webinar's video comes from a partner's own platform, so it has no Zoom webinar of ours. Hand the partner the stream key from the Webinar Console instead.",
  PARTNER_STREAM_EXISTS:
    "This session already has a partner's stream key. A session streams from our Zoom or from a partner, not both: remove the partner stream first.",
};

function refusal(code: ZoomMeetingRefusalCode): ZoomMeetingRefusal {
  return { code, message: ZOOM_REFUSAL_MESSAGE[code] };
}

/**
 * Why this session may not be given a Zoom meeting of ours, or null when it
 * may. Ask it before calling Zoom: a refusal here costs nothing, one after
 * Zoom has created the meeting means tearing a billable room down again.
 *
 * External source covers the webinar's own (anchor) session, and every session
 * while no anchor exists yet. Another session of a webinar event is refused
 * elsewhere (one room per webinar, webinarSecondRoomViolation).
 */
export async function zoomMeetingRefusal(args: {
  eventId: string;
  sessionId: string;
  eventType: string | null | undefined;
  eventSettings: unknown;
}): Promise<ZoomMeetingRefusal | null> {
  const anchorId = readWebinarSettings(args.eventSettings)?.sessionId;
  const isAnchor = !anchorId || anchorId === args.sessionId;
  if (args.eventType === "WEBINAR" && webinarVideoSource(args.eventSettings) === "external" && isAnchor) {
    return refusal("EXTERNAL_VIDEO_SOURCE");
  }
  const partner = await db.externalStream.findFirst({
    where: { sessionId: args.sessionId, eventId: args.eventId },
    select: { id: true },
  });
  return partner ? refusal("PARTNER_STREAM_EXISTS") : null;
}

/** Thrown by createZoomMeetingRow when a partner's stream key landed on the session first. */
export class PartnerStreamExistsError extends Error {
  readonly code = "PARTNER_STREAM_EXISTS" as const;
  constructor() {
    super(ZOOM_REFUSAL_MESSAGE.PARTNER_STREAM_EXISTS);
    this.name = "PartnerStreamExistsError";
  }
}

export function isPartnerStreamExistsError(err: unknown): err is PartnerStreamExistsError {
  return err instanceof PartnerStreamExistsError;
}

/** Thrown by issueExternalStream's locked write when a Zoom meeting landed on the session first. */
export class ZoomMeetingExistsError extends Error {
  constructor() {
    super("This session has a Zoom webinar.");
    this.name = "ZoomMeetingExistsError";
  }
}

/**
 * The per-session lock both writers take, first thing in their transaction.
 * Transaction-scoped (released at commit or rollback), safe behind the pooler:
 * the pattern of lockCertificateAssignments.
 */
export async function lockSessionVideoSource(tx: Prisma.TransactionClient, sessionId: string): Promise<void> {
  // ::text because pg_advisory_xact_lock returns void, which $queryRaw cannot read.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${sessionVideoSourceLockKey(sessionId)}))::text`;
}

export function sessionVideoSourceLockKey(sessionId: string): string {
  return `session-video-source:${sessionId}`;
}

/**
 * Write our Zoom meeting's row for a session that already existed, unless a
 * partner's stream key got there first. Zoom has ALREADY created the meeting
 * when this runs, so on PartnerStreamExistsError the caller tears the remote
 * meeting down, exactly as it does when it loses the sessionId-unique race.
 */
export async function createZoomMeetingRow<T extends Prisma.ZoomMeetingCreateArgs>(
  args: Prisma.SelectSubset<T, Prisma.ZoomMeetingCreateArgs>,
): Promise<Prisma.ZoomMeetingGetPayload<T>> {
  const sessionId = (args.data as { sessionId: string }).sessionId;
  return tenantTransaction(async (tx) => {
    await lockSessionVideoSource(tx, sessionId);
    const partner = await tx.externalStream.findFirst({ where: { sessionId }, select: { id: true } });
    if (partner) throw new PartnerStreamExistsError();
    return (await tx.zoomMeeting.create(args)) as Prisma.ZoomMeetingGetPayload<T>;
  });
}
