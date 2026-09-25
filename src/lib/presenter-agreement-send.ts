/**
 * The presenter agreement in any email (September 25, 2026): what a send
 * carrying {{presenterAgreementAttachment}} / {{presenterAgreementLink}} adds
 * for one author. Its own module (not presenter-agreement.ts) so the bulk
 * pipeline, the single-speaker send and the tests all go through one seam.
 */
import { apiLogger } from "@/lib/logger";
import {
  PRESENTER_AGREEMENT_PDF_MIME,
  generatePresenterAgreementPdf,
  mintPresenterAgreementLink,
  templateUsesPresenterAgreementAttachment,
  templateUsesPresenterAgreementLink,
} from "@/lib/presenter-agreement";
/**
 * What a send carrying the presenter tokens adds for ONE author: the two
 * token values and, when asked for, the personalised PDF. ONE implementation
 * for the bulk pipeline (speakers and abstract-author audiences) and a
 * speaker's single Send Email, so the two cannot drift.
 *
 * - Nothing is minted or generated unless a template part uses the token.
 * - An author who has already accepted gets an empty link and no file (owner
 *   decision, September 25, 2026), the same rule as {{agreementAttachment}}.
 * - The link is minted additively (`rotate: false`); a mint failure throws,
 *   so the caller's per-recipient error handling fails that one recipient
 *   rather than sending a dead link.
 * - The PDF is best-effort: a generation failure is logged and the email goes
 *   without it, since the link still works.
 */
export async function resolvePresenterAgreementForSend(args: {
  eventId: string;
  eventSlug: string;
  speakerId: string;
  acceptedAt: Date | null | undefined;
  /** Every text the send renders (template parts, typed subject and message). */
  texts: Array<string | null | undefined>;
}): Promise<{
  vars: { presenterAgreementAttachment: string; presenterAgreementLink: string };
  attachment: { name: string; content: string; contentType: string } | null;
}> {
  const vars = { presenterAgreementAttachment: "", presenterAgreementLink: "" };
  const wantsLink = templateUsesPresenterAgreementLink(...args.texts);
  const wantsFile = templateUsesPresenterAgreementAttachment(...args.texts);
  if ((!wantsLink && !wantsFile) || args.acceptedAt) return { vars, attachment: null };

  if (wantsLink) {
    vars.presenterAgreementLink = await mintPresenterAgreementLink(args.speakerId, args.eventSlug, { rotate: false });
  }
  if (!wantsFile) return { vars, attachment: null };
  try {
    const doc = await generatePresenterAgreementPdf({ eventId: args.eventId, speakerId: args.speakerId });
    if (!doc) throw new Error("Failed to generate presenter agreement PDF");
    return { vars, attachment: { name: doc.filename, content: doc.buffer.toString("base64"), contentType: PRESENTER_AGREEMENT_PDF_MIME } };
  } catch (err) {
    apiLogger.error({ err, msg: "presenter-agreement:send-attach-failed", eventId: args.eventId, speakerId: args.speakerId });
    return { vars, attachment: null };
  }
}
