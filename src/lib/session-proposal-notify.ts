import { db } from "./db";
import { apiLogger } from "./logger";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom, brandingCc } from "./email";
import { getTitleLabel, formatPersonName } from "./utils";
import { formatSessionProposalSerial } from "./session-proposal-serial";
import { notifyEventAdmins } from "./notifications";

/**
 * Side-effect fan-out for a session-proposal SUBMISSION (create-as-submitted
 * or a DRAFT→SUBMITTED resubmit) — ONE implementation shared by the POST and
 * PUT routes so the two paths can't drift (the services-rule smell is a
 * "must mirror" comment; this is the mirror).
 *
 * Contract: NEVER throws and is fire-and-forget at the call site — a mail or
 * notification blip must not fail a committed proposal write. Only fires for
 * real submissions; DRAFT saves are silent (the abstracts June-26 rule).
 */
export function notifySessionProposalSubmitted(args: {
  eventId: string;
  organizationId: string | null;
  triggeredByUserId: string;
  isResubmission: boolean;
  proposal: {
    id: string;
    serialId?: number | null;
    title: string;
    /**
     * The email reports Proposal # / Title / Duration only. Format was removed
     * from every submitter surface on Aug 4, 2026 (form, list, sheet, CSV) but
     * the email kept rendering it, so it printed a value nobody could set; the
     * theme row was dropped with it as organizer noise. The DB columns stay.
     */
    durationMinutes: number | null;
    speaker: {
      id: string;
      title: string | null;
      firstName: string;
      lastName: string;
      email: string;
      additionalEmail: string | null;
    };
  };
}): void {
  const { eventId, proposal } = args;
  const speaker = proposal.speaker;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";

  db.event
    .findUnique({ where: { id: eventId }, select: { name: true, slug: true } })
    .then(async (ev) => {
      const tpl =
        (await getEventTemplate(eventId, "session-proposal-confirmation")) ||
        getDefaultTemplate("session-proposal-confirmation");
      if (!tpl) {
        apiLogger.warn({ msg: "session-proposal:no-confirmation-template", eventId });
        return;
      }
      const branding = "branding" in tpl ? tpl.branding : { eventName: ev?.name ?? "" };
      const vars = {
        title: getTitleLabel(speaker.title),
        firstName: speaker.firstName,
        lastName: speaker.lastName,
        eventName: ev?.name ?? "",
        proposalNumber: proposal.serialId != null ? formatSessionProposalSerial(proposal.serialId) : "",
        proposalTitle: proposal.title,
        // Blank, not "—", when unset: the dashboard renders an em-dash
        // placeholder in a table cell, but an email row reading "Duration: —"
        // is noise where an empty value simply reads as "not stated".
        proposalDuration:
          proposal.durationMinutes != null ? `${proposal.durationMinutes} minutes` : "",
        // Legacy keys, deliberately still emitted as empty strings. Migration
        // 20260810130000 rewrites saved templates that match the seeded markup,
        // but leaves a genuinely customized one alone. renderTemplate prints an
        // unknown key as LITERAL text, so without these a customized template
        // would email a proposer the string "{{proposalTheme}}". Blank rows are
        // the graceful degradation. Drop once no template references them.
        proposalTheme: "",
        proposalFormat: "",
        // The BRANDED event login that lands on the proposer's "My Session
        // Proposals" — NOT the internal /login (organizer-reported Aug 6, 2026:
        // "View Your Proposal" dumped submitters on the dashboard login page).
        managementLink: ev?.slug
          ? `${appUrl}/e/${ev.slug}/login?redirect=session-proposals`
          : `${appUrl}/login`,
      };
      const rendered = renderAndWrap(tpl, vars, branding);
      return sendEmail({
        to: [{ email: speaker.email, name: `${speaker.firstName} ${speaker.lastName}` }],
        cc: brandingCc(branding, [{ email: speaker.email }], [speaker.additionalEmail]),
        ...rendered,
        from: brandingFrom(branding),
        emailType: "session_proposal_confirmation",
        stream: "transactional",
        logContext: {
          organizationId: args.organizationId,
          eventId,
          entityType: "SPEAKER",
          entityId: speaker.id,
          templateSlug: "session-proposal-confirmation",
          triggeredByUserId: args.triggeredByUserId,
        },
      });
    })
    .catch((err) => apiLogger.error({ err, msg: "session-proposal:confirmation-email-failed", proposalId: proposal.id }));

  notifyEventAdmins(eventId, {
    type: "ABSTRACT",
    title: args.isResubmission ? "Session Proposal Resubmitted" : "New Session Proposal",
    message: `"${proposal.title}" proposed by ${formatPersonName(speaker.title, speaker.firstName, speaker.lastName)}`,
    link: `/events/${eventId}/session-proposals`,
  }).catch((err) => apiLogger.error({ err, msg: "session-proposal:admin-notify-failed", proposalId: proposal.id }));
}
