import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  brandingFrom,
  getEventTemplate,
  getDefaultTemplate,
  renderAndWrap,
  sendEmail,
} from "@/lib/email";
import { readWebinarSettings } from "@/lib/webinar";

interface SendPanelistInviteParams {
  eventId: string;
  panelistName: string;
  panelistEmail: string;
  joinUrl: string;
  actorUserId?: string;
}

// Single source of truth so POST /panelists, sync-speakers, and the Resend
// endpoint all produce identical emails (branded wrapper, organizer signature,
// anchor session metadata).
export async function sendPanelistInvite(
  params: SendPanelistInviteParams,
): Promise<void> {
  const { eventId, panelistName, panelistEmail, joinUrl, actorUserId } = params;

  const [event, actor] = await Promise.all([
    db.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        timezone: true,
        settings: true,
      },
    }),
    actorUserId
      ? db.user.findUnique({
          where: { id: actorUserId },
          select: { emailSignature: true },
        })
      : Promise.resolve(null),
  ]);

  if (!event) {
    apiLogger.warn({ eventId, panelistEmail }, "webinar:panelist-invite-skipped:no-event");
    throw new Error("Event not found");
  }

  const webinar = readWebinarSettings(event.settings) ?? {};
  const anchorSession = webinar.sessionId
    ? await db.eventSession.findFirst({
        where: { id: webinar.sessionId, eventId },
        select: { name: true, startTime: true },
      })
    : null;

  const sessionStart = anchorSession
    ? new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: event.timezone || "UTC",
        timeZoneName: "short",
      }).format(anchorSession.startTime)
    : "TBA";

  const tpl =
    (await getEventTemplate(eventId, "webinar-panelist-invitation")) ||
    getDefaultTemplate("webinar-panelist-invitation");
  if (!tpl) {
    apiLogger.error(
      { eventId, panelistEmail },
      "webinar:panelist-invite-skipped:no-template",
    );
    throw new Error("Email template not found");
  }

  const branding =
    "branding" in tpl ? tpl.branding : { eventName: event.name };

  const rendered = renderAndWrap(
    tpl,
    {
      panelistName,
      eventName: event.name,
      sessionName: anchorSession?.name ?? event.name,
      sessionStart,
      joinUrl,
      organizerSignature: actor?.emailSignature ?? "",
    },
    branding,
    new Set(["organizerSignature"]),
  );

  try {
    await sendEmail({
      to: [{ email: panelistEmail, name: panelistName }],
      ...rendered,
      from: brandingFrom(branding),
    });
    apiLogger.info(
      { eventId, panelistEmail },
      "webinar:panelist-invite-sent",
    );
  } catch (err) {
    apiLogger.warn(
      { err, eventId, panelistEmail },
      "webinar:panelist-invite-failed",
    );
    throw err;
  }
}
