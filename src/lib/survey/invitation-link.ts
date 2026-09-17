/**
 * Every Survey Invitation carries the recipient's PERSONAL survey link.
 *
 * WHY THIS EXISTS (Sep 17, 2026). An organizer edited an event's saved
 * survey-invitation template and replaced the button's `{{surveyLink}}` with
 * the event's shareable link (`/e/{slug}/survey?share=…`), pasted by hand. The
 * send still minted a personal token per recipient, but the email carried the
 * shared URL, so no one received a personal link. The shareable link has since
 * been retired, which turns any copy of it into a dead URL.
 *
 * A saved template is the organizer's own copy (the default is only a seed),
 * so fixing the default reaches nobody who already edited theirs. The repair
 * therefore runs on the template at send and preview time:
 *
 *   1. Any shareable survey URL in the body, whatever its host or slug,
 *      becomes `{{surveyLink}}`, so a pasted link becomes the personal one in
 *      the place the organizer put it.
 *   2. If the HTML still has no `{{surveyLink}}`, a "Take the survey" button is
 *      appended; if the plain-text part has none, a line is appended.
 *
 * The stored template is never rewritten. Pure and client-safe.
 */

/** A shareable-survey URL with or without an origin, in HTML or plain text. */
const SHARE_SURVEY_URL_RE =
  /(?:https?:\/\/[^\s"'<>]+)?\/e\/[^\s"'<>/?#]+\/survey\?share=[^\s"'<>]*/g;

const SURVEY_LINK_TOKEN = "{{surveyLink}}";

const PERSONAL_BUTTON_HTML = `<p style="text-align: center; margin: 24px 0;">
  <a href="{{surveyLink}}" style="display: inline-block; background: #00aade; color: #ffffff; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: 600;">Take the survey</a>
</p>`;

export interface SurveyTemplateParts {
  htmlContent: string;
  /** Null on a stored row with no plain-text part. */
  textContent: string | null;
}

export interface SurveyLinkRepair {
  /** Shareable URLs replaced by the personal link, across HTML and text. */
  replacedShareLinks: number;
  appendedHtmlButton: boolean;
  appendedTextLink: boolean;
}

export function ensurePersonalSurveyLink<T extends SurveyTemplateParts>(
  template: T,
): { template: T; repair: SurveyLinkRepair } {
  let replacedShareLinks = 0;
  const swap = (content: string) =>
    content.replace(SHARE_SURVEY_URL_RE, () => {
      replacedShareLinks += 1;
      return SURVEY_LINK_TOKEN;
    });

  let htmlContent = swap(template.htmlContent ?? "");
  let textContent = swap(template.textContent ?? "");

  const appendedHtmlButton = !htmlContent.includes(SURVEY_LINK_TOKEN);
  if (appendedHtmlButton) htmlContent = `${htmlContent}\n${PERSONAL_BUTTON_HTML}`;

  const appendedTextLink = !textContent.includes(SURVEY_LINK_TOKEN);
  if (appendedTextLink) textContent = `${textContent}\n\nTake the survey: ${SURVEY_LINK_TOKEN}`;

  return {
    // Spread keeps every other field (subject, slug, branding…) of the caller's type.
    template: { ...template, htmlContent, textContent } as T,
    repair: { replacedShareLinks, appendedHtmlButton, appendedTextLink },
  };
}

/** True when the repair changed anything worth telling the organizer about. */
export function surveyLinkWasRepaired(repair: SurveyLinkRepair): boolean {
  return repair.replacedShareLinks > 0 || repair.appendedHtmlButton || repair.appendedTextLink;
}
