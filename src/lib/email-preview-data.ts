/**
 * Real-data enrichment for email previews / test sends.
 *
 * `buildEventPreviewVariables` (src/lib/email.ts) is a sync, pure builder —
 * it maps the event row the preview routes already fetched plus static
 * samples. This module is the ASYNC layer on top: it pulls the event data
 * that lives behind extra queries (sessions + Zoom, abstracts, a
 * representative speaker's presentation context) so previews render ACTUAL
 * event data wherever a real source exists (owner request, July 17 2026).
 *
 * What deliberately STAYS a representative sample, because no honest real
 * value exists for a generic preview:
 *   - per-recipient minted links (surveyLink, rsvpLink, agreementLink,
 *     agreementBlock — minting real tokens for a preview would rotate or
 *     leak live credentials);
 *   - payment artifacts (amount, paymentReference, receiptBlock — they
 *     belong to one specific Stripe payment);
 *   - certificate serials (not issued yet at preview time);
 *   - entryBarcode (the real one is a cid-attached PNG; previews can't
 *     carry inline attachments);
 *   - per-abstract decision fields (reviewNotes, reviewScore, newStatus).
 *
 * Returned keys are spread into `buildEventPreviewVariables`'s `extra`
 * (before caller-typed subject/message, which must win last). Keys are only
 * present when real data exists — otherwise the samples stand.
 */
import { db } from "./db";
import { apiLogger } from "./logger";
import { resolveTimezone, formatDateInTz, formatTimeInTz, tzLabel } from "./event-time";
import { buildSpeakerEmailContext } from "./speaker-agreement";

export async function buildRealPreviewOverrides(
  eventId: string,
): Promise<Partial<Record<string, string | number>>> {
  try {
    const [event, speakerWithSessions, moderatorSpeaker] = await Promise.all([
      db.event.findUnique({
        where: { id: eventId },
        select: {
          slug: true,
          timezone: true,
          eventSessions: {
            orderBy: { startTime: "asc" },
            take: 1,
            select: {
              id: true,
              name: true,
              startTime: true,
              location: true,
              zoomMeeting: {
                select: { passcode: true, recordingStatus: true, recordingUrl: true },
              },
            },
          },
          abstracts: {
            orderBy: { createdAt: "desc" },
            take: 3,
            select: { title: true },
          },
          _count: { select: { abstracts: true } },
        },
      }),
      db.speaker.findFirst({
        where: { eventId, sessions: { some: {} } },
        select: { id: true },
      }),
      db.speaker.findFirst({
        where: { eventId, sessions: { some: { role: "MODERATOR" } } },
        select: { id: true },
      }),
    ]);
    if (!event) return {};

    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";

    const overrides: Partial<Record<string, string | number>> = {
      loginLink: `${appUrl}/e/${event.slug}/login`,
      // Same static URL the real reviewer notifies build (abstract-reviewer-notify.ts).
      reviewLink: `${appUrl}/login?callbackUrl=${encodeURIComponent("/my-reviews")}`,
    };

    const session = event.eventSessions[0];
    if (session) {
      const tz = resolveTimezone(event.timezone);
      const start = new Date(session.startTime);
      overrides.sessionName = session.name;
      overrides.sessionStart = `${formatDateInTz(start, tz)}, ${formatTimeInTz(start, tz)} ${tzLabel(start, tz)}`;
      overrides.sessionDetails = [session.name, session.location].filter(Boolean).join(" - ");
      // The real attendee join path — OUR gated session page, never the raw
      // Zoom link (same construction as bulk-email's webinar enrichment).
      overrides.joinUrl = `${appUrl}/e/${event.slug}/session/${session.id}`;
      overrides.webinarDate = start.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: tz,
      });
      overrides.webinarTime = `${formatTimeInTz(start, tz)} ${tzLabel(start, tz)}`;

      // Zoom-backed blocks reflect the REAL state only when a Zoom meeting is
      // attached; otherwise the generic samples stand (previewing a webinar
      // template on a session with no Zoom would otherwise show nothing).
      if (session.zoomMeeting) {
        const passcode = session.zoomMeeting.passcode ?? "";
        // Same markup as bulk-email's webinar enrichment; "" when no passcode,
        // exactly like the real send.
        overrides.passcodeBlock = passcode
          ? `<div style="text-align:center; margin:12px 0; color:#374151; font-size:14px;">Passcode: <strong style="font-family:monospace;">${passcode}</strong></div>`
          : "";
        const recordingUrl =
          session.zoomMeeting.recordingStatus === "AVAILABLE" && session.zoomMeeting.recordingUrl
            ? session.zoomMeeting.recordingUrl
            : "";
        overrides.recordingBlock = recordingUrl
          ? `<div style="text-align:center; margin:20px 0;"><a href="${recordingUrl}" style="display:inline-block; background:#00aade; color:#ffffff; padding:12px 28px; border-radius:6px; text-decoration:none; font-weight:600;">Watch Replay</a></div>`
          : `<p style="color:#6b7280;">The recording will be available shortly. We'll send it to you as soon as it's ready.</p>`;
      }
    }

    if (event.abstracts.length) {
      overrides.abstractTitle = event.abstracts[0].title;
      // Same joiner the presenter agreement uses (presenter-agreement.ts).
      overrides.abstractTitles = event.abstracts.map((a) => a.title).join("; ");
    }
    if (event._count.abstracts > 0) overrides.abstractCount = event._count.abstracts;

    // A representative speaker's REAL presentation block (sessions / topics /
    // time windows) and a representative MODERATOR's real run-sheet. Real
    // sends render each recipient's own — the preview shows the first
    // matching speaker's as actual-data representative. One context call
    // when the same person fills both roles.
    if (speakerWithSessions) {
      const ctx = await buildSpeakerEmailContext(eventId, speakerWithSessions.id);
      if (ctx?.presentationDetails) {
        overrides.presentationDetails = ctx.presentationDetails;
        overrides.presentationDetailsText = ctx.presentationDetailsText;
      }
      if (moderatorSpeaker?.id === speakerWithSessions.id && ctx?.moderatorDetails) {
        overrides.moderatorDetails = ctx.moderatorDetails;
        overrides.moderatorDetailsText = ctx.moderatorDetailsText;
      }
    }
    if (moderatorSpeaker && moderatorSpeaker.id !== speakerWithSessions?.id) {
      const modCtx = await buildSpeakerEmailContext(eventId, moderatorSpeaker.id);
      if (modCtx?.moderatorDetails) {
        overrides.moderatorDetails = modCtx.moderatorDetails;
        overrides.moderatorDetailsText = modCtx.moderatorDetailsText;
      }
    }

    return overrides;
  } catch (err) {
    // A preview must never fail because enrichment did — samples still render.
    apiLogger.warn({ err, eventId, msg: "email-preview:real-overrides-failed" });
    return {};
  }
}
